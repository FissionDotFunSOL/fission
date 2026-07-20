import config from '../config.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Hyperliquid perps service — trade[XYZ] HIP-3 equity dex ("xyz")
//
// A drop-in alternative to Ostium (which halted after the 2026-07-15 oracle
// exploit). Hyperliquid's builder-deployed "xyz" dex lists single-name US
// equity perps (AAPL, TSLA, NVDA, HOOD, COIN, MSTR, …) — the same tickers
// FILL trades — with USDC margin, deep liquidity, and near-24/7 trading.
//
// Interface mirrors services/ostium.js so the venue router (services/venue.js)
// can dispatch to either venue transparently. Trades sign with the same
// protocol EOA via the official `hyperliquid` SDK. Collateral is USDC on
// the Hyperliquid L1 (bridged from Arbitrum) — SEPARATE from the Ostium
// USDC pool, so switching venues needs a one-time deposit to Hyperliquid.
// ---------------------------------------------------------------------------

const DEX = 'xyz';
const SLIPPAGE = (config.OSTIUM.SLIPPAGE_BPS || 50) / 10_000; // fraction, e.g. 0.005

// FILL ticker -> Hyperliquid xyz symbol. Almost all identical; Alphabet is GOOGL.
const SYMBOL_ALIAS = { GOOG: 'GOOGL' };
const hlSymbol = (market) => `${DEX}:${(SYMBOL_ALIAS[market] || market).toUpperCase()}`;

let _sdk = null;
let _metaCache = { at: 0, byName: new Map() };
let _dexOffset = null; // asset-id offset for the xyz builder dex

async function loadSdk() {
  if (!_sdk) _sdk = await import('hyperliquid');
  return _sdk;
}

