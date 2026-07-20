import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as perps from '../services/venue.js';
import { getAllTokens } from '../db/firebase.js';
import { retry, sleep } from '../utils/helpers.js';
import { shouldEnterNow, shouldExitNow, getSession } from '../services/market-signal.js';
import { resolveStrategy, favorableExtreme, pullbackFrom } from '../services/strategies.js';
import { getEthPrice } from '../services/uniswap.js';
import * as notifier from '../services/notifier.js';

const RTH_SESSIONS = ['market-open', 'power-hour', 'regular-hours'];

/**
 * Open a position without double-fire risk. A plain retry() around
 * openPosition can open TWICE when the first transaction lands but the RPC
 * response times out — with real money that's the worst failure mode, so on
 * error we check on-chain before any second attempt.
 */
async function openPositionSafely(market, sizeUsd, collateralUsd, direction) {
  try {
    return await perps.openPosition(market, sizeUsd, collateralUsd, direction);
  } catch (err) {
    logger.warn('openPosition threw — checking on-chain before any retry', { market, error: err.message });
    await sleep(8000);
    try {
      const live = await perps.getPositionPnl(market);
      if (live.exists) {
        logger.info('Position exists on-chain despite the error — treating as success', { market });
        return { txSig: 'confirmed-on-chain', success: true };
      }
    } catch {}
    // Definitely not open — one clean retry
    return await perps.openPosition(market, sizeUsd, collateralUsd, direction);
  }
}

// Never run more than this many markets at once — keeps the cross-margin
// account from concentrating all collateral in correlated names
const MAX_CONCURRENT_MARKETS = parseInt(process.env.MAX_CONCURRENT_MARKETS, 10) || 3;

// ---------------------------------------------------------------------------
// High-Leverage Stock Scalping Strategy (Ostium, max 50x)
//
// Based on professional high-leverage trading patterns:
// 1. Open ONE position per stock market at the signal's leverage
// 2. Use a 3-stage exit system:
//    Stage 1: Move SL to breakeven once +0.5% profit hit
//    Stage 2: DCA take-profits at +0.5% and +1%
//    Stage 3: Trail remaining size with a 0.5% callback from highs
// 3. Hard stop loss at -40% of collateral (before liquidation)
// 4. Never add to a losing position
// 5. After close, wait for next fee cycle before re-entering
//
// Stocks move ~5-10x less than crypto intraday, so the price-move
// thresholds are tighter than the old crypto strategy while the
// collateral-based stops stay the same.
// ---------------------------------------------------------------------------

// SMART DEGEN v4 -- stocks edition
const STRATEGY = {
  // Hard stop loss at -40% collateral
  stopLossCollateralPct: -0.40,

  // Move SL to breakeven after +0.5% price move
  breakevenPct: 0.005,

  // DCA Take Profit stages:
  // Stage 1: close 25% at +0.5% price move
  // Stage 2: close 25% at +1% price move
  // Stage 3: trail remaining 50% with 0.5% callback from highs
  tp1Pct: 0.005,                  // 0.5% = first take profit
  tp1ReducePct: 0.25,             // close 25%
  tp2Pct: 0.01,                   // 1% = second take profit
  tp2ReducePct: 0.33,             // close 33% of remaining (= 25% of original)
  trailingCallbackPct: 0.005,     // 0.5% trailing stop on final 50%

  // Minimum profit to bother taking
  minProfitUsd: 1,

  // Cooldown after a loss
  cooldownMs: 30_000,

  // Per-token daily loss limit in USD (negative). Off by default; set
  // DAILY_LOSS_LIMIT_USD (e.g. -250) to stop opening after a bad day.
  dailyLossLimitUsd: parseFloat(process.env.DAILY_LOSS_LIMIT_USD) || -999999,
};

// ---------------------------------------------------------------------------
// Learning System
//
// Tracks recent trade outcomes. If the bot keeps losing, it becomes
// pickier about entries (requires higher signal score).
// If it's winning, it stays aggressive.
// ---------------------------------------------------------------------------

const TRADE_HISTORY_KEY = 'trade-history';

async function getTradeHistory() {
  try {
    const doc = await db.getDoc('config', TRADE_HISTORY_KEY);
    return {
      recentTrades: doc?.recentTrades || [],   // last 20 trades: [{win: bool, pnl, leverage, timestamp}]
      totalWins: doc?.totalWins || 0,
      totalLosses: doc?.totalLosses || 0,
      totalPnlUsd: doc?.totalPnlUsd || 0,      // lifetime realized PnL (drives the stats page)
    };
  } catch {
    return { recentTrades: [], totalWins: 0, totalLosses: 0, totalPnlUsd: 0 };
  }
}

/**
 * Record a realized trade outcome.
 * - feeds the learning system (entry thresholds)
 * - accumulates lifetime realized PnL for honest stats
 * - on wins, allocates the profit to buybacks (70% source token / 30%
 *   FILL) — the promise the whole protocol is built on
 */
