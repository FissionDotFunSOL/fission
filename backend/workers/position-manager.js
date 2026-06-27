import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as perps from '../services/perps-router.js';
import { getAllTokens } from '../db/firebase.js';
import { getSolPrice } from '../services/jupiter.js';
import { getSolBalance } from '../services/solana.js';
import { retry } from '../utils/helpers.js';
import { shouldEnterNow, shouldExitNow } from '../services/market-signal.js';

// ---------------------------------------------------------------------------
// High-Leverage Scalping Strategy
//
// Based on professional high-leverage trading patterns:
// 1. Open ONE position at the token's configured leverage
// 2. Use a 3-stage exit system:
//    Stage 1: Move SL to breakeven once +1% profit hit
//    Stage 2: Take 50% profit at +3% gain
//    Stage 3: Trail remaining 50% with a 1.5% trailing stop
// 3. Hard stop loss at -50% of collateral (before liquidation)
// 4. Never add to a losing position
// 5. After close, wait for next fee cycle before re-entering
//
// Key principle: let winners run, cut losers fast.
// ---------------------------------------------------------------------------

// SMART DEGEN v3 -- DCA profit taking + learning from mistakes
const STRATEGY = {
  // Hard stop loss at -40% collateral
  stopLossCollateralPct: -0.40,

  // Move SL to breakeven after +1% price move
  breakevenPct: 0.01,

  // DCA Take Profit stages:
  // Stage 1: close 25% at +1% price move
  // Stage 2: close 25% at +2% price move
  // Stage 3: trail remaining 50% with 1% callback from highs
  tp1Pct: 0.01,                   // 1% = first take profit
  tp1ReducePct: 0.25,             // close 25%
  tp2Pct: 0.02,                   // 2% = second take profit
  tp2ReducePct: 0.33,             // close 33% of remaining (= 25% of original)
  trailingCallbackPct: 0.01,      // 1% trailing stop on final 50%

  // Minimum profit to bother taking
  minProfitUsd: 1,

  // Cooldown after a loss
  cooldownMs: 30_000,

  // No daily loss limit
  dailyLossLimitUsd: -999999,
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
    };
  } catch {
    return { recentTrades: [], totalWins: 0, totalLosses: 0 };
  }
}

