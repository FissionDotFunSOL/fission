import config from '../config.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Ostium Perpetuals Service
//
// Ostium (ostium.com) is a permissionless RWA perp DEX on Arbitrum One:
// 33 single-name equities (AAPL, TSLA, NVDA, HOOD, …) plus indices,
// commodities and FX, up to 50x on stocks. No API keys, no waitlist —
// trades are signed by the protocol wallet directly through the official
// @ostium/builder-sdk. Collateral is USDC on Arbitrum, held by the same
// EOA that collects Pons fees on Robinhood Chain.
//
// SDK surface used here:
//   OstiumClient.createSelfAndSelf({ traderPrivateKey, rpcUrl })
//   client.getPairs() / getAllPrices() / getBalances(addr)
//   client.subgraph.getOpenPositions({ user }) / getFills({ user })
//   client.openTrade({ pairId, buy, price, collateral, leverage, type })
//   client.closeTrade({ pairId, idx, price, closePercent })
//   client.approveUsdc('max')  — one-time USDC allowance
// ---------------------------------------------------------------------------

let _client = null;
let _readOnly = null;
let _approvalChecked = false;

async function loadSdk() {
  // Lazy import keeps boot fast and lets the server run without the SDK in
  // pathological environments
  const sdk = await import('@ostium/builder-sdk');
  return sdk;
}

async function getClient() {
  if (_client) return _client;
  const { OstiumClient } = await loadSdk();

  if (config.protocolWallet) {
    _client = await OstiumClient.createSelfAndSelf({
      traderPrivateKey: config.protocolWallet.privateKey,
      rpcUrl: config.ARBITRUM_RPC_URL,
    });
    logger.info('Ostium client created (self-signed)', { trader: config.PROTOCOL_ADDRESS });
  } else {
    _client = await OstiumClient.createReadOnly();
    logger.warn('Ostium client is READ-ONLY (no PROTOCOL_PRIVATE_KEY)');
  }
  return _client;
}

async function getReader() {
  if (_readOnly) return _readOnly;
  if (_client) return _client;
  const { OstiumClient } = await loadSdk();
  _readOnly = await OstiumClient.createReadOnly();
  return _readOnly;
}

// ---------------------------------------------------------------------------
// Pairs — symbol → pairId resolution (cached)
// ---------------------------------------------------------------------------

let _pairsCache = { pairs: null, at: 0 };
const PAIRS_TTL = 5 * 60_000;

export async function getPairs() {
  if (_pairsCache.pairs && Date.now() - _pairsCache.at < PAIRS_TTL) return _pairsCache.pairs;
  try {
    const client = await getReader();
    const res = await client.getPairs();
    const pairs = res?.pairs || res || [];
    if (pairs.length > 0) _pairsCache = { pairs, at: Date.now() };
    return pairs;
  } catch (err) {
    logger.warn('Ostium getPairs failed', { error: err.message });
    return _pairsCache.pairs || [];
  }
}

export async function findPair(market) {
  const pairs = await getPairs();
  const sym = market.toUpperCase();
  return pairs.find(p =>
    (p.pairFrom || '').toUpperCase() === sym &&
    ['USD', 'USDC'].includes((p.pairTo || '').toUpperCase()),
  ) || null;
}

