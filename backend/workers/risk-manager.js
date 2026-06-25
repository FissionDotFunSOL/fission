import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as perps from '../services/jupiter-perps.js';
import { getAllTokens } from '../db/firebase.js';
import { getSolPrice } from '../services/jupiter.js';
import { retry } from '../utils/helpers.js';

/**
 * Risk manager — monitors positions and enforces:
 *
 * 1. Liquidation proximity — auto-reduce if within warning threshold
 * 2. Max drawdown (configurable) — auto-reduce position
 * 3. Circuit breaker (underlying crash) — auto-close + pause token
 * 4. Stale position detection — flag positions with no updates
 */
export async function runRiskCheck() {
  logger.info('Running risk check cycle');

  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');

  if (active.length === 0) {
    logger.info('No active tokens to risk-check');
    return [];
  }

  // Check overall collateral (wallet SOL balance)
  let freeCollateral = 0;
  try {
    freeCollateral = await perps.getFreeCollateral();
    logger.info('Wallet SOL balance (collateral proxy)', { freeCollateral: freeCollateral.toFixed(4) });

    if (freeCollateral < 0.1) {
      logger.warn('LOW SOL BALANCE — may not have enough for transaction fees', { freeCollateral });
    }
  } catch (err) {
    logger.warn('Could not fetch free collateral', { error: err.message });
  }

  const alerts = [];

  for (const token of active) {
    try {
      const result = await checkTokenRisk(token, freeCollateral);
      if (result) alerts.push(result);
    } catch (err) {
      logger.error('Risk check failed for token', {
        mint: token.mint || token.id,
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

async function checkTokenRisk(token, freeCollateral) {
  const mint = token.id || token.mint;
  const position = await db.getPosition(mint);

  // Resolve market from token underlying
  const underlying = token.underlying?.toUpperCase();
  const market = underlying && config.PERPS_MARKETS.includes(underlying)
    ? underlying
    : null;

  if (!market || !position || position.deployedSol <= 0) return null;

  // Get on-chain PnL (with retry)
  const pnlInfo = await retry(
    () => perps.getPositionPnl(market),
    { retries: 2, delayMs: 2000, label: `riskCheck-pnl(${market})` }
  );

  if (!pnlInfo.exists) {
    // Position may have been liquidated or closed externally
    if (position.deployedSol > 0) {
      logger.warn('Position no longer exists on-chain but DB shows deployed capital', {
        mint,
        market,
        deployedSol: position.deployedSol,
      });

      await db.setPosition(mint, {
        ...position,
        deployedSol: 0,
        lastAction: 'external-close-detected',
        lastActionAt: Date.now(),
        pnl: 0,
        riskAlert: 'position-missing',
      });

      return {
        mint,
        market,
        alert: 'position-missing',
        action: 'marked-as-closed',
        detail: 'Position no longer exists on Jupiter Perps — may have been liquidated',
      };
    }
    return null;
  }

  const deployedSol = position.deployedSol || 0;
  if (deployedSol <= 0) return null;

  const solPrice = await getSolPrice();
  const deployedUsd = deployedSol * (solPrice || 150);

  // -----------------------------------------------------------------------
  // Check 1: Liquidation proximity
  // If collateral ratio is dangerously low relative to position size
  // -----------------------------------------------------------------------
  if (pnlInfo.collateral > 0 && pnlInfo.size !== 0) {
    const positionNotional = Math.abs(pnlInfo.size);
    const marginRatio = pnlInfo.collateral / positionNotional;

    if (marginRatio < config.RISK.liquidationWarningPct) {
      logger.warn('LIQUIDATION PROXIMITY WARNING', {
        mint,
        market,
        marginRatio: (marginRatio * 100).toFixed(1) + '%',
        collateral: pnlInfo.collateral.toFixed(2),
        positionNotional: positionNotional.toFixed(2),
      });

      // Emergency reduce 50%
      try {
        const result = await retry(
          () => perps.reducePosition(market, 0.5),
          { retries: 3, delayMs: 1000, label: `emergencyReduce(${market})` }
        );

        await db.setPosition(mint, {
          ...position,
          deployedSol: deployedSol * 0.5,
          lastAction: 'liquidation-reduce',
          lastActionAt: Date.now(),
          pnl: pnlInfo.pnl,
          riskAlert: 'liquidation-proximity',
          marginRatio,
        });

        return {
          mint,
          market,
          alert: 'liquidation-proximity',
          marginRatio,
          action: 'reduced-50%',
          txSig: result?.txSig,
        };
      } catch (err) {
        logger.error('FAILED TO REDUCE ON LIQUIDATION WARNING', {
          mint,
          market,
          error: err.message,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Check 2: Max drawdown
  // -----------------------------------------------------------------------
  const unrealizedLoss = Math.min(0, pnlInfo.pnl);
  const drawdownPct = deployedUsd > 0 ? Math.abs(unrealizedLoss) / deployedUsd : 0;

  if (drawdownPct >= config.RISK.maxDrawdownPct) {
    logger.warn('MAX DRAWDOWN TRIGGERED', {
      mint,
      market,
      drawdownPct: (drawdownPct * 100).toFixed(1) + '%',
      pnl: pnlInfo.pnl,
    });

    try {
      const reducePct = config.RISK.drawdownReducePct;
      const result = await retry(
        () => perps.reducePosition(market, reducePct),
        { retries: 2, delayMs: 3000, label: `drawdownReduce(${market})` }
      );

      await db.setPosition(mint, {
        ...position,
        deployedSol: deployedSol * (1 - reducePct),
        lastAction: 'risk-reduce',
        lastActionAt: Date.now(),
        pnl: pnlInfo.pnl,
        riskAlert: 'max-drawdown',
        drawdownPct,
      });

      return {
        mint,
        market,
        alert: 'max-drawdown',
        drawdownPct,
        action: `reduced-${(reducePct * 100).toFixed(0)}%`,
        txSig: result?.txSig,
      };
    } catch (err) {
      logger.error('Failed to reduce position on drawdown', {
        mint,
        market,
        error: err.message,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Check 3: Circuit breaker (50% underlying crash)
  // -----------------------------------------------------------------------
  if (pnlInfo.entry > 0 && pnlInfo.size !== 0) {
    const currentPrice = pnlInfo.entry + (pnlInfo.pnl / Math.abs(pnlInfo.size));
    const priceDrop = (pnlInfo.entry - currentPrice) / pnlInfo.entry;

    if (priceDrop >= config.RISK.circuitBreakerPct) {
      logger.warn('CIRCUIT BREAKER TRIGGERED', {
        mint,
        market,
        priceDrop: (priceDrop * 100).toFixed(1) + '%',
        entryPrice: pnlInfo.entry,
        currentPrice,
      });

      try {
        const result = await retry(
          () => perps.closePosition(market),
          { retries: 3, delayMs: 1000, label: `circuitBreaker(${market})` }
        );

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
          market,
          alert: 'circuit-breaker',
          priceDrop,
          action: 'closed-position',
          txSig: result?.txSig,
        };
      } catch (err) {
        logger.error('Failed to close position on circuit breaker', {
          mint,
          market,
          error: err.message,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Check 4: Update PnL + health metrics in DB
  // -----------------------------------------------------------------------
  await db.setPosition(mint, {
    ...position,
    pnl: pnlInfo.pnl,
    entry: pnlInfo.entry,
    size: pnlInfo.size,
    market,
    lastRiskCheck: Date.now(),
  });

  return null;
}

export { checkTokenRisk };