// Raw info POST (no auth) — used for market data so it works read-only.
async function info(body) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}`);
  return res.json();
}

// Cache the xyz universe + live asset contexts (price/OI) for 30s.
async function getMeta() {
  if (Date.now() - _metaCache.at < 30_000 && _metaCache.byName.size) return _metaCache;
  const [meta, ctxs] = await info({ type: 'metaAndAssetCtxs', dex: DEX });
  const byName = new Map();
  meta.universe.forEach((a, i) => {
    byName.set(a.name, {
      name: a.name,
      market: a.name.replace(`${DEX}:`, ''),
      universeIndex: i, // position in the dex universe → asset-id component
      maxLeverage: a.maxLeverage,
      szDecimals: a.szDecimals,
      onlyIsolated: a.onlyIsolated === true,
      isDelisted: a.isDelisted === true,
      markPx: parseFloat(ctxs[i]?.markPx) || parseFloat(ctxs[i]?.midPx) || 0,
      oraclePx: parseFloat(ctxs[i]?.oraclePx) || 0,
    });
  });
  _metaCache = { at: Date.now(), byName };
  return _metaCache;
}

// Builder-dex asset ids (per the official SDK): builder dexes start at
// 110000 in perpDexs order, so asset = 110000 + (dexPos-1)*10000 + index.
async function getDexOffset() {
  if (_dexOffset !== null) return _dexOffset;
  const dexes = await info({ type: 'perpDexs' });
  const pos = dexes.findIndex((d) => d && d.name === DEX);
  if (pos < 1) throw new Error(`Hyperliquid dex "${DEX}" not found in perpDexs`);
  _dexOffset = 110000 + (pos - 1) * 10000;
  return _dexOffset;
}

async function assetIdFor(pair) {
  const offset = await getDexOffset();
  return offset + pair.universeIndex;
}

// ── Market data (interface parity with ostium) ──────────────────────────────

export async function getPairs() {
  const { byName } = await getMeta();
  return [...byName.values()];
}

export async function findPair(market) {
  const { byName } = await getMeta();
  const p = byName.get(hlSymbol(market));
  if (!p || p.isDelisted) return null;
  return {
    ...p,
    pairId: p.name,
    midPx: p.markPx,
    // Hyperliquid equity perps trade near-24/7 with funding; "open" == live price
    isMarketOpen: p.markPx > 0,
  };
}

export async function getMidPrice(market) {
  const p = await findPair(market);
  return p?.markPx || 0;
}

export function getMaxLeverage(_market) {
  return config.OSTIUM.MAX_LEVERAGE;
}

export async function getSafeMaxLeverage(market) {
  const p = await findPair(market);
  return Math.min(p?.maxLeverage || 10, config.OSTIUM.MAX_LEVERAGE);
}

// Hyperliquid has no venue-wide halt equivalent to Ostium's incident.
export async function isVenuePaused() {
  return false;
}

// Equity perps trade near-24/7 on HL; treat "open" as "has a live mark".
export async function isStockMarketOpen() {
  try {
    const p = await findPair(config.DEFAULT_MARKET || 'AAPL');
    return !!p?.isMarketOpen;
  } catch {
    return false;
  }
}

// ── Account state ───────────────────────────────────────────────────────────

// HIP-3 builder dexes have SEGREGATED collateral: USDC in the main perp
// account can't margin xyz trades until it's moved into the xyz dex
// (sendAsset self-transfer). Positions + margin for our markets live in
// the xyz clearinghouse, so all account reads default to dex=xyz.
async function clearinghouse(dex = DEX) {
  const body = { type: 'clearinghouseState', user: config.PROTOCOL_ADDRESS };
  if (dex) body.dex = dex;
  return info(body);
}

export async function getFreeCollateral() {
  try {
    const st = await clearinghouse();
    // withdrawable = free USDC not backing any margin
    return parseFloat(st?.withdrawable ?? st?.marginSummary?.accountValue ?? 0) || 0;
  } catch (err) {
    logger.debug('HL getFreeCollateral failed', { error: err.message });
    return 0;
  }
}

// USDC sitting in the MAIN perp account (where bridge deposits land) —
// a waypoint on the way into the xyz dex.
async function getMainFreeCollateral() {
  try {
    const st = await clearinghouse('');
    return parseFloat(st?.withdrawable ?? 0) || 0;
  } catch {
    return 0;
  }
}

// Shape matches ostium.getAllPositions exactly — getLivePositions and the
// dashboard consume this contract.
export async function getAllPositions() {
  try {
    const st = await clearinghouse();
    const out = [];
    for (const ap of (st?.assetPositions || [])) {
      const p = ap.position;
      const szi = parseFloat(p?.szi || 0);
      if (!szi) continue;
      const entry = parseFloat(p.entryPx) || 0;
      const sizeUsd = Math.abs(parseFloat(p.positionValue)) || Math.abs(szi) * entry;
      out.push({
        market: (p.coin || '').replace(`${DEX}:`, ''),
        side: szi > 0 ? 'long' : 'short',
        sizeUsd,
        collateralUsd: parseFloat(p.marginUsed) || 0,
        entryPrice: entry,
        currentPrice: szi !== 0 ? sizeUsd / Math.abs(szi) : entry,
        unrealisedPnl: parseFloat(p.unrealizedPnl) || 0,
        leverage: parseFloat(p.leverage?.value) || 0,
        liquidationPrice: parseFloat(p.liquidationPx) || 0,
        sizeShares: Math.abs(szi),
      });
    }
    return out;
  } catch (err) {
    logger.debug('HL getAllPositions failed', { error: err.message });
    return [];
  }
}

// Shape matches ostium.getPositionPnl exactly — the workers' double-open
// guard (live.exists) and risk-manager math (pnl/size/entry/collateralUsd/
// currentPrice) rely on this contract.
export async function getPositionPnl(market) {
  try {
    const want = (SYMBOL_ALIAS[market] || market).toUpperCase();
    const positions = await getAllPositions();
    const p = positions.find((x) => x.market === want);
    if (!p) return { exists: false, pnl: 0, size: 0, entry: 0 };

    let currentPrice = p.currentPrice;
    try { currentPrice = (await getMidPrice(market)) || currentPrice; } catch {}

    return {
      exists: true,
      pnl: p.unrealisedPnl,
      size: p.sizeUsd,
      entry: p.entryPrice,
      collateralUsd: p.collateralUsd,
      side: p.side,
      currentPrice,
      liquidationPrice: p.liquidationPrice,
      leverage: p.leverage,
    };
  } catch (err) {
    logger.error('HL getPositionPnl error', { market, error: err.message });
    return { exists: false, pnl: 0, size: 0, entry: 0, error: err.message };
  }
}

export async function getFills(limit = 60) {
  try {
    const fills = await info({ type: 'userFills', user: config.PROTOCOL_ADDRESS });
    return (fills || []).slice(0, limit).map((f) => ({
      market: (f.coin || '').replace(`${DEX}:`, ''),
      side: f.dir || (f.side === 'B' ? 'buy' : 'sell'),
      price: parseFloat(f.px) || 0,
      size: parseFloat(f.sz) || 0,
      pnl: parseFloat(f.closedPnl) || 0,
      fee: parseFloat(f.fee) || 0,
      time: f.time,
      hash: f.hash,
    }));
  } catch {
    return [];
  }
}

// ── Trading (write path) ────────────────────────────────────────────────────
//
// Orders go to the exchange endpoint directly: the SDK's symbol map only
// knows the default dex (builder-dex names like "xyz:COIN" throw "Unknown
// asset"), so we compute asset ids ourselves and reuse the SDK's exported,
// battle-tested signing helpers (orderToWire/orderWireToAction/signL1Action).
// "Market" orders are aggressive IOC limits at mark ± slippage — the same
// thing the SDK's marketOpen does under the hood.

function roundSize(sizeShares, szDecimals) {
  const f = 10 ** szDecimals;
  return Math.floor(sizeShares * f) / f;
}

// Hyperliquid price rules (perps): ≤5 significant figures AND
// ≤ (6 - szDecimals) decimal places. Integer prices are always allowed.
export function roundPx(px, szDecimals) {
  const maxDec = Math.max(0, 6 - szDecimals);
  let p = parseFloat(Number(px).toPrecision(5));
  p = Math.round(p * 10 ** maxDec) / 10 ** maxDec;
  return p;
}

async function exchangePost(action, nonce, signature) {
  const res = await fetch('https://api.hyperliquid.xyz/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Hyperliquid exchange ${res.status}: ${JSON.stringify(data)}`);
  if (data?.status && data.status !== 'ok') throw new Error(String(data.response || data.status));
  return data;
}