async function recordTrade(win, pnl, leverage, tokenAddress = null) {
  const history = await getTradeHistory();
  const trade = { win, pnl: Math.round(pnl * 100) / 100, leverage, timestamp: Date.now() };
  const recent = [...history.recentTrades, trade].slice(-20); // keep last 20
  await db.setDoc('config', TRADE_HISTORY_KEY, {
    recentTrades: recent,
    totalWins: history.totalWins + (win ? 1 : 0),
    totalLosses: history.totalLosses + (win ? 0 : 1),
    totalPnlUsd: Math.round((history.totalPnlUsd + pnl) * 100) / 100,
    lastUpdated: Date.now(),
  });

  if (win && pnl > 0 && tokenAddress) {
    try {
      await db.addSplit({
        tokenAddress,
        profitUsd: Math.round(pnl * 100) / 100,
        profitSourceUsd: Math.round(pnl * config.PROFIT_SPLIT.sourceToken * 100) / 100,
        profitFillUsd: Math.round(pnl * config.PROFIT_SPLIT.fill * 100) / 100,
        timestamp: Date.now(),
      });
      logger.info('Profit allocated to buybacks', {
        token: tokenAddress, profitUsd: pnl.toFixed(2),
        source: (pnl * config.PROFIT_SPLIT.sourceToken).toFixed(2),
        fill: (pnl * config.PROFIT_SPLIT.fill).toFixed(2),
      });
    } catch (splitErr) {
      logger.error('Failed to record profit split', { token: tokenAddress, error: splitErr.message });
    }
  }
}

/**
 * Get the minimum signal score required to enter based on recent performance.
 * If we're on a losing streak, require a higher score (be pickier).
 * If we're winning, stay aggressive.
 */
async function getEntryThreshold() {
  const history = await getTradeHistory();
  const recent = history.recentTrades.slice(-10); // last 10 trades
  if (recent.length < 3) return 20; // not enough data, use default

  const wins = recent.filter(t => t.win).length;
  const winRate = wins / recent.length;

  // Losing streak: last 3 trades all losses = require higher score
  const last3 = recent.slice(-3);
  const onLosingStreak = last3.every(t => !t.win);

  if (onLosingStreak) {
    logger.info('LEARNING: losing streak detected, raising entry threshold', {
      winRate: (winRate * 100).toFixed(0) + '%', last3: 'all losses',
    });
    return 45; // need strong signal after losing streak
  }

  if (winRate < 0.3) return 40;    // poor win rate, be careful
  if (winRate < 0.5) return 30;    // below average
  return 20;                        // winning, stay aggressive
}

/**
 * Get or create the strategy state for a position.
 * Tracks breakeven/TP stages and trailing stop high-water mark.
 */
async function getStrategyState(tokenAddress) {
  const pos = await db.getPosition(tokenAddress);
  return {
    stage: pos?.strategyStage || 'watching',  // watching | breakeven | tp1 | tp2 | trailing
    highWaterPnl: pos?.highWaterPnl || 0,
    highWaterPrice: pos?.highWaterPrice || 0,
    tp1Hit: pos?.tp1Hit || false,
    tp2Hit: pos?.tp2Hit || false,
    lastCloseAt: pos?.lastCloseAt || 0,
    dailyLoss: pos?.dailyLoss || 0,
    dailyLossDate: pos?.dailyLossDate || new Date().toDateString(),
  };
}

/**
 * Main position management for a single token.
 */
