import config from '../config.js';
import logger from '../utils/logger.js';
import { getConnection } from './solana.js';

// ---------------------------------------------------------------------------
// Drift SDK wrapper
//
// The actual @drift-labs/sdk initialisation is deferred because it requires
// a live Solana connection + wallet.  All methods gracefully handle init
// failures so the rest of the backend can still run if Drift is unavailable.
// ---------------------------------------------------------------------------

let _driftClient = null;
let _initPromise = null;

async function ensureDrift() {
  if (_driftClient) return _driftClient;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const driftSdk = await import('@drift-labs/sdk');
      const conn = getConnection();

      if (!config.protocolKeypair) {
        throw new Error('Protocol keypair not loaded — cannot init Drift');
      }

      const wallet = new driftSdk.Wallet(config.protocolKeypair);

      // Try to initialize — API varies by SDK version
      let client;
      if (typeof driftSdk.DriftClient === 'function') {
        const sdkConfig = driftSdk.initialize({ env: config.DRIFT_ENV });
        client = new driftSdk.DriftClient({
          connection: conn,
          wallet,
          programID: sdkConfig.DRIFT_PROGRAM_ID,
          env: config.DRIFT_ENV,
        });
      } else {
        throw new Error('DriftClient not found in SDK exports');
      }

      await client.subscribe();
      _driftClient = client;
      logger.info('Drift client initialised', { env: config.DRIFT_ENV });
      return client;
    } catch (err) {
      logger.error('Drift SDK init failed', { error: err.message });
      _initPromise = null;
      throw err;
    }
  })();

  return _initPromise;
}

// ---------------------------------------------------------------------------
// Position management
// ---------------------------------------------------------------------------

/**
 * Open a market long position on a given perp market.
 *
 * @param {number} marketIndex  — Drift perp market index
 * @param {number} sizeUsd     — notional size in USD
 * @returns {{ txSig: string }}
 */
export async function openLong(marketIndex, sizeUsd) {
  try {
    const client = await ensureDrift();
    const { PositionDirection, OrderType, BN } = await import('@drift-labs/sdk');

    const baseAssetAmount = new BN(Math.round(sizeUsd * 1e6)); // USDC precision

    const txSig = await client.openPosition(
      PositionDirection.LONG,
      baseAssetAmount,
      marketIndex,
      undefined, // price — market order
    );

    logger.info('Drift long opened', { marketIndex, sizeUsd, txSig });
    return { txSig };
  } catch (err) {
    logger.error('openLong failed', { marketIndex, sizeUsd, error: err.message });
    throw err;
  }
}

/**
 * Close a position on a given perp market.
 */
export async function closePosition(marketIndex) {
  try {
    const client = await ensureDrift();

    const txSig = await client.closePosition(marketIndex);
    logger.info('Drift position closed', { marketIndex, txSig });
    return { txSig };
  } catch (err) {
    logger.error('closePosition failed', { marketIndex, error: err.message });
    throw err;
  }
}

/**
 * Reduce position by a given percentage (0-1).
 */
export async function reducePosition(marketIndex, pct) {
  try {
    const client = await ensureDrift();
    const user = client.getUser();
    const position = user.getPerpPosition(marketIndex);

    if (!position) {
      logger.warn('No position to reduce', { marketIndex });
      return null;
    }

    const { BN, PositionDirection } = await import('@drift-labs/sdk');
    const reduceAmount = position.baseAssetAmount.abs().muln(Math.round(pct * 100)).divn(100);

    const direction = position.baseAssetAmount.isNeg()
      ? PositionDirection.LONG
      : PositionDirection.SHORT;

    const txSig = await client.openPosition(
      direction,
      reduceAmount,
      marketIndex,
    );

    logger.info('Drift position reduced', { marketIndex, pct, txSig });
    return { txSig };
  } catch (err) {
    logger.error('reducePosition failed', { marketIndex, pct, error: err.message });
    throw err;
  }
}

/**
 * Get current PnL for a perp market position.
 */
export async function getPositionPnl(marketIndex) {
  try {
    const client = await ensureDrift();
    const user = client.getUser();
    const position = user.getPerpPosition(marketIndex);

    if (!position) {
      return { exists: false, pnl: 0, size: 0, entry: 0 };
    }

    const unrealizedPnl = user.getUnrealizedPNL(false, marketIndex);
    const entryPrice = position.entryPrice?.toNumber() / 1e6 || 0;
    const size = position.baseAssetAmount?.toNumber() / 1e9 || 0;

    return {
      exists: true,
      pnl: unrealizedPnl.toNumber() / 1e6,
      size,
      entry: entryPrice,
      marketIndex,
    };
  } catch (err) {
    logger.error('getPositionPnl failed', { marketIndex, error: err.message });
    return { exists: false, pnl: 0, size: 0, entry: 0, error: err.message };
  }
}

/**
 * Get the free collateral (USDC) available in the Drift sub-account.
 */
export async function getFreeCollateral() {
  try {
    const client = await ensureDrift();
    const user = client.getUser();
    const fc = user.getFreeCollateral();
    return fc.toNumber() / 1e6;
  } catch (err) {
    logger.error('getFreeCollateral failed', { error: err.message });
    return 0;
  }
}

/**
 * Gracefully shut down the Drift client.
 */
export async function shutdown() {
  if (_driftClient) {
    try {
      await _driftClient.unsubscribe();
      logger.info('Drift client unsubscribed');
    } catch (err) {
      logger.warn('Drift shutdown error', { error: err.message });
    }
    _driftClient = null;
    _initPromise = null;
  }
}