async function signAndSend(action) {
  if (!config.protocolWallet) throw new Error('Protocol wallet not loaded');
  const { signL1Action } = await loadSdk();
  const nonce = Date.now();
  const signature = await signL1Action(config.protocolWallet, action, null, nonce, true);
  return exchangePost(action, nonce, signature);
}

// One IOC order; returns the exchange's per-order status.
async function placeIocOrder(pair, { isBuy, sizeShares, reduceOnly }) {
  const { orderToWire, orderWireToAction } = await loadSdk();
  const asset = await assetIdFor(pair);
  const px = roundPx(pair.markPx * (isBuy ? 1 + SLIPPAGE : 1 - SLIPPAGE), pair.szDecimals);
  const wire = orderToWire({
    coin: pair.name,
    is_buy: isBuy,
    limit_px: px,
    sz: sizeShares,
    reduce_only: !!reduceOnly,
    order_type: { limit: { tif: 'Ioc' } },
  }, asset);
  const action = orderWireToAction([wire], 'na');
  const result = await signAndSend(action);
  const status = result?.response?.data?.statuses?.[0];
  if (status?.error) throw new Error(status.error);
  return status;
}

async function setLeverage(pair, marginMode, leverage) {
  const asset = await assetIdFor(pair);
  return signAndSend({
    type: 'updateLeverage',
    asset,
    isCross: marginMode !== 'isolated',
    leverage,
  });
}

export async function openPosition(market, sizeUsd, collateralUsd, side = 'long') {
  try {
    if (!config.protocolWallet) throw new Error('Protocol wallet not loaded');
    const pair = await findPair(market);
    if (!pair) throw new Error(`No Hyperliquid market for ${market}`);
    if (!pair.isMarketOpen) return { success: false, skipped: 'market-closed' };

    const price = pair.markPx;
    if (!price) throw new Error(`No price for ${market}`);

    const maxLev = Math.min(pair.maxLeverage, config.OSTIUM.MAX_LEVERAGE);
    const leverage = Math.min(Math.max(1, Math.round((sizeUsd / collateralUsd))), maxLev);
    const sizeShares = roundSize((collateralUsd * leverage) / price, pair.szDecimals);
    if (sizeShares <= 0) return { success: false, skipped: 'size-too-small' };

    const marginMode = pair.onlyIsolated ? 'isolated' : 'cross';

    // Set leverage/margin mode first (idempotent), then market order.
    await setLeverage(pair, marginMode, leverage).catch((e) =>
      logger.debug('HL updateLeverage note', { market, error: e.message }));

    logger.info('Opening position on Hyperliquid', {
      market, side, leverage: leverage + 'x',
      collateralUsd: collateralUsd.toFixed(2), sizeShares,
    });

    const status = await placeIocOrder(pair, { isBuy: side !== 'short', sizeShares });
    const txSig = status?.filled?.oid || status?.resting?.oid || 'submitted';

    logger.info('Hyperliquid order placed', {
      market, side, leverage: leverage + 'x', txSig,
      avgPx: status?.filled?.avgPx, totalSz: status?.filled?.totalSz,
    });
    return { txSig: String(txSig), success: true };
  } catch (err) {
    logger.error('HL openPosition failed', { market, side, sizeUsd, error: err.message });
    throw err;
  }
}