async function recordTrade(win, pnl, leverage) {
  const history = await getTradeHistory();
  const trade = { win, pnl: Math.round(pnl * 100) / 100, leverage, timestamp: Date.now() };
  const recent = [...history.recentTrades, trade].slice(-20); // keep last 20
  await db.setDoc('config', TRADE_HISTORY_KEY, {
    recentTrades: recent,
    totalWins: history.totalWins + (win ? 1 : 0),
    totalLosses: history.totalLosses + (win ? 0 : 1),
    lastUpdated: Date.now(),
  });
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
async function getStrategyState(mint) {
  const pos = await db.getPosition(mint);
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
export async function managePositionForToken(mint) {
  try {
    const token = await db.getToken(mint);
    if (!token || token.status !== 'active') return null;

    const underlying = token.underlying?.toUpperCase();
    const market = underlying && config.ALL_PERPS_MARKETS.includes(underlying)
      ? underlying : null;
    if (!market) return null;

    const direction = token.side || 'long';

    // Check live on-chain position
    const pnlInfo = await retry(
      () => perps.getPositionPnl(market),
      { retries: 2, delayMs: 2000, label: `getPositionPnl(${market})` }
    );

    // -------------------------------------------------------------------
    // CASE 1: Position exists -> run the strategy engine
    // -------------------------------------------------------------------
    if (pnlInfo.exists) {
      const position = await db.getPosition(mint);
      const deployedAmount = position?.deployedSol || 0;
      if (deployedAmount <= 0) return null;

      const state = await getStrategyState(mint);
      const pnl = pnlInfo.pnl || 0;
      const currentPrice = pnlInfo.currentPrice || 0;
      const entryPrice = pnlInfo.entry || position?.entry || 0;

      // Calculate price change percentage from entry
      const priceChangePct = entryPrice > 0 ? (currentPrice - entryPrice) / entryPrice : 0;
      // For shorts, invert the sign
      const effectivePct = direction === 'short' ? -priceChangePct : priceChangePct;

      // Calculate collateral-based PnL percentage
      const solPrice = await getSolPrice();
      const collateralUsd = deployedAmount * (solPrice || 72);
      const pnlPct = collateralUsd > 0 ? pnl / collateralUsd : 0;

      // Update DB with latest PnL
      const updateData = {
        ...position,
        tokenMint: mint,
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
            mint, market, reason, pnl: pnl.toFixed(2),
            pnlPct: (pnlPct * 100).toFixed(1) + '%',
          });

          try {
            const closeResult = await retry(
              () => perps.closePosition(market, direction),
              { retries: 2, delayMs: 2000, label: `signalExit(${market})` }
            );
          await db.setPosition(mint, {
            ...updateData, deployedSol: 0,
            lastAction: 'signal-exit-' + reason,
            lastActionAt: Date.now(), lastCloseAt: Date.now(),
            pnl: 0, strategyStage: 'watching',
            highWaterPnl: 0, highWaterPrice: 0, tp1Hit: false, tp2Hit: false,
          });
          await recordTrade(false, pnl, position?.leverage || 50);
            return { action: 'signal-exit', reason, pnl, txSig: closeResult?.txSig };
          } catch (err) {
            logger.error('Signal exit failed', { mint, error: err.message });
          }
        }
      } catch (sigErr) {
        logger.debug('Signal exit check failed', { error: sigErr.message });
      }

      // ---- HARD STOP LOSS ----
      // Exit at -40% collateral. Survive to trade again.
      if (pnlPct <= STRATEGY.stopLossCollateralPct) {
        logger.info('STOP LOSS triggered', {
          mint, market, pnl: pnl.toFixed(2),
          pnlPct: (pnlPct * 100).toFixed(1) + '%',
          threshold: (STRATEGY.stopLossCollateralPct * 100) + '%',
        });

        try {
          const closeResult = await retry(
            () => perps.closePosition(market, direction),
            { retries: 2, delayMs: 2000, label: `stopLoss(${market})` }
          );

          // Track daily loss
          const todayStr = new Date().toDateString();
          const dailyLoss = (state.dailyLossDate === todayStr ? state.dailyLoss : 0) + pnl;

          await db.setPosition(mint, {
            ...updateData,
            deployedSol: 0,
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
          await recordTrade(false, pnl, position?.leverage || 50);

          logger.info('Stop loss executed', { mint, pnl: pnl.toFixed(2), txSig: closeResult?.txSig });
          return { action: 'stop-loss', pnl, txSig: closeResult?.txSig };
        } catch (err) {
          logger.error('Stop loss failed', { mint, error: err.message });
        }
        return null;
      }

      // ---- BREAKEVEN STAGE ----
      // Once price moves 1% in our favor, we mentally move SL to breakeven
      if (state.stage === 'watching' && effectivePct >= STRATEGY.breakevenPct) {
        logger.info('BREAKEVEN stage reached', {
          mint, market, priceChange: (effectivePct * 100).toFixed(2) + '%',
        });
        updateData.strategyStage = 'breakeven';
      }

      // If in breakeven stage and price drops back to entry -> close at breakeven
      if (state.stage === 'breakeven' && effectivePct <= 0 && pnl <= STRATEGY.minProfitUsd) {
        logger.info('BREAKEVEN EXIT -- price returned to entry', {
          mint, market, effectivePct: (effectivePct * 100).toFixed(2) + '%',
        });

        try {
          const closeResult = await retry(
            () => perps.closePosition(market, direction),
            { retries: 2, delayMs: 2000, label: `breakeven(${market})` }
          );

          await db.setPosition(mint, {
            ...updateData,
            deployedSol: 0,
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
          logger.error('Breakeven exit failed', { mint, error: err.message });
        }
        return null;
      }

      // ---- TAKE PROFIT STAGE 1: Close 25% at +1% ----
      if (!state.tp1Hit && effectivePct >= STRATEGY.tp1Pct && pnl > STRATEGY.minProfitUsd) {
        logger.info('TAKE PROFIT STAGE 1 -- closing 25% at +1%', {
          mint, market, pnl: pnl.toFixed(2),
          priceChange: (effectivePct * 100).toFixed(2) + '%',
        });

        try {
          const reduceResult = await retry(
            () => perps.reducePosition(market, STRATEGY.tp1ReducePct, direction),
            { retries: 2, delayMs: 2000, label: `tp1(${market})` }
          );

          const newDeployed = deployedAmount * (1 - STRATEGY.tp1ReducePct);

          await db.setPosition(mint, {
            ...updateData,
            deployedSol: newDeployed,
            lastAction: 'take-profit-25%-1pct',
            lastActionAt: Date.now(),
            tp1Hit: true,
            strategyStage: 'tp1',
            highWaterPrice: currentPrice,
            highWaterPnl: pnl * (1 - STRATEGY.tp1ReducePct),
          });
          await recordTrade(true, pnl * STRATEGY.tp1ReducePct, position?.leverage || 50);

          return { action: 'take-profit-25%-1pct', pnl: pnl * STRATEGY.tp1ReducePct, txSig: reduceResult?.txSig };
        } catch (err) {
          logger.error('TP1 failed', { mint, error: err.message });
        }
      }

      // ---- TAKE PROFIT STAGE 2: Close another 25% at +2% ----
      if (state.tp1Hit && !state.tp2Hit && effectivePct >= STRATEGY.tp2Pct && pnl > STRATEGY.minProfitUsd) {
        logger.info('TAKE PROFIT STAGE 2 -- closing 33% of remaining at +2%', {
          mint, market, pnl: pnl.toFixed(2),
          priceChange: (effectivePct * 100).toFixed(2) + '%',
        });

        try {
          const reduceResult = await retry(
            () => perps.reducePosition(market, STRATEGY.tp2ReducePct, direction),
            { retries: 2, delayMs: 2000, label: `tp2(${market})` }
          );

          const newDeployed = deployedAmount * (1 - STRATEGY.tp2ReducePct);

          await db.setPosition(mint, {
            ...updateData,
            deployedSol: newDeployed,
            lastAction: 'take-profit-25%-2pct',
            lastActionAt: Date.now(),
            tp2Hit: true,
            strategyStage: 'trailing',
            highWaterPrice: currentPrice,
            highWaterPnl: pnl * (1 - STRATEGY.tp2ReducePct),
          });
          await recordTrade(true, pnl * STRATEGY.tp2ReducePct, position?.leverage || 50);

          return { action: 'take-profit-25%-2pct', pnl: pnl * STRATEGY.tp2ReducePct, txSig: reduceResult?.txSig };
        } catch (err) {
          logger.error('TP2 failed', { mint, error: err.message });
        }
      }

      // ---- TRAILING STOP (after TP2 or if TP1 hit and riding) ----
      if (state.stage === 'trailing' || (state.tp1Hit && state.tp2Hit)) {
        // Update high water mark
        const hwPrice = Math.max(state.highWaterPrice || 0, currentPrice);
        const hwPnl = Math.max(state.highWaterPnl || 0, pnl);

        // Check if price has pulled back from high by the callback %
        const pullbackFromHigh = hwPrice > 0 ? (hwPrice - currentPrice) / hwPrice : 0;
        const effectivePullback = direction === 'short' ? -pullbackFromHigh : pullbackFromHigh;

        if (effectivePullback >= STRATEGY.trailingCallbackPct && pnl > 0) {
          logger.info('TRAILING STOP triggered', {
            mint, market,
            currentPrice: currentPrice.toFixed(2),
            highWaterPrice: hwPrice.toFixed(2),
            pullback: (effectivePullback * 100).toFixed(2) + '%',
            pnl: pnl.toFixed(2),
          });

          try {
            const closeResult = await retry(
              () => perps.closePosition(market, direction),
              { retries: 2, delayMs: 2000, label: `trailingStop(${market})` }
            );

            await db.setPosition(mint, {
              ...updateData,
              deployedSol: 0,
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
            await recordTrade(true, pnl, position?.leverage || 50);

            return { action: 'trailing-stop', pnl, txSig: closeResult?.txSig };
          } catch (err) {
            logger.error('Trailing stop failed', { mint, error: err.message });
          }
        }

        // Update high water marks in DB
        updateData.highWaterPrice = hwPrice;
        updateData.highWaterPnl = hwPnl;
        updateData.strategyStage = 'trailing';
      }

      // Save updated state
      await db.setPosition(mint, updateData);

      logger.debug('Position monitored', {
        mint, market, stage: updateData.strategyStage || state.stage,
        pnl: pnl.toFixed(2), pnlPct: (pnlPct * 100).toFixed(1) + '%',
        priceChange: (effectivePct * 100).toFixed(2) + '%',
      });

      return null;
    }

    // -------------------------------------------------------------------
    // CASE 2: No position -> check if we should open one
    // -------------------------------------------------------------------
    const position = await db.getPosition(mint);
    const state = await getStrategyState(mint);

    // Cooldown check -- don't re-enter too quickly after a close
    if (state.lastCloseAt && Date.now() - state.lastCloseAt < STRATEGY.cooldownMs) {
      logger.debug('Cooldown active, skipping', {
        mint, remainingMs: STRATEGY.cooldownMs - (Date.now() - state.lastCloseAt),
      });
      return null;
    }

    // Daily loss limit -- stop trading if we've lost too much today
    const todayStr = new Date().toDateString();
    const todayLoss = state.dailyLossDate === todayStr ? state.dailyLoss : 0;
    if (todayLoss <= STRATEGY.dailyLossLimitUsd) {
      logger.warn('Daily loss limit reached, not opening new positions', {
        mint, dailyLoss: todayLoss.toFixed(2), limit: STRATEGY.dailyLossLimitUsd,
      });
      return null;
    }

    const walletBalance = await getSolBalance(config.PROTOCOL_PUBKEY);
    const available = Math.max(0, walletBalance - config.RISK.minWalletBalanceSol);

    if (available < config.RISK.minDeploySol) {
      logger.debug('Not enough SOL', { mint, available: available.toFixed(4) });
      return null;
    }

    // One position per market (can run SOL + BTC + ETH simultaneously)
    const allPositions = await db.getAllPositions();
    const hasActiveForMarket = allPositions.some(p => 
      (p.deployedSol || 0) > 0 && (p.market || 'SOL') === market
    );
    if (hasActiveForMarket) return null;

    // Count how many markets have active positions for capital splitting
    const activeMarkets = new Set(
      allPositions.filter(p => (p.deployedSol || 0) > 0).map(p => p.market || 'SOL')
    ).size;

    // --- MARKET SIGNAL CHECK ---
    // Check momentum, RSI, session, volatility, volume, funding
    let signalLeverage = 50; // default
    let entryThreshold = 20;
    try {
      entryThreshold = await getEntryThreshold();
    } catch {}

    try {
      const { enter, signal } = await shouldEnterNow(market);
      // Check against adaptive threshold (learning system)
      if (!enter || signal.score < entryThreshold) {
        logger.info('Market signal below threshold -- skipping entry', {
          mint, score: signal.score, threshold: entryThreshold,
          direction: signal.direction,
          rsi: signal.details?.rsi?.value,
          session: signal.details?.session?.name,
          funding: signal.details?.funding?.rate,
        });
        return null;
      }
      signalLeverage = Math.max(signal.leverage || 50, 50); // minimum 50x
      logger.info('Market signal FAVORABLE -- proceeding with entry', {
        mint, score: signal.score, direction: signal.direction,
        leverage: signalLeverage + 'x', threshold: entryThreshold,
        note: signal.note || '',
      });
    } catch (sigErr) {
      logger.warn('Signal check failed, entering with 50x', { error: sigErr.message });
      signalLeverage = 50;
    }

    // Leverage from signal score (overrides token config)
    const solPrice = await getSolPrice();
    if (solPrice <= 0) return null;

    // Cap trading capital at 10 SOL total, split across active markets
    const MAX_TRADING_CAPITAL = 10;
    const capitalPerMarket = MAX_TRADING_CAPITAL / (activeMarkets + 1); // +1 for this new position
    const deployAmount = Math.min(available, capitalPerMarket);
    const collateralUsd = deployAmount * solPrice;
    const maxLev = perps.getMaxLeverage(market);
    const effectiveLeverage = Math.min(signalLeverage, maxLev);
    const sizeUsd = collateralUsd * effectiveLeverage;

    if (sizeUsd < 100) return null;

    logger.info('Opening position', {
      mint, market, direction,
      leverage: effectiveLeverage + 'x',
      collateralSol: deployAmount.toFixed(4),
      sizeUsd: sizeUsd.toFixed(0),
    });

    const result = await retry(
      () => perps.openPosition(market, sizeUsd, deployAmount, direction),
      { retries: 2, delayMs: 3000, label: `openPosition(${market})` }
    );

    await db.setPosition(mint, {
      tokenMint: mint,
      side: direction,
      market,
      leverage: effectiveLeverage,
      deployedSol: deployAmount,
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
    });

    logger.info('Position opened', { mint, market, direction, leverage: effectiveLeverage + 'x', txSig: result.txSig });
    return { action: 'open', txSig: result.txSig, deployedSol: deployAmount };
  } catch (err) {
    logger.error('Position management failed', { mint, error: err.message });
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

  const results = [];

  // Manage existing positions for all tokens (SOL market)
  for (const token of active) {
    const result = await managePositionForToken(token.id || token.mint);
    if (result) results.push({ mint: token.id || token.mint, ...result });
  }

  // Also scan BTC and ETH markets for entry opportunities
  // Uses the FISSION main token as the anchor for multi-market trading
  const FISSION_MINT = '2Ymo8SHM4yhhjvnjvZue6qXfQHUJXtZt2wUCgsMZpump';
  const extraMarkets = ['BTC', 'ETH'];

  for (const extraMarket of extraMarkets) {
    try {
      const result = await managePositionForMarket(FISSION_MINT, extraMarket);
      if (result) results.push({ mint: FISSION_MINT, market: extraMarket, ...result });
    } catch (err) {
      logger.warn('Extra market check failed', { market: extraMarket, error: err.message });
    }
  }

  logger.info(`Position management cycle: ${results.length}/${active.length + extraMarkets.length}`);
  return results;
}

/**
 * Manage a position for a specific market (used for BTC/ETH multi-market).
 * Same strategy as managePositionForToken but with explicit market override.
 */
async function managePositionForMarket(mint, market) {
  try {
    const token = await db.getToken(mint);
    if (!token || token.status !== 'active') return null;

    const direction = token.side || 'long';
    const posKey = `${mint}-${market}`;

    // Check live on-chain position for this market
    const pnlInfo = await retry(
      () => perps.getPositionPnl(market),
      { retries: 2, delayMs: 2000, label: `getPositionPnl(${market})` }
    );

    // If position exists for this market, manage it via DB key
    if (pnlInfo.exists) {
      const position = await db.getPosition(posKey);
      if (!position || (position.deployedSol || 0) <= 0) return null;
      // Delegate to the main function logic (it handles SL/TP/trailing)
      // For now, just log -- the main token loop handles its own market
      return null;
    }

    // No position for this market -- try to enter
    const walletBalance = await getSolBalance(config.PROTOCOL_PUBKEY);
    const available = Math.max(0, walletBalance - config.RISK.minWalletBalanceSol);
    if (available < config.RISK.minDeploySol) return null;

    // Check if already have position in this market
    const allPositions = await db.getAllPositions();
    const hasActiveForMarket = allPositions.some(p =>
      (p.deployedSol || 0) > 0 && (p.market || 'SOL') === market
    );
    if (hasActiveForMarket) return null;

    const activeMarkets = new Set(
      allPositions.filter(p => (p.deployedSol || 0) > 0).map(p => p.market || 'SOL')
    ).size;

    // Signal check for this specific market
    let signalLeverage = 50;
    let entryThreshold = 20;
    try { entryThreshold = await getEntryThreshold(); } catch {}

    try {
      const { enter, signal } = await shouldEnterNow(market);
      if (!enter || signal.score < entryThreshold) {
        return null;
      }
      signalLeverage = Math.max(signal.leverage || 50, 50);
      logger.info('Market signal FAVORABLE for ' + market, {
        mint, market, score: signal.score, direction: signal.direction,
        leverage: signalLeverage + 'x', threshold: entryThreshold,
      });
    } catch {
      return null; // Don't enter extra markets on signal failure
    }

    const solPrice = await getSolPrice();
    if (solPrice <= 0) return null;

    const MAX_TRADING_CAPITAL = 10;
    const capitalPerMarket = MAX_TRADING_CAPITAL / (activeMarkets + 1);
    const deployAmount = Math.min(available, capitalPerMarket);
    const collateralUsd = deployAmount * solPrice;
    const maxLev = perps.getMaxLeverage(market);
    const effectiveLeverage = Math.min(signalLeverage, maxLev);
    const sizeUsd = collateralUsd * effectiveLeverage;

    if (sizeUsd < 100) return null;

    logger.info('Opening ' + market + ' position', {
      mint, market, direction,
      leverage: effectiveLeverage + 'x',
      collateralSol: deployAmount.toFixed(4),
      sizeUsd: sizeUsd.toFixed(0),
    });

    const result = await retry(
      () => perps.openPosition(market, sizeUsd, deployAmount, direction),
      { retries: 2, delayMs: 3000, label: `openPosition(${market})` }
    );

    await db.setPosition(posKey, {
      tokenMint: mint,
      side: direction,
      market,
      leverage: effectiveLeverage,
      deployedSol: deployAmount,
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
    });

    return { action: 'open-' + market, sizeUsd, leverage: effectiveLeverage, txSig: result?.txSig };
  } catch (err) {
    logger.error('managePositionForMarket error', { mint, market, error: err.message });
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
    const mint = token.id || token.mint;
    try {
      const market = token.underlying?.toUpperCase();
      if (!market) continue;

      const position = await db.getPosition(mint);
      if (!position || (position.deployedSol || 0) <= 0) continue;

      // Quick PnL check
      const pnlInfo = await perps.getPositionPnl(market);
      if (!pnlInfo.exists) continue;

      // Run full strategy logic (handles SL, breakeven, TP, trailing)
      const result = await managePositionForToken(mint);
      if (result) results.push(result);
    } catch (err) {
      logger.debug('Profit check error', { mint, error: err.message });
    }
  }

  return results;
}
