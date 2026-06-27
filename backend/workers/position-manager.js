import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as perps from '../services/perps-router.js';
import { getAllTokens } from '../db/firebase.js';
import { getSolPrice } from '../services/jupiter.js';
import { getSolBalance } from '../services/solana.js';
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

    // Amount already deployed
    const deployedAmount = position?.deployedSol || 0;

    // Resolve market — check against all supported perps markets (Jupiter + Flash)
    const underlying = token.underlying?.toUpperCase();
    const market = underlying && config.ALL_PERPS_MARKETS.includes(underlying)
      ? underlying
      : null;

    if (!market) {
      logger.warn('No perps market available for token, skipping', { mint, underlying: token.underlying });
      return null;
    }

    // Simple momentum check — only open long if price is trending up
    const direction = token.side || 'long';
    if (direction === 'long' && deployedAmount === 0) {
      try {
        const currentPrice = await getSolPrice();
        // Wait 5s and check again for micro-trend
        await new Promise(r => setTimeout(r, 5000));
        const secondPrice = await getSolPrice();
        if (secondPrice < currentPrice * 0.999) {
          logger.info('Momentum check: price dipping, waiting for better entry', {
            mint, market, priceBefore: currentPrice.toFixed(2), priceAfter: secondPrice.toFixed(2),
          });
          return null;
        }
        logger.info('Momentum check passed', {
          mint, market, priceBefore: currentPrice.toFixed(2), priceAfter: secondPrice.toFixed(2),
        });
      } catch (momErr) {
        logger.warn('Momentum check failed (proceeding)', { error: momErr.message });
      }
    }

    // Use wallet balance directly instead of splits accounting
    const walletBalance = await getSolBalance(config.PROTOCOL_PUBKEY);
    const minBalance = config.RISK.minWalletBalanceSol;
    const totalAvailable = Math.max(0, walletBalance - minBalance);

    // Divide available SOL among active tokens that need deployment
    const allTokens = await db.getAllTokens();
    const activeCount = allTokens.filter(t => t.status === 'active').length || 1;
    const perTokenMax = totalAvailable / activeCount;
    const availableToDeploy = Math.max(0, perTokenMax - deployedAmount);

    // Check current on-chain position PnL (with retry for RPC reliability)
    const pnlInfo = await retry(
      () => perps.getPositionPnl(market),
      { retries: 2, delayMs: 2000, label: `getPositionPnl(${market})` }
    );

    // -----------------------------------------------------------------------
    // Proportional PnL: multiple tokens may share the same on-chain market.
    // We track each token's share of the total deployed capital and allocate
    // PnL proportionally so each token gets accurate reporting.
    // -----------------------------------------------------------------------
    if (pnlInfo.exists && deployedAmount > 0) {
      // Find all tokens that share this market + side combination
      const allTokens = await db.getAllTokens();
      const allPositions = await db.getAllPositions();
      const sameMarketPositions = allPositions.filter(p =>
        p.market === market && p.side === (token.side || 'long') && (p.deployedSol || 0) > 0
      );
      const totalDeployedForMarket = sameMarketPositions.reduce((sum, p) => sum + (p.deployedSol || 0), 0);

      // This token's share of the on-chain position
      const share = totalDeployedForMarket > 0 ? deployedAmount / totalDeployedForMarket : 1;
      const proportionalPnl = (pnlInfo.pnl || 0) * share;

      // Update position with proportional PnL
      await db.setPosition(mint, {
        ...position,
        tokenMint: mint,
        pnl: proportionalPnl,
        totalPnl: pnlInfo.pnl || 0,
        share: share,
        entry: pnlInfo.entry || position?.entry || 0,
        updatedAt: Date.now(),
      });
    }

    // -----------------------------------------------------------------------
    // Profit-Taking: reduce position and route to buyback when profitable
    // Triggers at earlyTakeProfitPct (default 20% gain on deployed capital)
    // -----------------------------------------------------------------------
    if (pnlInfo.exists && deployedAmount > 0) {
      const solPrice = await getSolPrice();
      const deployedUsd = deployedAmount * (solPrice || 150);
      const proportionalPnl = position?.pnl || 0;

      // Check if PnL exceeds early take-profit threshold
      const gainPct = deployedUsd > 0 ? proportionalPnl / deployedUsd : 0;
      const tpThreshold = config.RISK.earlyTakeProfitPct;

      if (gainPct >= tpThreshold && proportionalPnl > 0) {
        const reducePct = config.RISK.takeProfitReducePct;
        logger.info('TAKE PROFIT triggered', {
          mint,
          market: market || token.underlying,
          gainPct: (gainPct * 100).toFixed(1) + '%',
          threshold: (tpThreshold * 100).toFixed(0) + '%',
          proportionalPnl: proportionalPnl.toFixed(2),
          reducePct: (reducePct * 100).toFixed(0) + '%',
        });

        try {
          const tpResult = await retry(
            () => perps.reducePosition(market, reducePct, token.side || 'long'),
            { retries: 2, delayMs: 3000, label: `takeProfit(${market})` }
          );

          const newDeployed = deployedAmount * (1 - reducePct);
          const freedSol = deployedAmount * reducePct;

          // Update position record
          await db.setPosition(mint, {
            ...position,
            tokenMint: mint,
            deployedSol: newDeployed,
            lastAction: 'take-profit',
            lastActionAt: Date.now(),
            pnl: proportionalPnl * (1 - reducePct),
          });

          // Record take-profit splits: 70% → source token buyback, 30% → FISSION buyback
          const sourceTokenSol = freedSol * config.PROFIT_SPLIT.sourceToken;
          const fissionSol = freedSol * config.PROFIT_SPLIT.fission;

          await db.addDoc('splits', {
            tokenMint: mint,
            runId: `tp-${Date.now()}`,
            type: 'take-profit-source',
            totalSol: sourceTokenSol,
            positionAmount: 0,
            buybackAmount: 0,
            sourceTokenBuyback: sourceTokenSol, // 70% → buy back this token
            timestamp: Date.now(),
          });

          await db.addDoc('splits', {
            tokenMint: mint,
            runId: `tp-fission-${Date.now()}`,
            type: 'take-profit-fission',
            totalSol: fissionSol,
            positionAmount: 0,
            buybackAmount: fissionSol, // 30% → buy back FISSION
            sourceTokenBuyback: 0,
            timestamp: Date.now(),
          });

          logger.info('Take profit executed', {
            mint,
            market,
            freedSol: freedSol.toFixed(6),
            txSig: tpResult?.txSig,
          });

          // Return early — don't open new position in same cycle as take-profit
          return { action: 'take-profit', txSig: tpResult?.txSig, freedSol };
        } catch (err) {
          logger.error('Take profit failed', { mint, market, error: err.message });
        }
      }
    }

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
    // Check 2: Wallet gas buffer — already computed above
    // -----------------------------------------------------------------------
    const maxDeployable = totalAvailable;

    if (maxDeployable <= 0) {
      logger.warn('Wallet balance too low for gas fees, skipping deployment', {
        mint,
        walletBalance: walletBalance.toFixed(4),
        minBalance,
      });
      return null;
    }

    // -----------------------------------------------------------------------
    // Check 3: Max position cap
    // -----------------------------------------------------------------------
    let deployAmount = Math.min(
      availableToDeploy,
      config.RISK.maxPositionSol - deployedAmount,
      maxDeployable  // never exceed what the wallet can safely give
    );

    if (deployAmount <= 0) {
      logger.info('Position at max cap or wallet gas limit reached', {
        mint,
        deployedAmount,
        maxPositionSol: config.RISK.maxPositionSol,
        walletBalance: walletBalance.toFixed(4),
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
    const leverage = token.leverage || config.RISK.leverage || 100;
    // Cap leverage for Flash Trade markets (max 100x)
    const maxLev = perps.getMaxLeverage(market);
    const effectiveLeverage = Math.min(leverage, maxLev);
    const sizeUsd = collateralUsd * effectiveLeverage;

    // Minimum $100 position size — no tiny trades
    if (sizeUsd < 100) {
      logger.info('Position size too small, waiting for more funds', {
        mint, sizeUsd: sizeUsd.toFixed(2), collateralSol: deployAmount.toFixed(4),
      });
      return null;
    }

    // Token can be configured as long or short
    // direction already declared above

    logger.info('Opening/adding to position', {
      mint,
      market,
      direction,
      leverage: `${effectiveLeverage}x`,
      collateralSol: deployAmount.toFixed(6),
      collateralUsd: collateralUsd.toFixed(2),
      sizeUsd: sizeUsd.toFixed(2),
      totalDeployed: (deployedAmount + deployAmount).toFixed(6),
      walletBalanceAfter: (walletBalance - deployAmount).toFixed(4),
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
      leverage: effectiveLeverage,
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

/**
 * Fast profit check for ALL active tokens.
 * Runs every 60-90s. Only checks on-chain PnL and takes profits.
 * Does NOT open new positions or deploy capital.
 * Critical for high-leverage positions (250x) where profit windows are seconds.
 */
export async function checkProfitsAllTokens() {
  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');

  if (active.length === 0) return [];

  const results = [];
  for (const token of active) {
    const mint = token.id || token.mint;
    try {
      const result = await checkAndTakeProfit(mint, token);
      if (result) results.push({ mint, ...result });
    } catch (err) {
      logger.error('Profit check failed', { mint, error: err.message });
    }
  }

  if (results.length > 0) {
    logger.info(`Profit check: ${results.length} actions taken`);
  }
  return results;
}

/**
 * Check a single token's position for profit-taking opportunity.
 */
async function checkAndTakeProfit(mint, token) {
  const position = await db.getPosition(mint);
  if (!position || !position.deployedSol || position.deployedSol <= 0) return null;

  const underlying = token.underlying?.toUpperCase();
  const market = underlying && config.ALL_PERPS_MARKETS.includes(underlying)
    ? underlying : null;
  if (!market) return null;

  // Fetch live on-chain PnL
  const pnlInfo = await perps.getPositionPnl(market, token.side || 'long');
  if (!pnlInfo.exists) {
    // Position gone — likely liquidated
    if (position.deployedSol > 0) {
      await db.setPosition(mint, {
        ...position,
        deployedSol: 0,
        lastAction: 'liquidated-detected',
        lastActionAt: Date.now(),
        pnl: 0,
        riskAlert: 'position-missing',
      });
      logger.warn('Position liquidated (fast check)', { mint, market, deployedSol: position.deployedSol });
    }
    return null;
  }

  // Update DB with live PnL
  const deployedAmount = position.deployedSol;
  const solPrice = await getSolPrice().catch(() => 0);
  
  // Fallback price if Jupiter rate-limited
  let currentSolPrice = solPrice;
  if (!currentSolPrice || currentSolPrice <= 0) {
    try {
      const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      if (cgRes.ok) {
        const cgData = await cgRes.json();
        currentSolPrice = cgData?.solana?.usd || 0;
      }
    } catch {}
  }

  const deployedUsd = deployedAmount * (currentSolPrice || 150);
  const unrealisedPnl = pnlInfo.pnl || 0;

  // Update position with latest PnL
  await db.setPosition(mint, {
    ...position,
    pnl: unrealisedPnl,
    entry: pnlInfo.entry || position.entry,
    size: pnlInfo.size,
    lastRiskCheck: Date.now(),
  });

  // Check take-profit threshold
  const gainPct = deployedUsd > 0 ? unrealisedPnl / deployedUsd : 0;
  const tpThreshold = config.RISK.earlyTakeProfitPct;

  if (gainPct >= tpThreshold && unrealisedPnl > 0) {
    const reducePct = config.RISK.takeProfitReducePct;
    logger.info('FAST TAKE PROFIT triggered', {
      mint, market,
      gainPct: (gainPct * 100).toFixed(1) + '%',
      unrealisedPnl: unrealisedPnl.toFixed(2),
      reducePct: (reducePct * 100).toFixed(0) + '%',
    });

    try {
      const tpResult = await retry(
        () => perps.reducePosition(market, reducePct, token.side || 'long'),
        { retries: 2, delayMs: 2000, label: `fastTP(${market})` }
      );

      const freedSol = deployedAmount * reducePct;
      const sourceTokenSol = freedSol * config.PROFIT_SPLIT.sourceToken;
      const fissionSol = freedSol * config.PROFIT_SPLIT.fission;

      await db.setPosition(mint, {
        ...position,
        deployedSol: deployedAmount * (1 - reducePct),
        lastAction: 'fast-take-profit',
        lastActionAt: Date.now(),
        pnl: unrealisedPnl * (1 - reducePct),
      });

      // Record splits for buyback engine
      await db.addDoc('splits', {
        tokenMint: mint, runId: `ftp-${Date.now()}`, type: 'take-profit-source',
        totalSol: sourceTokenSol, positionAmount: 0, buybackAmount: 0,
        sourceTokenBuyback: sourceTokenSol, timestamp: Date.now(),
      });
      await db.addDoc('splits', {
        tokenMint: mint, runId: `ftp-f-${Date.now()}`, type: 'take-profit-fission',
        totalSol: fissionSol, positionAmount: 0, buybackAmount: fissionSol,
        sourceTokenBuyback: 0, timestamp: Date.now(),
      });

      logger.info('Fast take profit executed', {
        mint, market, freedSol: freedSol.toFixed(6), txSig: tpResult?.txSig,
      });

      return { action: 'fast-take-profit', txSig: tpResult?.txSig, freedSol };
    } catch (err) {
      logger.error('Fast take profit failed', { mint, market, error: err.message });
    }
  }

  return null;
}
