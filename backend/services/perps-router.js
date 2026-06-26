import config from '../config.js';
import logger from '../utils/logger.js';
import * as jupiterPerps from './jupiter-perps.js';
import * as flashPerps from './flash-perps.js';

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