export async function managePositionForToken(tokenAddress) {
  try {
    const token = await db.getToken(tokenAddress);
    if (!token || token.status !== 'active') return null;

    const underlying = token.underlying?.toUpperCase();
    const market = underlying && config.STOCK_MARKETS.includes(underlying)
      ? underlying : null;
    if (!market) return null;

    const mode = resolveStrategy(token.strategy);

    // Check live position on Ostium
    const pnlInfo = await retry(
      () => perps.getPositionPnl(market),
      { retries: 2, delayMs: 2000, label: `getPositionPnl(${market})` }
    );

    // Existing positions follow the LIVE side; new entries follow the token config
    const direction = pnlInfo.exists ? pnlInfo.side : (token.side || 'long');

    // -------------------------------------------------------------------
    // CASE 1: Position exists -> run the strategy engine
    // -------------------------------------------------------------------
    if (pnlInfo.exists) {
      let position = await db.getPosition(tokenAddress);
      let deployedAmount = position?.deployedUsd || 0;

      if (deployedAmount <= 0) {
        // Orphan live position (DB reset or opened externally). NEVER leave
        // real money unmanaged — adopt it so stop-loss/TP apply.
        deployedAmount = pnlInfo.collateralUsd || 0;
        if (deployedAmount <= 0) return null;
        position = {
          ...(position || {}),
          tokenAddress,
          market,
          side: pnlInfo.side,
          leverage: pnlInfo.leverage || token.leverage,
          deployedUsd: deployedAmount,
          sizeUsd: pnlInfo.size,
          strategyStage: 'watching',
          lastAction: 'adopted-live-position',
          lastActionAt: Date.now(),
        };
        await db.setPosition(tokenAddress, position);
        logger.warn('Adopted untracked live position — now risk-managed', {
          token: tokenAddress, market, collateralUsd: deployedAmount.toFixed(2), side: pnlInfo.side,
        });
      }

      const state = await getStrategyState(tokenAddress);
      const pnl = pnlInfo.pnl || 0;
      const currentPrice = pnlInfo.currentPrice || 0;
      const entryPrice = pnlInfo.entry || position?.entry || 0;

      // Calculate price change percentage from entry
      const priceChangePct = entryPrice > 0 ? (currentPrice - entryPrice) / entryPrice : 0;
      // For shorts, invert the sign
      const effectivePct = direction === 'short' ? -priceChangePct : priceChangePct;

      // Calculate collateral-based PnL percentage (deployedUsd is USDC)
      const collateralUsd = pnlInfo.collateralUsd || deployedAmount;
      const pnlPct = collateralUsd > 0 ? pnl / collateralUsd : 0;

      // Update DB with latest PnL
      const updateData = {
        ...position,
        tokenAddress,
        pnl,
        entry: entryPrice,
        currentPrice,
        priceChangePct: effectivePct,
        updatedAt: Date.now(),
      };

      // ---- SIGNAL-BASED EXIT ----
      // If momentum has flipped against us, exit early before SL
      try {
        const { shouldExit, reason } = await shouldExitNow(direction, market);
        if (shouldExit && pnlPct < -0.10) {
          // Only signal-exit if we're already losing (>10% down)
          // Don't exit a winning position just because signal flipped
          logger.info('SIGNAL EXIT -- momentum reversed while losing', {
            token: tokenAddress, market, reason, pnl: pnl.toFixed(2),
            pnlPct: (pnlPct * 100).toFixed(1) + '%',
          });

          try {
            const closeResult = await retry(
              () => perps.closePosition(market),
              { retries: 2, delayMs: 2000, label: `signalExit(${market})` }
            );
          await db.setPosition(tokenAddress, {
            ...updateData, deployedUsd: 0,
            lastAction: 'signal-exit-' + reason,
            lastActionAt: Date.now(), lastCloseAt: Date.now(),
            pnl: 0, strategyStage: 'watching',
            highWaterPnl: 0, highWaterPrice: 0, tp1Hit: false, tp2Hit: false,
          });
          await recordTrade(false, pnl, position?.leverage || 25, tokenAddress);
            notifier.notifyPositionClosed({ market, reason: 'signal exit (' + reason + ')', pnl });
            return { action: 'signal-exit', reason, pnl, txSig: closeResult?.txSig };
          } catch (err) {
            logger.error('Signal exit failed', { token: tokenAddress, error: err.message });
          }
        }
      } catch (sigErr) {
        logger.debug('Signal exit check failed', { error: sigErr.message });
      }

      // ---- HARD STOP LOSS ----
      // Exit threshold comes from the token's strategy mode.
      const stopLossPct = mode.stopLossCollateralPct ?? STRATEGY.stopLossCollateralPct;
      if (pnlPct <= stopLossPct) {
        logger.info('STOP LOSS triggered', {
          token: tokenAddress, market, pnl: pnl.toFixed(2),
          pnlPct: (pnlPct * 100).toFixed(1) + '%',
          threshold: (stopLossPct * 100) + '%',
          strategy: mode.id,
        });

        try {
          const closeResult = await retry(
            () => perps.closePosition(market),
            { retries: 2, delayMs: 2000, label: `stopLoss(${market})` }
          );

          // Track daily loss
          const todayStr = new Date().toDateString();
          const dailyLoss = (state.dailyLossDate === todayStr ? state.dailyLoss : 0) + pnl;

          await db.setPosition(tokenAddress, {
            ...updateData,
            deployedUsd: 0,
            lastAction: 'stop-loss',
            lastActionAt: Date.now(),
            lastCloseAt: Date.now(),
            pnl: 0,
            strategyStage: 'watching',
            highWaterPnl: 0,
            highWaterPrice: 0,
            tp1Hit: false,
            tp2Hit: false,
            dailyLoss,
            dailyLossDate: todayStr,
          });
          await recordTrade(false, pnl, position?.leverage || 25, tokenAddress);
          notifier.notifyPositionClosed({ market, reason: 'stop loss', pnl });

          logger.info('Stop loss executed', { token: tokenAddress, pnl: pnl.toFixed(2), txSig: closeResult?.txSig });
          return { action: 'stop-loss', pnl, txSig: closeResult?.txSig };
        } catch (err) {
          logger.error('Stop loss failed', { token: tokenAddress, error: err.message });
        }
        return null;
      }

      // ---- BREAKEVEN STAGE ----
      // Once price moves 0.5% in our favor, we mentally move SL to breakeven
      if (state.stage === 'watching' && effectivePct >= STRATEGY.breakevenPct) {
        logger.info('BREAKEVEN stage reached', {
          token: tokenAddress, market, priceChange: (effectivePct * 100).toFixed(2) + '%',
        });
        updateData.strategyStage = 'breakeven';
      }

      // If in breakeven stage and price drops back to entry -> close at breakeven
      if (state.stage === 'breakeven' && effectivePct <= 0 && pnl <= STRATEGY.minProfitUsd) {
        logger.info('BREAKEVEN EXIT -- price returned to entry', {
          token: tokenAddress, market, effectivePct: (effectivePct * 100).toFixed(2) + '%',
        });

        try {
          const closeResult = await retry(
            () => perps.closePosition(market),
            { retries: 2, delayMs: 2000, label: `breakeven(${market})` }
          );

          await db.setPosition(tokenAddress, {
            ...updateData,
            deployedUsd: 0,
            lastAction: 'breakeven-exit',
            lastActionAt: Date.now(),
            lastCloseAt: Date.now(),
            pnl: 0,
            strategyStage: 'watching',
            highWaterPnl: 0,
            tp1Hit: false,
          });

          return { action: 'breakeven-exit', pnl: 0, txSig: closeResult?.txSig };
        } catch (err) {
          logger.error('Breakeven exit failed', { token: tokenAddress, error: err.message });
        }
        return null;
      }

      // ---- TAKE PROFIT STAGE 1: Close 25% at +0.5% ----
      if (!state.tp1Hit && effectivePct >= STRATEGY.tp1Pct && pnl > STRATEGY.minProfitUsd) {
        logger.info('TAKE PROFIT STAGE 1 -- closing 25% at +0.5%', {
          token: tokenAddress, market, pnl: pnl.toFixed(2),
          priceChange: (effectivePct * 100).toFixed(2) + '%',
        });

        try {
          const reduceResult = await retry(
            () => perps.reducePosition(market, STRATEGY.tp1ReducePct),
            { retries: 2, delayMs: 2000, label: `tp1(${market})` }
          );

          const newDeployed = deployedAmount * (1 - STRATEGY.tp1ReducePct);

          await db.setPosition(tokenAddress, {
            ...updateData,
            deployedUsd: newDeployed,
            lastAction: 'take-profit-25%-0.5pct',
            lastActionAt: Date.now(),
            tp1Hit: true,
            strategyStage: 'tp1',
            highWaterPrice: currentPrice,
            highWaterPnl: pnl * (1 - STRATEGY.tp1ReducePct),
          });
          await recordTrade(true, pnl * STRATEGY.tp1ReducePct, position?.leverage || 25, tokenAddress);
          notifier.notifyTakeProfit({ market, stage: 'TP1 — 25% @ +0.5%', pnl: pnl * STRATEGY.tp1ReducePct });

          return { action: 'take-profit-25%-0.5pct', pnl: pnl * STRATEGY.tp1ReducePct, txSig: reduceResult?.txSig };
        } catch (err) {
          logger.error('TP1 failed', { token: tokenAddress, error: err.message });
        }
      }

      // ---- TAKE PROFIT STAGE 2: Close another 25% at +1% ----
      if (state.tp1Hit && !state.tp2Hit && effectivePct >= STRATEGY.tp2Pct && pnl > STRATEGY.minProfitUsd) {
        logger.info('TAKE PROFIT STAGE 2 -- closing 33% of remaining at +1%', {
          token: tokenAddress, market, pnl: pnl.toFixed(2),
          priceChange: (effectivePct * 100).toFixed(2) + '%',
        });

        try {
          const reduceResult = await retry(
            () => perps.reducePosition(market, STRATEGY.tp2ReducePct),
            { retries: 2, delayMs: 2000, label: `tp2(${market})` }
          );

          const newDeployed = deployedAmount * (1 - STRATEGY.tp2ReducePct);

          await db.setPosition(tokenAddress, {
            ...updateData,
            deployedUsd: newDeployed,
            lastAction: 'take-profit-25%-1pct',
            lastActionAt: Date.now(),
            tp2Hit: true,
            strategyStage: 'trailing',
            highWaterPrice: currentPrice,
            highWaterPnl: pnl * (1 - STRATEGY.tp2ReducePct),
          });
          await recordTrade(true, pnl * STRATEGY.tp2ReducePct, position?.leverage || 25, tokenAddress);
          notifier.notifyTakeProfit({ market, stage: 'TP2 — 25% @ +1%', pnl: pnl * STRATEGY.tp2ReducePct });

          return { action: 'take-profit-25%-1pct', pnl: pnl * STRATEGY.tp2ReducePct, txSig: reduceResult?.txSig };
        } catch (err) {
          logger.error('TP2 failed', { token: tokenAddress, error: err.message });
        }
      }

      // ---- TRAILING STOP (after TP2 or if TP1 hit and riding) ----
      if (state.stage === 'trailing' || (state.tp1Hit && state.tp2Hit)) {
        // Track the most favorable price seen (highest for longs, LOWEST for
        // shorts — the old max-only tracking meant shorts could never trail)
        const hwPrice = favorableExtreme(direction, state.highWaterPrice, currentPrice);
        const hwPnl = Math.max(state.highWaterPnl || 0, pnl);

        // How far price has retraced from the favorable extreme
        const effectivePullback = pullbackFrom(direction, hwPrice, currentPrice);

        if (effectivePullback >= STRATEGY.trailingCallbackPct && pnl > 0) {
          logger.info('TRAILING STOP triggered', {
            token: tokenAddress, market, direction,
            currentPrice: currentPrice.toFixed(2),
            favorableExtreme: hwPrice.toFixed(2),
            pullback: (effectivePullback * 100).toFixed(2) + '%',
            pnl: pnl.toFixed(2),
          });

          try {
            const closeResult = await retry(
              () => perps.closePosition(market),
              { retries: 2, delayMs: 2000, label: `trailingStop(${market})` }
            );

            await db.setPosition(tokenAddress, {
              ...updateData,
              deployedUsd: 0,
              lastAction: 'trailing-stop',
              lastActionAt: Date.now(),
              lastCloseAt: Date.now(),
              pnl: 0,
              strategyStage: 'watching',
              highWaterPnl: 0,
              highWaterPrice: 0,
              tp1Hit: false,
              tp2Hit: false,
            });
            await recordTrade(true, pnl, position?.leverage || 25, tokenAddress);
            notifier.notifyPositionClosed({ market, reason: 'trailing stop', pnl });

            return { action: 'trailing-stop', pnl, txSig: closeResult?.txSig };
          } catch (err) {
            logger.error('Trailing stop failed', { token: tokenAddress, error: err.message });
          }
        }

        // Update high water marks in DB
        updateData.highWaterPrice = hwPrice;
        updateData.highWaterPnl = hwPnl;
        updateData.strategyStage = 'trailing';
      }

      // Save updated state
      await db.setPosition(tokenAddress, updateData);

      logger.debug('Position monitored', {
        token: tokenAddress, market, stage: updateData.strategyStage || state.stage,
        pnl: pnl.toFixed(2), pnlPct: (pnlPct * 100).toFixed(1) + '%',
        priceChange: (effectivePct * 100).toFixed(2) + '%',
      });

      return null;
    }

    // -------------------------------------------------------------------
    // CASE 2: No position -> check if we should open one
    // -------------------------------------------------------------------
    if (!mode.trade) {
      logger.debug('Strategy mode is off — fees accrue to buybacks only', { token: tokenAddress });
      return null;
    }
    if (mode.rthOnly && !RTH_SESSIONS.includes(getSession())) {
      logger.debug('Outside regular trading hours for this strategy', { token: tokenAddress, strategy: mode.id });
      return null;
    }

    const state = await getStrategyState(tokenAddress);

    // Cooldown check -- don't re-enter too quickly after a close
    if (state.lastCloseAt && Date.now() - state.lastCloseAt < STRATEGY.cooldownMs) {
      logger.debug('Cooldown active, skipping', {
        token: tokenAddress, remainingMs: STRATEGY.cooldownMs - (Date.now() - state.lastCloseAt),
      });
      return null;
    }

    // Daily loss limit -- stop trading if we've lost too much today
    const todayStr = new Date().toDateString();
    const todayLoss = state.dailyLossDate === todayStr ? state.dailyLoss : 0;
    if (todayLoss <= STRATEGY.dailyLossLimitUsd) {
      logger.warn('Daily loss limit reached, not opening new positions', {
        token: tokenAddress, dailyLoss: todayLoss.toFixed(2), limit: STRATEGY.dailyLossLimitUsd,
      });
      return null;
    }

    // Trading collateral is USDC on Arbitrum (Ostium)
    const available = await perps.getFreeCollateral();

    if (available < config.RISK.minDeployUsd) {
      logger.debug('Not enough USDC on Arbitrum', { token: tokenAddress, available: available.toFixed(2) });
      return null;
    }

    // One position per market (can run AAPL + TSLA + NVDA simultaneously)
    const allPositions = await db.getAllPositions();
    const hasActiveForMarket = allPositions.some(p =>
      (p.deployedUsd || 0) > 0 && (p.market || config.DEFAULT_MARKET) === market
    );
    if (hasActiveForMarket) return null;

    // Count how many markets have active positions for capital splitting
    const activeMarkets = new Set(
      allPositions.filter(p => (p.deployedUsd || 0) > 0).map(p => p.market || config.DEFAULT_MARKET)
    ).size;

    if (activeMarkets >= MAX_CONCURRENT_MARKETS) {
      logger.debug('Max concurrent markets reached, skipping entry', { activeMarkets });
      return null;
    }

    // --- MARKET SIGNAL CHECK ---
    // Check momentum, RSI, session, volatility, volume
    let signalLeverage = 20; // default
    let signalScore = null;
    let entryThreshold = 20;
    try {
      entryThreshold = await getEntryThreshold();
    } catch {}

    try {
      const { enter, signal } = await shouldEnterNow(market);
      // Adaptive threshold (learning system) + the strategy's caution bonus
      const requiredScore = entryThreshold + (mode.entryBonus || 0);
      if (!enter || signal.score < requiredScore) {
        logger.info('Market signal below threshold -- skipping entry', {
          token: tokenAddress, score: signal.score, threshold: requiredScore,
          strategy: mode.id, direction: signal.direction,
          rsi: signal.details?.rsi?.value,
          session: signal.details?.session?.name,
        });
        return null;
      }
      signalLeverage = Math.max(signal.leverage || 20, 10);
      signalScore = signal.score;
      logger.info('Market signal FAVORABLE -- proceeding with entry', {
        token: tokenAddress, score: signal.score, direction: signal.direction,
        leverage: signalLeverage + 'x', threshold: requiredScore, strategy: mode.id,
      });
    } catch (sigErr) {
      logger.warn('Signal check failed — skipping entry cycle', { error: sigErr.message });
      return null;
    }

    // Cap trading capital, split across active markets (USDC)
    const capitalPerMarket = config.RISK.maxTradingCapitalUsd / (activeMarkets + 1); // +1 for this new position

    // Per-token fee budget: a token may only deploy what its own creator
    // fees have earned (the 70% share, accrued in ETH by the fee-claimer,
    // converted to USD here). No fees earned -> no capital used.
    const budgetEth = token.feeBudgetEth || 0;
    const ethPrice = await getEthPrice();
    const budgetUsd = ethPrice > 0 ? budgetEth * ethPrice : 0;
    if (budgetUsd < config.RISK.minDeployUsd) {
      logger.info('Token fee budget below minimum deploy — skipping entry', {
        token: tokenAddress, budgetEth: budgetEth.toFixed(6),
        budgetUsd: budgetUsd.toFixed(2), minDeployUsd: config.RISK.minDeployUsd,
      });
      return null;
    }

    const deployAmount = Math.min(available, capitalPerMarket, budgetUsd);
    // Leverage = signal suggestion, bounded by the strategy mode's range AND
    // the cap the creator chose at registration (the tightest limit wins)
    const userCap = token.leverage || 50;
    // Live pair cap — bounded by Ostium's overnightMaxLeverage, since the
    // engine holds across sessions and higher leverage risks forced
    // liquidation at the close
    const pairCap = await perps.getSafeMaxLeverage(market);
    const maxLev = Math.min(pairCap, mode.maxLev || 50, userCap);
    const effectiveLeverage = Math.min(Math.max(signalLeverage, Math.min(mode.minLev || 1, maxLev)), maxLev);
    const sizeUsd = deployAmount * effectiveLeverage;

    if (sizeUsd < 50) return null;

    logger.info('Opening position', {
      token: tokenAddress, market, direction, strategy: mode.id,
      leverage: effectiveLeverage + 'x',
      collateralUsd: deployAmount.toFixed(2),
      sizeUsd: sizeUsd.toFixed(0),
    });

    const result = await openPositionSafely(market, sizeUsd, deployAmount, direction);
    if (result?.skipped) return null;

    await db.setPosition(tokenAddress, {
      tokenAddress,
      side: direction,
      market,
      leverage: effectiveLeverage,
      deployedUsd: deployAmount,
      sizeUsd,
      lastAction: 'open',
      lastActionAt: Date.now(),
      entry: 0,
      pnl: 0,
      strategyStage: 'watching',
      highWaterPnl: 0,
      highWaterPrice: 0,
      tp1Hit: false,
      tp2Hit: false,
      dailyLoss: todayLoss,
      dailyLossDate: todayStr,
      entrySignalScore: signalScore,
      strategy: mode.id,
    });

    notifier.notifyPositionOpened({
      market, side: direction, leverage: effectiveLeverage,
      collateralUsd: deployAmount, sizeUsd, score: signalScore,
    });

    logger.info('Position opened', { token: tokenAddress, market, direction, leverage: effectiveLeverage + 'x', txSig: result.txSig });
    return { action: 'open', txSig: result.txSig, deployedUsd: deployAmount };
  } catch (err) {
    logger.error('Position management failed', { token: tokenAddress, error: err.message });
    return null;
  }
}

