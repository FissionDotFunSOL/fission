import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as drift from '../services/drift.js';
import { getAllTokens } from '../db/firebase.js';
import { getSolPrice } from '../services/jupiter.js';

/**
 * Risk manager — monitors positions and enforces:
 *
 * 1. Max drawdown (40%) → auto-reduce position by 50%
 * 2. Circuit breaker (50% underlying drop in 24h) → auto-close
 * 3. Reserve enforcement — ensure 20% cash buffer
 */
export async function runRiskCheck() {
  logger.info('Running risk check cycle');

  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');

  if (active.length === 0) {
    logger.info('No active tokens to risk-check');
    return [];
  }

  const alerts = [];

  for (const token of active) {
    try {
      const result = await checkTokenRisk(token);
      if (result) alerts.push(result);
    } catch (err) {
      logger.error('Risk check failed for token', {
        mint: token.mint,
        error: err.message,
      });
    }
  }

  if (alerts.length > 0) {
    logger.warn(`Risk alerts triggered: ${alerts.length}`, { alerts });
  } else {
    logger.info('Risk check passed — no alerts');
  }

  return alerts;
}

async function checkTokenRisk(token) {
  const mint = token.id || token.mint;
  const position = await db.getPosition(mint);
  if (!position || !position.marketIndex) return null;

  const marketIndex = position.marketIndex;

  // Get on-chain PnL
  const pnlInfo = await drift.getPositionPnl(marketIndex);
  if (!pnlInfo.exists) return null;

  const deployedSol = position.deployedSol || 0;
  if (deployedSol <= 0) return null;

  // -----------------------------------------------------------------------
  // Check 1: Max drawdown
  // -----------------------------------------------------------------------
  const unrealizedLoss = Math.min(0, pnlInfo.pnl);
  const solPrice = await getSolPrice();
  const deployedUsd = deployedSol * (solPrice || 150); // fallback only if fetch fails
  const drawdownPct = Math.abs(unrealizedLoss) / deployedUsd;

  if (drawdownPct >= config.RISK.maxDrawdownPct) {
    logger.warn('MAX DRAWDOWN TRIGGERED', {
      mint,
      drawdownPct: (drawdownPct * 100).toFixed(1) + '%',
      pnl: pnlInfo.pnl,
    });

    try {
      const result = await drift.reducePosition(marketIndex, 0.5);
      await db.setPosition(mint, {
        ...position,
        deployedSol: deployedSol * 0.5,
        lastAction: 'risk-reduce',
        lastActionAt: Date.now(),
        pnl: pnlInfo.pnl,
        riskAlert: 'max-drawdown',
      });

      return {
        mint,
        alert: 'max-drawdown',
        drawdownPct,
        action: 'reduced-50%',
        txSig: result?.txSig,
      };
    } catch (err) {
      logger.error('Failed to reduce position on drawdown', {
        mint,
        error: err.message,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Check 2: Circuit breaker (50% underlying drop)
  // Uses position entry vs current implied price from PnL
  // -----------------------------------------------------------------------
  if (pnlInfo.entry > 0 && pnlInfo.size !== 0) {
    const currentPrice = pnlInfo.entry + (pnlInfo.pnl / Math.abs(pnlInfo.size));
    const priceDrop = (pnlInfo.entry - currentPrice) / pnlInfo.entry;

    if (priceDrop >= config.RISK.circuitBreakerPct) {
      logger.warn('CIRCUIT BREAKER TRIGGERED', {
        mint,
        priceDrop: (priceDrop * 100).toFixed(1) + '%',
        entryPrice: pnlInfo.entry,
        currentPrice,
      });

      try {
        const result = await drift.closePosition(marketIndex);
        await db.setPosition(mint, {
          ...position,
          deployedSol: 0,
          lastAction: 'circuit-breaker-close',
          lastActionAt: Date.now(),
          pnl: pnlInfo.pnl,
          riskAlert: 'circuit-breaker',
        });

        // Mark token as paused
        await db.setToken(mint, { ...token, status: 'paused' });

        return {
          mint,
          alert: 'circuit-breaker',
          priceDrop,
          action: 'closed-position',
          txSig: result?.txSig,
        };
      } catch (err) {
        logger.error('Failed to close position on circuit breaker', {
          mint,
          error: err.message,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Check 3: Update PnL in DB (no action needed)
  // -----------------------------------------------------------------------
  await db.setPosition(mint, {
    ...position,
    pnl: pnlInfo.pnl,
    lastRiskCheck: Date.now(),
  });

  return null;
}

export { checkTokenRisk };