export async function getMidPrice(market) {
  const pair = await findPair(market);
  if (pair?.midPx) return parseFloat(pair.midPx);
  return 0;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

async function fetchOpenPositions() {
  const client = await getReader();
  const user = config.PROTOCOL_ADDRESS;
  const res = client.getOpenPositions
    ? await client.getOpenPositions({ user })
    : await client.subgraph.getOpenPositions({ user });
  return (res?.pairPositions || []).map(pp => pp.position).filter(Boolean);
}

/**
 * Get current position data for a given market.
 * Returns the shape the workers expect:
 *   { exists, pnl, size, entry, collateralUsd, side, currentPrice, ... }
 */
export async function getPositionPnl(market) {
  try {
    const positions = await fetchOpenPositions();
    const pos = positions.find(p => (p.pairFrom || '').toUpperCase() === market.toUpperCase());

    if (!pos) {
      return { exists: false, pnl: 0, size: 0, entry: 0 };
    }

    const entry = parseFloat(pos.entryPx) || 0;
    const sizeUsd = Math.abs(parseFloat(pos.ntl)) || 0;
    const collateralUsd = parseFloat(pos.collateralUsed) || 0;
    const pnl = parseFloat(pos.unrealizedPnl) || 0;
    const side = pos.side === 'S' ? 'short' : 'long';
    const currentPrice = await getMidPrice(market) || entry;

    return {
      exists: true,
      pnl,
      size: sizeUsd,
      entry,
      collateralUsd,
      side,
      currentPrice,
      liquidationPrice: parseFloat(pos.liquidationPx) || 0,
      leverage: parseFloat(pos.leverage) || 0,
      idx: pos.idx,
      pairId: pos.pairId,
    };
  } catch (err) {
    logger.error('getPositionPnl error', { market, error: err.message });
    return { exists: false, pnl: 0, size: 0, entry: 0, error: err.message };
  }
}

/**
 * List all open positions (used by API controllers).
 */
export async function getAllPositions() {
  try {
    const positions = await fetchOpenPositions();
    return positions.map(p => ({
      market: (p.pairFrom || '').toUpperCase(),
      side: p.side === 'S' ? 'short' : 'long',
      sizeUsd: Math.abs(parseFloat(p.ntl)) || 0,
      collateralUsd: parseFloat(p.collateralUsed) || 0,
      entryPrice: parseFloat(p.entryPx) || 0,
      currentPrice: parseFloat(p.entryPx) || 0,
      unrealisedPnl: parseFloat(p.unrealizedPnl) || 0,
      leverage: parseFloat(p.leverage) || '-',
      liquidationPrice: parseFloat(p.liquidationPx) || 0,
    }));
  } catch (err) {
    logger.warn('Ostium getAllPositions failed', { error: err.message });
    return [];
  }
}

// ---------------------------------------------------------------------------
// One-time USDC approval (idempotent)
// ---------------------------------------------------------------------------

async function ensureApproval() {
  if (_approvalChecked) return;
  try {
    const client = await getClient();
    if (client.isReadOnly?.()) return;
    const balances = await client.getBalances(config.PROTOCOL_ADDRESS);
    const allowance = parseFloat(balances?.allowance || '0');
    if (allowance < 1_000_000) { // effectively "not approved"
      logger.info('Approving USDC for Ostium trading (one-time)');
      await client.approveUsdc('max');
    }
    _approvalChecked = true;
  } catch (err) {
    logger.warn('USDC approval check failed', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Open / Increase a position
// ---------------------------------------------------------------------------

/**
 * Open a stock perp position on Ostium.
 *
 * @param {string} market — stock symbol (AAPL, TSLA, NVDA, …)
 * @param {number} sizeUsd — total position size in USD (after leverage)
 * @param {number} collateralUsd — collateral in USDC
 * @param {'long'|'short'} side — position direction
 */
export async function openPosition(market, sizeUsd, collateralUsd, side = 'long') {
  try {
    const client = await getClient();
    if (client.isReadOnly?.()) throw new Error('Protocol wallet not loaded');

    const pair = await findPair(market);
    if (!pair) throw new Error(`No Ostium market for ${market}`);
    if (pair.isMarketOpen === false) {
      logger.info('Market closed on Ostium, skipping entry', { market });
      return { success: false, skipped: 'market-closed' };
    }

    await ensureApproval();

    const price = parseFloat(pair.midPx);
    if (!price) throw new Error(`No price for ${market}`);

    // Respect the pair's minimum notional — a smaller order reverts on-chain
    const minNtl = parseFloat(pair.minNtl) || 0;
    if (minNtl > 0 && sizeUsd < minNtl) {
      logger.info('Position below pair minimum notional, skipping', {
        market, sizeUsd: sizeUsd.toFixed(2), minNtl,
      });
      return { success: false, skipped: 'below-min-notional' };
    }

    const maxLev = Math.min(pair.maxLeverage || config.OSTIUM.MAX_LEVERAGE, config.OSTIUM.MAX_LEVERAGE);
    const leverage = Math.min(
      Math.max(1, Math.round((sizeUsd / collateralUsd) * 10) / 10),
      maxLev,
    );

    logger.info('Opening position on Ostium', {
      market, side, leverage: leverage + 'x',
      collateralUsd: collateralUsd.toFixed(2), sizeUsd: sizeUsd.toFixed(0),
    });

    const { OrderType } = await loadSdk();
    const result = await client.openTrade({
      pairId: pair.pairId,
      buy: side !== 'short',
      price: price.toString(),
      collateral: collateralUsd.toFixed(2),
      leverage: leverage.toFixed(1),
      type: OrderType.Market,
      slippage: config.OSTIUM.SLIPPAGE_BPS,
    });

    const txSig = result?.txHash || result?.hash || result?.orderId || 'submitted';
    logger.info('Ostium order placed', { market, side, leverage: leverage + 'x', txSig });

    return { txSig, success: true };
  } catch (err) {
    logger.error('openPosition failed', { market, side, sizeUsd, error: err.message });
    throw err;
  }
}

// Backwards-compatible aliases
export async function openLong(market, sizeUsd, collateralUsd) {
  return openPosition(market, sizeUsd, collateralUsd, 'long');
}

export async function openShort(market, sizeUsd, collateralUsd) {
  return openPosition(market, sizeUsd, collateralUsd, 'short');
}

// ---------------------------------------------------------------------------
// Close / Reduce
// ---------------------------------------------------------------------------

async function closeByPercent(market, closePercent) {
  const client = await getClient();
  if (client.isReadOnly?.()) throw new Error('Protocol wallet not loaded');

  const pos = await getPositionPnl(market);
  if (!pos.exists) {
    logger.warn('No position to close', { market });
    return null;
  }

  const price = pos.currentPrice || pos.entry;
  const result = await client.closeTrade({
    pairId: pos.pairId,
    idx: pos.idx,
    price: price.toString(),
    closePercent,
    slippage: config.OSTIUM.SLIPPAGE_BPS,
  });

  const txSig = result?.txHash || result?.hash || result?.orderId || 'submitted';
  logger.info('Ostium close submitted', { market, closePercent, txSig });
  return { txSig, success: true };
}

export async function closePosition(market) {
  try {
    return await closeByPercent(market, 100);
  } catch (err) {
    logger.error('closePosition failed', { market, error: err.message });
    throw err;
  }
}

export async function reducePosition(market, pct) {
  try {
    return await closeByPercent(market, Math.round(Math.min(1, Math.max(0.01, pct)) * 100));
  } catch (err) {
    logger.error('reducePosition failed', { market, pct, error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Free collateral — wallet USDC on Arbitrum (USD)
// ---------------------------------------------------------------------------

export async function getFreeCollateral() {
  try {
    const client = await getReader();
    const balances = await client.getBalances(config.PROTOCOL_ADDRESS);
    return parseFloat(balances?.usdc || '0');
  } catch (err) {
    logger.error('getFreeCollateral failed', { error: err.message });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Fills (trade history for the dashboard)
// ---------------------------------------------------------------------------

export async function getFills(limit = 60) {
  try {
    const client = await getReader();
    const res = client.getFills
      ? await client.getFills({ user: config.PROTOCOL_ADDRESS, limit })
      : await client.subgraph.getFills({ user: config.PROTOCOL_ADDRESS, limit });
    return Array.isArray(res) ? res : (res?.fills || []);
  } catch (err) {
    logger.debug('Ostium getFills failed', { error: err.message });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function getMaxLeverage(_market) {
  return config.OSTIUM.MAX_LEVERAGE;
}

/**
 * Live safe leverage cap for a market. Ostium equities have TWO caps:
 * an intraday max and a lower overnightMaxLeverage — positions above the
 * overnight cap risk forced liquidation at the session close. The engine
 * holds positions across sessions (worker cadence is 30–120 min), so the
 * overnight cap is the honest bound. Falls back to config on any failure.
 */
export async function getSafeMaxLeverage(market) {
  try {
    const pair = await findPair(market);
    const max = parseFloat(pair?.maxLeverage) || config.OSTIUM.MAX_LEVERAGE;
    const overnight = parseFloat(pair?.overnightMaxLeverage) || 0;
    return overnight > 0 ? Math.min(max, overnight) : max;
  } catch {
    return config.OSTIUM.MAX_LEVERAGE;
  }
}

export function getAvailableMarkets() {
  return [...config.STOCK_MARKETS];
}

export async function shutdown() {
  logger.info('Ostium service shutdown (no persistent connections)');
}
