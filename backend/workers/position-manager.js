import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as perps from '../services/jupiter-perps.js';
import { getAllTokens } from '../db/firebase.js';
import { getSolPrice } from '../services/jupiter.js';
import { retry } from '../utils/helpers.js';

/**
 * Manage the long position for a given token.
 *
 * Logic:
 *   1. Check if we have accumulated SOL in the position fund (from fee splits).
 *   2. If so, open or add to an existing long position on Jupiter Perps.
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

    // Resolve market — Jupiter Perps uses asset symbols (SOL, BTC, ETH)
    const underlying = token.underlying?.toUpperCase();
    const market = underlying && config.PERPS_MARKETS.includes(underlying)
      ? underlying
      : null;

    if (!market) {
      logger.warn('No Jupiter Perps market for token, skipping', { mint, underlying: token.underlying });
      return null;
    }

    // Check current on-chain position PnL (with retry for RPC reliability)
    const pnlInfo = await retry(
      () => perps.getPositionPnl(market),
      { retries: 2, delayMs: 2000, label: `getPositionPnl(${market})` }
    );

    // NOTE: Drawdown, take-profit, and risk checks are handled by risk-manager.js
    // Position-manager only handles opening and adding to positions.

    // -----------------------------------------------------------------------
    // Check 1: Minimum deploy threshold
    // -----------------------------------------------------------------------
    if (availableToDeploy < config.RISK.minDeploySol) {
      logger.debug('Insufficient funds to deploy', { mint, availableToDeploy });
      return null;
    }

    // -----------------------------------------------------------------------
    // Check 4: Max position cap
    // -----------------------------------------------------------------------
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

    // Calculate leveraged position size
    // deployAmount = collateral in SOL
    // sizeUsd = collateralUsd * leverage (what the position is worth after leverage)
    const collateralUsd = deployAmount * solPrice;
    const leverage = config.RISK.leverage || 100;
    const sizeUsd = collateralUsd * leverage;

    // Token can be configured as long or short
    const direction = token.side || 'long';

    logger.info('Opening/adding to position', {
      mint,
      market,
      direction,
      leverage: `${leverage}x`,
      collateralSol: deployAmount.toFixed(6),
      collateralUsd: collateralUsd.toFixed(2),
      sizeUsd: sizeUsd.toFixed(2),
      totalDeployed: (deployedAmount + deployAmount).toFixed(6),
    });

    // Open/add to position with retry — pass collateral + direction
    const result = await retry(
      () => perps.openPosition(market, sizeUsd, deployAmount, direction),
      { retries: 2, delayMs: 3000, label: `openPosition(${market}, ${direction})` }
    );

    // Update position record
    await db.setPosition(mint, {
      tokenMint: mint,
      side: direction,
      market,
      leverage,
      deployedSol: deployedAmount + deployAmount,
      collateralUsd: (deployedAmount + deployAmount) * (solPrice || 150),
      sizeUsd,
      lastAddSol: deployAmount,
      lastAction: position ? 'add' : 'open',
      lastActionAt: Date.now(),
      entry: pnlInfo.entry || 0,
      pnl: pnlInfo.pnl || 0,
    });

    logger.info('Position updated', { mint, market, direction, action: position ? 'add' : 'open', txSig: result.txSig });
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