export async function openLong(market, sizeUsd, collateralUsd) {
  return openPosition(market, sizeUsd, collateralUsd, 'long');
}
export async function openShort(market, sizeUsd, collateralUsd) {
  return openPosition(market, sizeUsd, collateralUsd, 'short');
}

export async function closePosition(market) {
  if (!config.protocolWallet) throw new Error('Protocol wallet not loaded');
  const positions = await getAllPositions();
  const p = positions.find((x) => x.market === (SYMBOL_ALIAS[market] || market).toUpperCase());
  if (!p) return { success: false, skipped: 'no-position' };
  const pair = await findPair(market);
  // reduce-only IOC for the full size: can only shrink the position,
  // never flip it, and is rejected outright if the position is gone
  const status = await placeIocOrder(pair, {
    isBuy: p.side === 'short',
    sizeShares: p.sizeShares,
    reduceOnly: true,
  });
  return { txSig: String(status?.filled?.oid || 'closed'), success: true };
}

export async function reducePosition(market, pct) {
  if (!config.protocolWallet) throw new Error('Protocol wallet not loaded');
  const positions = await getAllPositions();
  const p = positions.find((x) => x.market === (SYMBOL_ALIAS[market] || market).toUpperCase());
  if (!p) return { success: false, skipped: 'no-position' };
  const pair = await findPair(market);
  const closeSize = roundSize(p.sizeShares * Math.min(Math.max(pct, 0), 1), pair.szDecimals);
  if (closeSize <= 0) return { success: false, skipped: 'size-too-small' };
  const status = await placeIocOrder(pair, {
    isBuy: p.side === 'short',
    sizeShares: closeSize,
    reduceOnly: true,
  });
  return { txSig: String(status?.filled?.oid || 'reduced'), success: true };
}

export function getAvailableMarkets() {
  return config.STOCK_MARKETS;
}

// ── Auto-deposit: route idle Arbitrum USDC into Hyperliquid ────────────────
//
// Depositing = sending native USDC on Arbitrum to Hyperliquid's Bridge2
// escrow; the same address is credited on the HL L1 in under a minute.
// Bridge2 verified three ways before this address was committed: HL docs,
// the Arbiscan "Hyperliquid: Deposit Bridge 2" label, and on-chain (the
// escrow holds ~$400M USDC).
const BRIDGE2 = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // native USDC
const MIN_BRIDGE_DEPOSIT = 5; // HL rule: below 5 USDC is LOST — never send less

/**
 * Pure sizing rule for the auto-deposit (unit-tested): idle Arbitrum USDC
 * serves no purpose while Hyperliquid is the active venue, so everything
 * above the reserve moves — as long as it clears the bridge minimum
 * (below 5 USDC is burned by the bridge). Returns 0 when nothing should move.
 */
export function computeAutoDeposit(arbUsdc, _hlFreeUsdc, _minDeployUsd, reserveUsdc = 0) {
  const spendable = Math.floor((arbUsdc - reserveUsdc) * 100) / 100;
  if (spendable < MIN_BRIDGE_DEPOSIT) return 0;     // below bridge min = burned
  return spendable;
}

export async function getArbitrumUsdc() {
  const { JsonRpcProvider, Contract, formatUnits } = await import('ethers');
  const provider = new JsonRpcProvider(config.ARBITRUM_RPC_URL);
  const usdc = new Contract(ARB_USDC, ['function balanceOf(address) view returns (uint256)'], provider);
  const bal = await usdc.balanceOf(config.PROTOCOL_ADDRESS);
  return parseFloat(formatUnits(bal, 6)) || 0;
}

