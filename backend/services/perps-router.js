import config from '../config.js';
import logger from '../utils/logger.js';
import * as jupiterPerps from './jupiter-perps.js';
import * as flashPerps from './flash-perps.js';
import { getSolBalance } from './solana.js';

// ---------------------------------------------------------------------------
// Perps Router
//
// Routes perps calls to the correct provider based on market symbol:
//   - SOL, BTC, ETH → Jupiter Perps
//   - Everything else → Flash Trade
//
// Exports the same interface as jupiter-perps.js so position-manager
// and risk-manager can import from here without code changes.
// ---------------------------------------------------------------------------

/**
 * Determine which provider handles a given market.
 * @param {string} market — asset symbol (SOL, BONK, etc.)
 * @returns {'jupiter' | 'flash' | null}
 */
export function getProvider(market) {
  const m = market?.toUpperCase();
  if (!m) return null;

  if (config.JUPITER_MARKETS.includes(m)) return 'jupiter';
  if (config.FLASH_MARKETS.includes(m)) return 'flash';
  return null;
}

/**
 * Get max leverage for a market based on its provider.
 */
export function getMaxLeverage(market) {
  const provider = getProvider(market);
  if (provider === 'jupiter') return 250;
  if (provider === 'flash') return 100;
  return 100; // default
}

/**
 * Open or add to a position. Routes to correct provider.
 */
export async function openPosition(market, sizeUsd, collateralSol, side = 'long') {
  const provider = getProvider(market);

  if (!provider) {
    logger.error('No perps provider for market', { market });
    return { success: false, error: `Unsupported market: ${market}` };
  }

  logger.info('Routing openPosition', { market, provider, side, sizeUsd });

  if (provider === 'jupiter') {
    return jupiterPerps.openPosition(market, sizeUsd, collateralSol, side);
  }
  return flashPerps.openPosition(market, sizeUsd, collateralSol, side);
}

/**
 * Close a position. Routes to correct provider.
 */
export async function closePosition(market, side = 'long') {
  const provider = getProvider(market);

  if (!provider) {
    return { success: false, error: `Unsupported market: ${market}` };
  }

  logger.info('Routing closePosition', { market, provider, side });

  if (provider === 'jupiter') {
    return jupiterPerps.closePosition(market);
  }
  return flashPerps.closePosition(market, side);
}

/**
 * Reduce a position by a percentage. Routes to correct provider.
 * Flash Trade doesn't support partial reduces natively — falls back to
 * closing the full position if reduction is >= 50%.
 */
export async function reducePosition(market, pct, side = 'long') {
  const provider = getProvider(market);

  if (!provider) {
    logger.error('No perps provider for market (reducePosition)', { market });
    return null;
  }

  logger.info('Routing reducePosition', { market, provider, side, pct });

  if (provider === 'jupiter') {
    return jupiterPerps.reducePosition(market, pct);
  }

  // Flash Trade: no partial reduce API — close the full position on large reductions
  if (pct >= 0.5) {
    logger.warn('Flash Trade does not support partial reduces — closing full position', { market, pct });
    return flashPerps.closePosition(market, side);
  }

  // For small reductions on Flash, log and skip (position stays open)
  logger.info('Flash Trade: skipping small reduction (no partial reduce support)', { market, pct });
  return null;
}

/**
 * Get position PnL. Routes to correct provider.
 */
export async function getPositionPnl(market, side = 'long') {
  const provider = getProvider(market);

  if (!provider) {
    return { exists: false, pnl: 0, size: 0, entry: 0, error: `Unsupported market: ${market}` };
  }

  if (provider === 'jupiter') {
    return jupiterPerps.getPositionPnl(market);
  }
  return flashPerps.getPositionPnl(market, side);
}

/**
 * Get free collateral (wallet SOL balance as proxy).
 */
export async function getFreeCollateral() {
  try {
    if (!config.PROTOCOL_PUBKEY) return 0;
    return await getSolBalance(config.PROTOCOL_PUBKEY);
  } catch (err) {
    logger.error('getFreeCollateral failed', { error: err.message });
    return 0;
  }
}

/**
 * Shutdown — clean up connections.
 */
export async function shutdown() {
  await jupiterPerps.shutdown();
}