/**
 * Run position management for ALL active tokens.
 */
export async function manageAllPositions() {
  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');
  if (active.length === 0) return [];

  // Capital routing first: if the active venue can auto-fund itself from
  // idle collateral (Hyperliquid pulls Arbitrum USDC through its bridge),
  // do that before evaluating entries so sizing sees the real balance.
  try {
    const deposited = await perps.ensureCollateral?.();
    if (deposited?.amount) {
      notifier.notify?.(`💰 Auto-deposited ${deposited.amount.toFixed(2)} USDC to the trading venue (${deposited.hash})`);
    }
  } catch (fundErr) {
    logger.warn('ensureCollateral failed — continuing with current balances', { error: fundErr.message });
  }

  const results = [];

  // Manage existing positions for all tokens (their pegged stock markets)
  for (const token of active) {
    const result = await managePositionForToken(token.id || token.address);
    if (result) results.push({ token: token.id || token.address, ...result });
  }

  // Also scan the extra stock markets for entry opportunities.
  // Uses the FILL protocol token as the anchor for multi-market trading.
  const anchor = config.FILL_TOKEN_ADDRESS;
  const extraMarkets = anchor ? config.EXTRA_MARKETS : [];

  for (const extraMarket of extraMarkets) {
    try {
      const result = await managePositionForMarket(anchor, extraMarket);
      if (result) results.push({ token: anchor, market: extraMarket, ...result });
    } catch (err) {
      logger.warn('Extra market check failed', { market: extraMarket, error: err.message });
    }
  }

  logger.info(`Position management cycle: ${results.length}/${active.length + extraMarkets.length}`);
  return results;
}

