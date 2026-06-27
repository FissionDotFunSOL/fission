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

// SMART DEGEN strategy -- high leverage but with real risk management
const STRATEGY = {
  // Hard stop loss at -40% collateral (survive to trade again)
  // Liquidation is the emergency, NOT the plan
  stopLossCollateralPct: -0.40,

  // Move SL to breakeven after +1.5% price move
  breakevenPct: 0.015,

  // Take profit: close 50% at +2% price move (at 100x = 200% return)
  tp1Pct: 0.02,                   // 2% price move = close half
  tp1ReducePct: 0.50,             // close 50% of position

  // Trail the rest with 1.5% callback
  trailingCallbackPct: 0.015,     // tighter trailing stop

  // Minimum profit to bother taking
  minProfitUsd: 1,

  // Short cooldown after a loss to avoid revenge trading
  cooldownMs: 30_000,             // 30 seconds

  // No daily loss limit (fees refill the wallet)
  dailyLossLimitUsd: -999999,
};

/**
 * Get or create the strategy state for a position.
 * Tracks breakeven/TP stages and trailing stop high-water mark.
 */
async function getStrategyState(mint) {
  const pos = await db.getPosition(mint);
  return {
    stage: pos?.strategyStage || 'watching',  // watching | breakeven | trailing
    highWaterPnl: pos?.highWaterPnl || 0,
    highWaterPrice: pos?.highWaterPrice || 0,
    tp1Hit: pos?.tp1Hit || false,
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
        const { shouldExit, reason } = await shouldExitNow(direction);
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
              highWaterPnl: 0, highWaterPrice: 0, tp1Hit: false,
            });
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
            dailyLoss,
            dailyLossDate: todayStr,
          });

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

      // ---- TAKE PROFIT STAGE 1: Close 50% at +3% ----
      if (!state.tp1Hit && effectivePct >= STRATEGY.tp1Pct && pnl > STRATEGY.minProfitUsd) {
        logger.info('TAKE PROFIT STAGE 1 -- closing 50%', {
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
            lastAction: 'take-profit-50%',
            lastActionAt: Date.now(),
            tp1Hit: true,
            strategyStage: 'trailing',
            highWaterPrice: currentPrice,
            highWaterPnl: pnl * (1 - STRATEGY.tp1ReducePct),
          });

          return { action: 'take-profit-50%', pnl: pnl * STRATEGY.tp1ReducePct, txSig: reduceResult?.txSig };
        } catch (err) {
          logger.error('TP1 failed', { mint, error: err.message });
        }
      }

      // ---- TRAILING STOP (after TP1) ----
      if (state.stage === 'trailing' || state.tp1Hit) {
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
            });

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

    // Only one position at a time
    const allPositions = await db.getAllPositions();
    const hasActive = allPositions.some(p => (p.deployedSol || 0) > 0);
    if (hasActive) return null;

    // --- MARKET SIGNAL CHECK ---
    // Check momentum, RSI, session, volatility, volume, funding
    let signalLeverage = 50; // default
    try {
      const { enter, signal } = await shouldEnterNow();
      if (!enter) {
        logger.info('Market signal says WAIT -- skipping entry', {
          mint, score: signal.score, direction: signal.direction,
          rsi: signal.details?.rsi?.value,
          session: signal.details?.session?.name,
          funding: signal.details?.funding?.rate,
        });
        return null;
      }
      signalLeverage = signal.leverage || 50;
      logger.info('Market signal FAVORABLE -- proceeding with entry', {
        mint, score: signal.score, direction: signal.direction,
        leverage: signalLeverage + 'x',
        note: signal.note || '',
      });
    } catch (sigErr) {
      // If signal check fails, enter with conservative leverage
      logger.warn('Signal check failed, entering with 30x', { error: sigErr.message });
      signalLeverage = 30;
    }

    // Leverage from signal score (overrides token config)
    const solPrice = await getSolPrice();
    if (solPrice <= 0) return null;

    const deployAmount = available;
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
  for (const token of active) {
    const result = await managePositionForToken(token.id || token.mint);
    if (result) results.push({ mint: token.id || token.mint, ...result });
  }

  logger.info(`Position management cycle: ${results.length}/${active.length}`);
  return results;
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
