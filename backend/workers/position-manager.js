import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as drift from '../services/drift.js';
import { getAllTokens } from '../db/firebase.js';
import { getSolPrice } from '../services/jupiter.js';
import { retry } from '../utils/helpers.js';

/**
 * Manage the long position for a given token.
 *
 * Logic:
 *   1. Check if we have accumulated SOL in the position fund (from fee splits).
 *   2. If so, open or add to an existing long position on Drift.
 *   3. Apply risk limits: reserve cash buffer, max position cap.
 *   4. Take profit if PnL exceeds configurable threshold.
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

    // Reserve cash buffer
    const reserveAmount = availableToDeployRaw * config.RISK.reservePct;
    const availableToDeploy = Math.max(0, availableToDeployRaw - reserveAmount);

    // Get the Drift market index for this token's underlying
    const marketIndex = token.driftMarketIndex
      ?? config.DRIFT_MARKET_INDICES[token.underlying]
      ?? null;

    if (marketIndex === null || marketIndex === undefined) {
      logger.warn('No Drift market index for token, skipping', { mint, underlying: token.underlying });
      return null;
    }

    // Check current on-chain position PnL (with retry for RPC reliability)
    const pnlInfo = await retry(
      () => drift.getPositionPnl(marketIndex),
      { retries: 2, delayMs: 2000, label: `getPositionPnl(${marketIndex})` }
    );

    // -----------------------------------------------------------------------
    // Check 1: Drawdown — if losing more than maxDrawdownPct, reduce
    // -----------------------------------------------------------------------
    if (pnlInfo.exists && pnlInfo.entry > 0) {
      const notionalValue = pnlInfo.entry * Math.abs(pnlInfo.size);
      const drawdownPct = notionalValue > 0
        ? Math.abs(Math.min(0, pnlInfo.pnl)) / notionalValue
        : 0;

      if (drawdownPct >= config.RISK.maxDrawdownPct) {
        const reducePct = config.RISK.drawdownReducePct;
        logger.warn('Max drawdown hit — reducing position', {
          mint,
          drawdownPct: (drawdownPct * 100).toFixed(1) + '%',
          reducePct: (reducePct * 100).toFixed(0) + '%',
        });

        const reduceResult = await retry(
          () => drift.reducePosition(marketIndex, reducePct),
          { retries: 2, delayMs: 3000, label: `reducePosition(drawdown)` }
        );

        if (reduceResult) {
          await db.setPosition(mint, {
            ...position,
            deployedSol: deployedAmount * (1 - reducePct),
            lastAction: 'drawdown-reduce',
            lastActionAt: Date.now(),
            pnl: pnlInfo.pnl,
            drawdownPct,
          });
        }
        return { action: 'drawdown-reduce', drawdownPct, txSig: reduceResult?.txSig };
      }
    }

    // -----------------------------------------------------------------------
    // Check 2: Take profit — if PnL exceeds threshold of deployed capital
    // -----------------------------------------------------------------------
    if (pnlInfo.exists && deployedAmount > 0) {
      const solPrice = await getSolPrice();
      const deployedUsd = deployedAmount * (solPrice || 150);
      const profitPct = deployedUsd > 0 ? pnlInfo.pnl / deployedUsd : 0;

      if (profitPct > config.RISK.takeProfitPct) {
        const reducePct = config.RISK.takeProfitReducePct;
        logger.info('Taking profit', {
          mint,
          pnl: pnlInfo.pnl,
          profitPct: (profitPct * 100).toFixed(1) + '%',
          reducePct: (reducePct * 100).toFixed(0) + '%',
        });

        const reduceResult = await retry(
          () => drift.reducePosition(marketIndex, reducePct),
          { retries: 2, delayMs: 3000, label: `reducePosition(takeProfit)` }
        );

        if (reduceResult) {
          await db.setPosition(mint, {
            ...position,
            deployedSol: deployedAmount * (1 - reducePct),
            lastAction: 'take-profit',
            lastActionAt: Date.now(),
            pnl: pnlInfo.pnl,
            realizedProfit: (position?.realizedProfit || 0) + (pnlInfo.pnl * reducePct),
          });
        }
        return { action: 'take-profit', profitPct, txSig: reduceResult?.txSig };
      }
    }

    // -----------------------------------------------------------------------
    // Check 3: Minimum deploy threshold
    // -----------------------------------------------------------------------
    if (availableToDeploy < config.RISK.minDeploySol) {
      logger.debug('Insufficient funds to deploy', { mint, availableToDeploy });
      return null;
    }

    // -----------------------------------------------------------------------
    // Check 4: Max position cap
    // -----------------------------------------------------------------------
    const totalAfterDeploy = deployedAmount + availableToDeploy;
    const deployAmount = Math.min(availableToDeploy, config.RISK.maxPositionSol - deployedAmount);

    if (deployAmount <= 0) {
      logger.info('Position at max cap, skipping deployment', {
        mint,
        deployedAmount,
        maxPositionSol: config.RISK.maxPositionSol,
      });
      return null;
    }

    // Convert SOL to USD using real Jupiter price
    const solPrice = await getSolPrice();
    if (solPrice <= 0) {
      logger.warn('Could not fetch SOL price, skipping position management', { mint });
      return null;
    }
    const sizeUsd = deployAmount * solPrice;

    logger.info('Opening/adding to long position', {
      mint,
      marketIndex,
      sizeUsd: sizeUsd.toFixed(2),
      deployingSol: deployAmount.toFixed(6),
      totalDeployed: (deployedAmount + deployAmount).toFixed(6),
    });

    // Open/add to position with retry
    const result = await retry(
      () => drift.openLong(marketIndex, sizeUsd),
      { retries: 2, delayMs: 3000, label: `openLong(${marketIndex})` }
    );

    // Update position record
    await db.setPosition(mint, {
      tokenMint: mint,
      side: 'long',
      marketIndex,
      deployedSol: deployedAmount + deployAmount,
      lastAddSol: deployAmount,
      lastAction: position ? 'add' : 'open',
      lastActionAt: Date.now(),
      entry: pnlInfo.entry || 0,
      pnl: pnlInfo.pnl || 0,
    });

    logger.info('Position updated', { mint, action: position ? 'add' : 'open', txSig: result.txSig });
    return { action: position ? 'add' : 'open', txSig: result.txSig, deployedSol: deployAmount };
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
