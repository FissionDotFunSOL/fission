import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as perps from '../services/jupiter-perps.js';
import { getAllTokens } from '../db/firebase.js';
import { getSolPrice, swapSolForToken, burnTokens } from '../services/jupiter.js';
import { getTokenBalance } from '../services/solana.js';
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
          market,
          drawdownPct: (drawdownPct * 100).toFixed(1) + '%',
          reducePct: (reducePct * 100).toFixed(0) + '%',
        });

        const reduceResult = await retry(
          () => perps.reducePosition(market, reducePct),
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
          market,
          pnl: pnlInfo.pnl,
          profitPct: (profitPct * 100).toFixed(1) + '%',
          reducePct: (reducePct * 100).toFixed(0) + '%',
        });

        const reduceResult = await retry(
          () => perps.reducePosition(market, reducePct),
          { retries: 2, delayMs: 3000, label: `reducePosition(takeProfit)` }
        );

        if (reduceResult) {
          // Realized profit in SOL — buyback & burn the creator's token
          const profitSol = (pnlInfo.pnl * reducePct) / (solPrice || 150);
          let burnResult = null;

          if (profitSol > 0.001) {
            try {
              logger.info('Buyback & burn creator token with perp profits', {
                mint, profitSol: profitSol.toFixed(6),
              });
              const swap = await swapSolForToken(mint, profitSol);
              const bal = await getTokenBalance(config.protocolKeypair.publicKey, mint);
              if (bal > 0) {
                const burnSig = await burnTokens(mint, bal);
                burnResult = { swapSig: swap.signature, burnSig, tokensBurned: bal };
                logger.info('Perp profit buyback & burn complete', { mint, tokensBurned: bal });
              }
            } catch (err) {
              logger.error('Profit buyback & burn failed', { mint, error: err.message });
            }
          }

          await db.setPosition(mint, {
            ...position,
            deployedSol: deployedAmount * (1 - reducePct),
            lastAction: 'take-profit-buyback-burn',
            lastActionAt: Date.now(),
            pnl: pnlInfo.pnl,
            realizedProfit: (position?.realizedProfit || 0) + (pnlInfo.pnl * reducePct),
          });
        }
        return { action: 'take-profit-buyback-burn', profitPct, txSig: reduceResult?.txSig };
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
      market,
      sizeUsd: sizeUsd.toFixed(2),
      deployingSol: deployAmount.toFixed(6),
      totalDeployed: (deployedAmount + deployAmount).toFixed(6),
    });

    // Open/add to position with retry
    const result = await retry(
      () => perps.openLong(market, sizeUsd),
      { retries: 2, delayMs: 3000, label: `openLong(${market})` }
    );

    // Update position record
    await db.setPosition(mint, {
      tokenMint: mint,
      side: 'long',
      market,
      deployedSol: deployedAmount + deployAmount,
      lastAddSol: deployAmount,
      lastAction: position ? 'add' : 'open',
      lastActionAt: Date.now(),
      entry: pnlInfo.entry || 0,
      pnl: pnlInfo.pnl || 0,
    });

    logger.info('Position updated', { mint, market, action: position ? 'add' : 'open', txSig: result.txSig });
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
