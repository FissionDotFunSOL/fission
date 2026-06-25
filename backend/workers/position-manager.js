import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as drift from '../services/drift.js';
import { getAllTokens } from '../db/firebase.js';
import { getSolPrice } from '../services/jupiter.js';

/**
 * Manage the long position for a given token.
 *
 * Logic:
 *   1. Check if we have accumulated SOL in the position fund (from fee splits).
 *   2. If so, open or add to an existing long position on Drift.
 *   3. Apply risk limits: reserve 20% as cash buffer.
 *   4. Take profit if PnL exceeds thresholds.
 *   5. Reduce position if drawdown triggers hit.
 */
export async function managePositionForToken(mint) {
  logger.info('Managing position', { mint });

  try {
    const token = await db.getToken(mint);
    if (!token || token.status !== 'active') {
      logger.warn('Token not active, skipping position management', { mint });
      return null;
    }

    // Get existing position from DB
    let position = await db.getPosition(mint);

    // Calculate available funds from fee splits for this token
    const splits = await db.queryDocs('splits', [['tokenMint', '==', mint]], 'runId', 200);
    const totalPositionFund = splits.reduce((sum, s) => sum + (s.positionAmount || 0), 0);

    // Amount already deployed
    const deployedAmount = position?.deployedSol || 0;
    const availableToDeployRaw = totalPositionFund - deployedAmount;

    // Reserve 20% as cash buffer
    const reserveAmount = availableToDeployRaw * config.RISK.reservePct;
    const availableToDeploy = Math.max(0, availableToDeployRaw - reserveAmount);

    if (availableToDeploy < 0.01) {
      logger.debug('Insufficient funds to deploy', { mint, availableToDeploy });
      return null;
    }

    // Get the Drift market index for this token's underlying
    const marketIndex = config.DRIFT_MARKET_INDICES[token.underlying] ?? token.driftMarketIndex ?? 0;

    // Check current on-chain position PnL
    const pnlInfo = await drift.getPositionPnl(marketIndex);

    // Drawdown check — if losing more than maxDrawdown, reduce
    if (pnlInfo.exists && pnlInfo.entry > 0) {
      const drawdownPct = Math.abs(Math.min(0, pnlInfo.pnl)) / (pnlInfo.entry * Math.abs(pnlInfo.size));
      if (drawdownPct >= config.RISK.maxDrawdownPct) {
        logger.warn('Max drawdown hit — reducing position', { mint, drawdownPct });
        const reduceResult = await drift.reducePosition(marketIndex, 0.5); // Reduce 50%
        if (reduceResult) {
          await db.setPosition(mint, {
            ...position,
            deployedSol: deployedAmount * 0.5,
            lastAction: 'drawdown-reduce',
            lastActionAt: Date.now(),
            pnl: pnlInfo.pnl,
          });
        }
        return { action: 'drawdown-reduce', txSig: reduceResult?.txSig };
      }
    }

    // Take profit if PnL > 30% of deployed
    if (pnlInfo.exists && pnlInfo.pnl > deployedAmount * 0.3 && deployedAmount > 0) {
      logger.info('Taking profit', { mint, pnl: pnlInfo.pnl });
      const reduceResult = await drift.reducePosition(marketIndex, 0.25); // Take 25% off
      if (reduceResult) {
        await db.setPosition(mint, {
          ...position,
          deployedSol: deployedAmount * 0.75,
          lastAction: 'take-profit',
          lastActionAt: Date.now(),
          pnl: pnlInfo.pnl,
        });
      }
      return { action: 'take-profit', txSig: reduceResult?.txSig };
    }

    // Open or add to position
    // Convert SOL to USD using real Jupiter price
    const solPrice = await getSolPrice();
    if (solPrice <= 0) {
      logger.warn('Could not fetch SOL price, skipping position management', { mint });
      return null;
    }
    const sizeUsd = availableToDeploy * solPrice;

    logger.info('Opening/adding to long position', {
      mint,
      marketIndex,
      sizeUsd,
      availableSol: availableToDeploy,
    });

    const result = await drift.openLong(marketIndex, sizeUsd);

    // Update position record
    await db.setPosition(mint, {
      tokenMint: mint,
      side: 'long',
      marketIndex,
      deployedSol: deployedAmount + availableToDeploy,
      lastAddSol: availableToDeploy,
      lastAction: position ? 'add' : 'open',
      lastActionAt: Date.now(),
      entry: pnlInfo.entry || 0,
      pnl: pnlInfo.pnl || 0,
    });

    logger.info('Position updated', { mint, action: position ? 'add' : 'open', txSig: result.txSig });
    return { action: position ? 'add' : 'open', txSig: result.txSig };
  } catch (err) {
    logger.error('Position management failed', { mint, error: err.message, stack: err.stack });
    return null;
  }
}

/**
 * Run position management for ALL active tokens.
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
