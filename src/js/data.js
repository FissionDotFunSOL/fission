/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Data & Configuration
   
   Mock data is used ONLY as a visual fallback when the
   backend API is unreachable. It is clearly labeled as
   demo data in the UI when active.
   ═══════════════════════════════════════════════════════════ */

export const PROTOCOL_WALLET = 'HgeoK9ASUYey5g2MBSGHfCdauDzLv93x6vAs7j492i9c';

// Tokens with perps support — Jupiter (SOL/BTC/ETH) + Flash Trade (everything else)
export const PERPS_TOKENS = [
  // Jupiter Perps (up to 250x leverage)
  { symbol: 'SOL',    name: 'Solana',       hasPerps: true, provider: 'jupiter', maxLev: 250 },
  { symbol: 'BTC',    name: 'Bitcoin',      hasPerps: true, provider: 'jupiter', maxLev: 250 },
  { symbol: 'ETH',    name: 'Ethereum',     hasPerps: true, provider: 'jupiter', maxLev: 250 },
  // Flash Trade (up to 100x leverage)
  { symbol: 'BONK',   name: 'Bonk',         hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'WIF',    name: 'dogwifhat',    hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'JUP',    name: 'Jupiter',      hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'DOGE',   name: 'Dogecoin',     hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'SUI',    name: 'Sui',          hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'PEPE',   name: 'Pepe',         hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'JTO',    name: 'Jito',         hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'PYTH',   name: 'Pyth Network', hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'RNDR',   name: 'Render',       hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'HNT',    name: 'Helium',       hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'W',      name: 'Wormhole',     hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'TNSR',   name: 'Tensor',       hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'KMNO',   name: 'Kamino',       hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'MEW',    name: 'cat in a dogs world', hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'POPCAT', name: 'Popcat',       hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'WEN',    name: 'Wen',          hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'BOME',   name: 'Book of Meme', hasPerps: true, provider: 'flash', maxLev: 100 },
  { symbol: 'MYRO',   name: 'Myro',         hasPerps: true, provider: 'flash', maxLev: 100 },
];

// All tokens are now perps-enabled (no more non-perps tokens)
export const POPULAR_TOKENS = PERPS_TOKENS;

// Dashboard demo data — only shown when backend is offline.
// Rendered with a "(Demo)" badge so users know it is not live.
export const MOCK_DASHBOARD_DATA = [
  {
    token: 'FISSION_SOL',
    linkedTo: 'SOL',
    side: 'long',
    leverage: 100,
    entry: 0,
    sizeUsd: 0,
    collateralUsd: 0,
    deployedSol: 0,
    pnl: 0,
    status: 'pending',
  },
];

// Stats fallback — all zeros when backend is offline.
// Prefixes ($ / +$) are rendered in the HTML counter-prefix spans.
export const STATS_DATA = [
  { label: 'Active Derivatives',  value: 0,  key: 'derivatives' },
  { label: 'Total Fees Claimed',  value: 0,  key: 'fees' },
  { label: 'Position PnL',        value: 0,  key: 'pnl' },
  { label: 'Buybacks Executed',   value: 0,  key: 'buybacks' },
];

/**
 * Slightly jitter a numeric value to simulate live updates.
 */
export function jitterValue(val, pct = 0.02) {
  const delta = val * pct * (Math.random() - 0.5) * 2;
  return val + delta;
}

/**
 * Format number with commas and optional decimals.
 */
export function formatNumber(n, decimals = 0) {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format as compact currency string.
 */
export function formatCurrency(n) {
  if (Math.abs(n) >= 1_000_000) {
    return `$${(n / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(n) >= 1_000) {
    return `$${(n / 1_000).toFixed(0)}K`;
  }
  return `$${n.toFixed(0)}`;
}