/**
 * Manage a position for a specific market (used for TSLA/NVDA multi-market).
 * Same strategy as managePositionForToken but with explicit market override.
 */
async function managePositionForMarket(tokenAddress, market, { manageOnly = false } = {}) {
  try {
    const token = await db.getToken(tokenAddress);
    if (!token || token.status !== 'active') return null;

    // Engine-owned extra markets use the engine default strategy.
    // Live positions are ALWAYS managed below regardless of mode.
    const mode = resolveStrategy(null);

    // Engine-owned extra markets trade both directions off the signal
    let direction = token.side || 'long';
    const posKey = `${tokenAddress}-${market}`;

    // Check live position for this market
    const pnlInfo = await retry(
      () => perps.getPositionPnl(market),
      { retries: 2, delayMs: 2000, label: `getPositionPnl(${market})` }
    );

    // If a position exists for this market, MANAGE it here — nothing else
    // covers engine-owned extra markets, so this block owns SL/trailing.
    if (pnlInfo.exists) {
      let position = await db.getPosition(posKey);
      let deployed = position?.deployedUsd || 0;
      if (deployed <= 0) {
        // Adopt an untracked live position rather than leaving it unmanaged
        deployed = pnlInfo.collateralUsd || 0;
        if (deployed <= 0) return null;
        position = { tokenAddress, market, side: pnlInfo.side, deployedUsd: deployed, strategyStage: 'watching' };
        await db.setPosition(posKey, { ...position, lastAction: 'adopted-live-position', lastActionAt: Date.now() });
      }

      const liveSide = pnlInfo.side;
      const pnl = pnlInfo.pnl || 0;
      const pnlPct = (pnlInfo.collateralUsd || deployed) > 0 ? pnl / (pnlInfo.collateralUsd || deployed) : 0;
      const currentPrice = pnlInfo.currentPrice || 0;

      // Hard stop loss (strategy mode's depth)
      const stopLossPct = mode.stopLossCollateralPct ?? STRATEGY.stopLossCollateralPct;
      if (pnlPct <= stopLossPct) {
        logger.info('EXTRA MARKET STOP LOSS', { market, pnl: pnl.toFixed(2), pnlPct: (pnlPct * 100).toFixed(1) + '%' });
        const closeResult = await retry(
          () => perps.closePosition(market),
          { retries: 2, delayMs: 2000, label: `extraStopLoss(${market})` }
        );
        await db.setPosition(posKey, {
          ...position, deployedUsd: 0, pnl: 0,
          lastAction: 'stop-loss', lastActionAt: Date.now(), lastCloseAt: Date.now(),
          strategyStage: 'watching', highWaterPrice: 0,
        });
        await recordTrade(false, pnl, position?.leverage || 25, tokenAddress);
        notifier.notifyPositionClosed({ market, reason: 'stop loss (engine market)', pnl });
        return { action: 'stop-loss-' + market, pnl, txSig: closeResult?.txSig };
      }

      // Trailing stop once in profit (direction-aware extremes)
      const extreme = favorableExtreme(liveSide, position?.highWaterPrice, currentPrice);
      const pullback = pullbackFrom(liveSide, extreme, currentPrice);
      if (pullback >= STRATEGY.trailingCallbackPct && pnl > STRATEGY.minProfitUsd) {
        logger.info('EXTRA MARKET TRAILING STOP', { market, pnl: pnl.toFixed(2), pullback: (pullback * 100).toFixed(2) + '%' });
        const closeResult = await retry(
          () => perps.closePosition(market),
          { retries: 2, delayMs: 2000, label: `extraTrailing(${market})` }
        );
        await db.setPosition(posKey, {
          ...position, deployedUsd: 0, pnl: 0,
          lastAction: 'trailing-stop', lastActionAt: Date.now(), lastCloseAt: Date.now(),
          strategyStage: 'watching', highWaterPrice: 0,
        });
        await recordTrade(true, pnl, position?.leverage || 25, tokenAddress);
        notifier.notifyPositionClosed({ market, reason: 'trailing stop (engine market)', pnl });
        return { action: 'trailing-stop-' + market, pnl, txSig: closeResult?.txSig };
      }

      // Persist tracking state
      await db.setPosition(posKey, {
        ...position, pnl, currentPrice,
        highWaterPrice: extreme, updatedAt: Date.now(),
      });
      return null;
    }

    // Entry gates: the fast loop never opens; mode gates only block entries
    if (manageOnly) return null;
    if (!mode.trade) return null;
    if (mode.rthOnly && !RTH_SESSIONS.includes(getSession())) return null;

    // No position for this market -- try to enter (USDC on Arbitrum)
    const available = await perps.getFreeCollateral();
    if (available < config.RISK.minDeployUsd) return null;

    // Check if already have position in this market
    const allPositions = await db.getAllPositions();
    const hasActiveForMarket = allPositions.some(p =>
      (p.deployedUsd || 0) > 0 && (p.market || config.DEFAULT_MARKET) === market
    );
    if (hasActiveForMarket) return null;

    const activeMarkets = new Set(
      allPositions.filter(p => (p.deployedUsd || 0) > 0).map(p => p.market || config.DEFAULT_MARKET)
    ).size;

    if (activeMarkets >= MAX_CONCURRENT_MARKETS) return null;

    // Signal check for this specific market — shorts allowed here
    let signalLeverage = 20;
    let signalScore = null;
    let entryThreshold = 20;
    try { entryThreshold = await getEntryThreshold(); } catch {}

    try {
      const { enter, direction: sigDirection, signal } = await shouldEnterNow(market, { allowShort: true });
      if (!enter || Math.abs(signal.score) < entryThreshold) {
        return null;
      }
      direction = sigDirection;
      signalLeverage = Math.max(signal.leverage || 20, 10);
      signalScore = signal.score;
      logger.info('Market signal FAVORABLE for ' + market, {
        token: tokenAddress, market, score: signal.score, direction,
        leverage: signalLeverage + 'x', threshold: entryThreshold,
      });
    } catch {
      return null; // Don't enter extra markets on signal failure
    }

    const capitalPerMarket = config.RISK.maxTradingCapitalUsd / (activeMarkets + 1);
    const deployAmount = Math.min(available, capitalPerMarket);
    // Same overnight-aware cap as pegged-token entries
    const pairCap = await perps.getSafeMaxLeverage(market);
    const maxLev = Math.min(pairCap, mode.maxLev || 50);
    const effectiveLeverage = Math.min(Math.max(signalLeverage, mode.minLev || 1), maxLev);
    const sizeUsd = deployAmount * effectiveLeverage;

    if (sizeUsd < 50) return null;

    logger.info('Opening ' + market + ' position', {
      token: tokenAddress, market, direction, strategy: mode.id,
      leverage: effectiveLeverage + 'x',
      collateralUsd: deployAmount.toFixed(2),
      sizeUsd: sizeUsd.toFixed(0),
    });

    const result = await openPositionSafely(market, sizeUsd, deployAmount, direction);
    if (result?.skipped) return null;

    await db.setPosition(posKey, {
      tokenAddress,
      side: direction,
      market,
      leverage: effectiveLeverage,
      deployedUsd: deployAmount,
      sizeUsd,
      lastAction: 'open',
      lastActionAt: Date.now(),
      entry: 0,
      pnl: 0,
      strategyStage: 'watching',
      highWaterPnl: 0,
      highWaterPrice: 0,
      tp1Hit: false,
      tp2Hit: false,
      entrySignalScore: signalScore,
    });

    notifier.notifyPositionOpened({
      market, side: direction, leverage: effectiveLeverage,
      collateralUsd: deployAmount, sizeUsd, score: signalScore,
    });

    return { action: 'open-' + market, sizeUsd, leverage: effectiveLeverage, txSig: result?.txSig };
  } catch (err) {
    logger.error('managePositionForMarket error', { token: tokenAddress, market, error: err.message });
    return null;
  }
}

