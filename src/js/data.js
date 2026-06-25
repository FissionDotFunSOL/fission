/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Data & Configuration
   
   Mock data is used ONLY as a visual fallback when the
   backend API is unreachable. It is clearly labeled as
   demo data in the UI when active.
   ═══════════════════════════════════════════════════════════ */

export const PROTOCOL_WALLET = 'HgeoK9ASUYey5g2MBSGHfCdauDzLv93x6vAs7j492i9c';

export const POPULAR_TOKENS = [
  { symbol: 'SOL',    name: 'Solana' },
  { symbol: 'BTC',    name: 'Bitcoin' },
  { symbol: 'ETH',    name: 'Ethereum' },
  { symbol: 'BONK',   name: 'Bonk' },
  { symbol: 'WIF',    name: 'dogwifhat' },
  { symbol: 'JUP',    name: 'Jupiter' },
  { symbol: 'PYTH',   name: 'Pyth Network' },
  { symbol: 'JTO',    name: 'Jito' },
  { symbol: 'RNDR',   name: 'Render' },
  { symbol: 'HNT',    name: 'Helium' },
  { symbol: 'DOGE',   name: 'Dogecoin' },
  { symbol: 'SUI',    name: 'Sui' },
  { symbol: 'PEPE',   name: 'Pepe' },
  { symbol: 'W',      name: 'Wormhole' },
  { symbol: 'TNSR',   name: 'Tensor' },
  { symbol: 'MEW',    name: 'cat in a dogs world' },
  { symbol: 'POPCAT', name: 'Popcat' },
  { symbol: 'APT',    name: 'Aptos' },
  { symbol: 'ARB',    name: 'Arbitrum' },
  { symbol: 'BNB',    name: 'BNB' },
];

// Dashboard demo data — only shown when backend is offline.
// Rendered with a "(Demo)" badge so users know it is not live.
export const MOCK_DASHBOARD_DATA = [
  {
    token: 'FISSION_SOL',
    linkedTo: 'SOL',
    volume24h: 0,
    fees24h: 0,
    positionSize: 0,
    pnl: 0,
    pnlPercent: 0,
    buybacks: 0,
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