// EIP-712 field layout for the sendAsset user-signed action (must match
// the official SDK's SEND_ASSET_SIGN_TYPES exactly).
const SEND_ASSET_SIGN_TYPES = [
  { name: 'hyperliquidChain', type: 'string' },
  { name: 'destination', type: 'string' },
  { name: 'sourceDex', type: 'string' },
  { name: 'destinationDex', type: 'string' },
  { name: 'token', type: 'string' },
  { name: 'amount', type: 'string' },
  { name: 'fromSubAccount', type: 'string' },
  { name: 'nonce', type: 'uint64' },
];

// Move USDC main perp account -> xyz dex (self sendAsset). Builder-dex
// margin is segregated, so this is the required second hop after a bridge
// deposit lands in the main account.
async function transferToXyz(amount) {
  const { signUserSignedAction } = await loadSdk();
  const nonce = Date.now();
  const action = {
    type: 'sendAsset',
    signatureChainId: '0xa4b1',       // matches the helper's mainnet domain (42161)
    hyperliquidChain: 'Mainnet',
    destination: config.PROTOCOL_ADDRESS,
    sourceDex: '',                    // "" = the default perp dex
    destinationDex: DEX,
    token: 'USDC',
    amount: amount.toFixed(2),
    fromSubAccount: '',
    nonce,
  };
  const signature = await signUserSignedAction(
    config.protocolWallet, action, SEND_ASSET_SIGN_TYPES, 'HyperliquidTransaction:SendAsset', true,
  );
  return exchangePost(action, nonce, signature);
}

/**
 * Called once per position-manager cycle (via the venue router). Idempotent
 * capital pipeline — each run performs whichever hop is currently possible:
 *   Arbitrum USDC → Bridge2 → HL main account → xyz dex (where margin lives)
 * Set AUTO_DEPOSIT=off to disable.
 */
export async function ensureCollateral() {
  try {
    if ((process.env.AUTO_DEPOSIT || 'on') === 'off') return null;
    if (!config.protocolWallet) return null;

    const [arbUsdc, xyzFree, mainFree] = await Promise.all([
      getArbitrumUsdc(), getFreeCollateral(), getMainFreeCollateral(),
    ]);

    // Hop 2 first: the main account is purely a waypoint — anything parked
    // there moves straight into the xyz dex where margin lives.
    if (mainFree >= 1) {
      const amount = Math.floor(mainFree * 100) / 100;
      logger.info('Moving USDC into the xyz dex (segregated margin)', {
        amount: amount.toFixed(2), xyzFree: xyzFree.toFixed(2),
      });
      await transferToXyz(amount);
      logger.info('USDC now in the xyz dex — tradeable next cycle', { amount: amount.toFixed(2) });
      return { amount, hash: 'sendAsset:main->xyz' };
    }

    // Hop 1: idle Arbitrum USDC bridges to the HL main account.
    const reserve = parseFloat(process.env.ARBITRUM_USDC_RESERVE) || 0;
    const amount = computeAutoDeposit(arbUsdc, xyzFree + mainFree, config.RISK.minDeployUsd, reserve);
    if (amount <= 0) return null;

    const { JsonRpcProvider, Contract, parseUnits, formatUnits } = await import('ethers');
    const provider = new JsonRpcProvider(config.ARBITRUM_RPC_URL);
    const signer = config.protocolWallet.connect(provider);
    const usdc = new Contract(ARB_USDC, [
      'function transfer(address,uint256) returns (bool)',
      'function balanceOf(address) view returns (uint256)',
    ], signer);

    // Final sanity: the destination must look like the real escrow
    // (nine-figure USDC balance) — a guard against any address corruption.
    const escrow = parseFloat(formatUnits(await usdc.balanceOf(BRIDGE2), 6));
    if (escrow < 50_000_000) {
      logger.error('HL bridge sanity check FAILED — refusing to deposit', { escrow });
      return null;
    }

    logger.info('Auto-depositing idle Arbitrum USDC to Hyperliquid', {
      amount: amount.toFixed(2), xyzFree: xyzFree.toFixed(2), mainFree: mainFree.toFixed(2), arbUsdc: arbUsdc.toFixed(2),
    });
    const tx = await usdc.transfer(BRIDGE2, parseUnits(amount.toFixed(2), 6));
    const receipt = await tx.wait();
    logger.info('Hyperliquid deposit sent — credits in under a minute', {
      amount: amount.toFixed(2), hash: receipt.hash,
    });
    return { amount, hash: receipt.hash };
  } catch (err) {
    logger.error('HL auto-deposit failed', { error: err.message });
    return null;
  }
}

export async function shutdown() {
  // Direct REST — nothing to disconnect.
}
