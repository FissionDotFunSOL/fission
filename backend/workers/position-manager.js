import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as perps from '../services/perps-router.js';
import { getAllTokens } from '../db/firebase.js';
import { getSolPrice } from '../services/jupiter.js';
import { getSolBalance } from '../services/solana.js';
import { retry } from '../utils/helpers.js';

// ---------------------------------------------------------------------------
// Simple high-risk strategy:
//
// 1. If no position exists and wallet has enough SOL -> open ONE position
//    at the configured leverage (default 50x for SOL).
// 2. If a position exists -> DON'T touch it. No adding, no closing, no
//    reopening. Let it ride.
// 3. Take profit only when PnL > $100 (configurable).
// 4. Only manage ONE position at a time. All tokens share it.
// ---------------------------------------------------------------------------

const MIN_PROFIT_TO_TAKE = 100; // $100 minimum before taking profit
const TARGET_LEVERAGE = 50;     // Sweet spot: high enough for $100+ on 1-2% moves, not so high it gets liquidated instantly

/**
 * Manage the single shared position.
 * Called for each token but only the first active token actually opens/manages.
 */
export async function managePositionForToken(mint) {
  try {
    const token = await db.getToken(mint);
    if (!token || token.status !== 'active') return null;

    const underlying = token.underlying?.toUpperCase();
    const market = underlying && config.ALL_PERPS_MARKETS.includes(underlying)
      ? underlying : null;
    if (!market) return null;

    // Check live on-chain position
    const pnlInfo = await retry(
      () => perps.getPositionPnl(market),
      { retries: 2, delayMs: 2000, label: `getPositionPnl(${market})` }
    );

    // -------------------------------------------------------------------
    // CASE 1: Position exists -> monitor PnL, take profit if big enough
    // -------------------------------------------------------------------
    if (pnlInfo.exists) {
      const position = await db.getPosition(mint);
      const deployedAmount = position?.deployedSol || 0;

      // Update PnL in DB
      if (deployedAmount > 0) {
        await db.setPosition(mint, {
          ...position,
          tokenMint: mint,
          pnl: pnlInfo.pnl || 0,
          entry: pnlInfo.entry || position?.entry || 0,
          updatedAt: Date.now(),
        });
      }

      // Take profit if PnL exceeds minimum threshold
      if (pnlInfo.pnl >= MIN_PROFIT_TO_TAKE && deployedAmount > 0) {
        logger.info('TAKE PROFIT -- PnL exceeds $' + MIN_PROFIT_TO_TAKE, {
          mint, market, pnl: pnlInfo.pnl.toFixed(2),
        });

        try {
          // Close the entire position (not partial reduce)
          const closeResult = await retry(
            () => perps.closePosition(market, token.side || 'long'),
            { retries: 2, delayMs: 3000, label: `takeProfit(${market})` }
          );

          await db.setPosition(mint, {
            ...position,
            tokenMint: mint,
            deployedSol: 0,
            lastAction: 'take-profit',
            lastActionAt: Date.now(),
            pnl: 0,
          });

          logger.info('Take profit executed -- position closed', {
            mint, market, pnl: pnlInfo.pnl.toFixed(2), txSig: closeResult?.txSig,
          });

          return { action: 'take-profit', txSig: closeResult?.txSig, pnl: pnlInfo.pnl };
        } catch (err) {
          logger.error('Take profit failed', { mint, market, error: err.message });
        }
      }

      // Position exists but not profitable enough -- do nothing, let it ride
      logger.debug('Position active, letting it ride', {
        mint, market, pnl: (pnlInfo.pnl || 0).toFixed(2),
      });
      return null;
    }

    // -------------------------------------------------------------------
    // CASE 2: No position exists -> check if we should open one
    // -------------------------------------------------------------------
    const walletBalance = await getSolBalance(config.PROTOCOL_PUBKEY);
    const minBalance = config.RISK.minWalletBalanceSol;
    const available = Math.max(0, walletBalance - minBalance);

    // Need at least 0.5 SOL to open
    if (available < config.RISK.minDeploySol) {
      logger.debug('Not enough SOL to open position', {
        mint, available: available.toFixed(4),
      });
      return null;
    }

    // Check if ANY token already has a position -- only one position at a time
    const allPositions = await db.getAllPositions();
    const hasActivePosition = allPositions.some(p => (p.deployedSol || 0) > 0);
    if (hasActivePosition) {
      logger.debug('Another token already has a position, skipping', { mint });
      return null;
    }

    // Open position with target leverage
    const solPrice = await getSolPrice();
    if (solPrice <= 0) return null;

    const deployAmount = available;
    const collateralUsd = deployAmount * solPrice;
    const leverage = TARGET_LEVERAGE;
    const sizeUsd = collateralUsd * leverage;

    if (sizeUsd < 100) {
      logger.debug('Position too small', { mint, sizeUsd: sizeUsd.toFixed(2) });
      return null;
    }

    const direction = token.side || 'long';

    logger.info('Opening position', {
      mint, market, direction,
      leverage: leverage + 'x',
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
      leverage,
      deployedSol: deployAmount,
      sizeUsd,
      lastAction: 'open',
      lastActionAt: Date.now(),
      entry: 0,
      pnl: 0,
    });

    logger.info('Position opened', { mint, market, direction, txSig: result.txSig });
    return { action: 'open', txSig: result.txSig, deployedSol: deployAmount };
  } catch (err) {
    logger.error('Position management failed', { mint, error: err.message });
    return null;
  }
}

/**
 * Run position management for ALL active tokens.
 * In practice, only one token opens/manages the shared position.
 */
export async function manageAllPositions() {
  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');

  if (active.length === 0) {
    logger.info('No active tokens for position management');
    return [];
  }

  const results = [];
  for (const token of active) {
    const result = await managePositionForToken(token.id || token.mint);
    if (result) results.push({ mint: token.id || token.mint, ...result });
  }

  logger.info(`Position management cycle complete: ${results.length}/${active.length}`);
  return results;
}

/**
 * Fast profit check for ALL active tokens.
 * Only checks PnL and takes profits. Does NOT open new positions.
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

      const pnlInfo = await perps.getPositionPnl(market);
      if (!pnlInfo.exists) continue;

      const position = await db.getPosition(mint);
      if (!position || (position.deployedSol || 0) <= 0) continue;

      // Update PnL
      await db.setPosition(mint, {
        ...position,
        pnl: pnlInfo.pnl || 0,
        entry: pnlInfo.entry || position.entry,
        updatedAt: Date.now(),
      });

      // Take profit if big enough
      if (pnlInfo.pnl >= MIN_PROFIT_TO_TAKE) {
        logger.info('FAST TAKE PROFIT triggered', {
          mint, market, pnl: pnlInfo.pnl.toFixed(2),
        });

        try {
          const closeResult = await retry(
            () => perps.closePosition(market, token.side || 'long'),
            { retries: 2, delayMs: 2000, label: `fastTP(${market})` }
          );

          await db.setPosition(mint, {
            ...position,
            deployedSol: 0,
            lastAction: 'fast-take-profit',
            lastActionAt: Date.now(),
            pnl: 0,
          });

          results.push({ mint, action: 'fast-take-profit', pnl: pnlInfo.pnl, txSig: closeResult?.txSig });
        } catch (err) {
          logger.error('Fast take profit failed', { mint, error: err.message });
        }
      }
    } catch (err) {
      logger.debug('Profit check error', { mint, error: err.message });
    }
  }

  return results;
}