/**
 * Fast PnL check -- called more frequently than full management.
 * Only checks stop loss and trailing stop. Does NOT open positions.
 */
export async function checkProfitsAllTokens() {
  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');
  if (active.length === 0) return [];

  const results = [];
  for (const token of active) {
    const tokenAddress = token.id || token.address;
    try {
      const market = token.underlying?.toUpperCase();
      if (!market) continue;

      // Quick live check — no DB gate, so orphaned positions get adopted
      // and risk-managed by the fast loop too
      const pnlInfo = await perps.getPositionPnl(market);
      if (!pnlInfo.exists) continue;

      // Run full strategy logic (handles SL, breakeven, TP, trailing)
      const result = await managePositionForToken(tokenAddress);
      if (result) results.push(result);
    } catch (err) {
      logger.debug('Profit check error', { token: tokenAddress, error: err.message });
    }
  }

  // Engine-owned extra markets: manage (close-only) from the fast loop too
  const anchor = config.FILL_TOKEN_ADDRESS;
  if (anchor) {
    for (const market of config.EXTRA_MARKETS) {
      try {
        const result = await managePositionForMarket(anchor, market, { manageOnly: true });
        if (result) results.push(result);
      } catch (err) {
        logger.debug('Extra market fast check error', { market, error: err.message });
      }
    }
  }

  return results;
}
