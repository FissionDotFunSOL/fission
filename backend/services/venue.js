import config from '../config.js';
import logger from '../utils/logger.js';
import * as ostium from './ostium.js';
import * as hyperliquid from './hyperliquid.js';

// ---------------------------------------------------------------------------
// Perp venue router.
//
// Exposes the same interface as an individual venue service (ostium.js /
// hyperliquid.js) and dispatches every call to the ACTIVE venue. The active
// venue is config.TRADING_VENUE, unless that venue reports itself paused —
// then the router fails over to the first other venue that is live. This is
// what lets FILL keep trading on Hyperliquid while Ostium is halted, and flip
// back to Ostium automatically once it resumes (set TRADING_VENUE=ostium).
// ---------------------------------------------------------------------------

const IMPL = { ostium, hyperliquid };
const ORDER = ['hyperliquid', 'ostium']; // failover preference

let _activeCache = { id: null, at: 0 };

/** Resolve the active venue id, honoring TRADING_VENUE then falling over. */
export async function activeVenueId() {
  if (Date.now() - _activeCache.at < 30_000 && _activeCache.id) return _activeCache.id;

  const primary = config.TRADING_VENUE;
  const candidates = [primary, ...ORDER.filter((v) => v !== primary)];

  let chosen = primary;
  for (const id of candidates) {
    const impl = IMPL[id];
    if (!impl) continue;
    try {
      const paused = await impl.isVenuePaused();
      if (!paused) { chosen = id; break; }
    } catch { /* treat as unusable, try next */ }
  }

  if (chosen !== _activeCache.id) {
    logger.info('Active perp venue resolved', { active: chosen, primary });
  }
  _activeCache = { id: chosen, at: Date.now() };
  return chosen;
}

async function active() {
  return IMPL[await activeVenueId()];
}

// ── Interface parity — every call routes to the active venue ────────────────
export const getPairs           = async (...a) => (await active()).getPairs(...a);
export const findPair           = async (...a) => (await active()).findPair(...a);
export const getMidPrice        = async (...a) => (await active()).getMidPrice(...a);
export const getPositionPnl     = async (...a) => (await active()).getPositionPnl(...a);
export const getAllPositions    = async (...a) => (await active()).getAllPositions(...a);
export const openPosition       = async (...a) => (await active()).openPosition(...a);
export const openLong           = async (...a) => (await active()).openLong(...a);
export const openShort          = async (...a) => (await active()).openShort(...a);
export const closePosition      = async (...a) => (await active()).closePosition(...a);
export const reducePosition     = async (...a) => (await active()).reducePosition(...a);
export const getFreeCollateral  = async (...a) => (await active()).getFreeCollateral(...a);
export const getFills           = async (...a) => (await active()).getFills(...a);
export const getSafeMaxLeverage = async (...a) => (await active()).getSafeMaxLeverage(...a);
export const isStockMarketOpen  = async (...a) => (await active()).isStockMarketOpen(...a);
export const isVenuePaused      = async (...a) => (await active()).isVenuePaused(...a);
export const getMaxLeverage     = (...a) => ostium.getMaxLeverage(...a); // constant, venue-agnostic
export const getAvailableMarkets = () => config.STOCK_MARKETS;

// Capital routing: venues that support auto-funding (Hyperliquid pulls idle
// Arbitrum USDC through its bridge) run it; others no-op.
export const ensureCollateral = async (...a) => {
  const impl = await active();
  return impl.ensureCollateral ? impl.ensureCollateral(...a) : null;
};

export async function shutdown() {
  await Promise.allSettled(Object.values(IMPL).map((v) => v.shutdown?.()));
}

/** Snapshot of every venue for the API/UI: which is active + each one's state. */
export async function getVenueStatus() {
  const activeId = await activeVenueId();
  const venues = await Promise.all(
    Object.values(config.VENUES).map(async (v) => {
      let paused = null;
      let marketOpen = null;
      try { paused = await IMPL[v.id]?.isVenuePaused(); } catch {}
      try { marketOpen = await IMPL[v.id]?.isStockMarketOpen(); } catch {}
      return {
        ...v,
        active: v.id === activeId,
        paused: paused === true,
        marketOpen: marketOpen === true,
      };
    }),
  );
  return { active: activeId, venues };
}
