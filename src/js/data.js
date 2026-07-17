/* ═══════════════════════════════════════════════════════════
   FILL PROTOCOL — Data & Configuration
   ═══════════════════════════════════════════════════════════ */

// Protocol wallet — creators point their Pons "Creator wallet" field here.
// Same address holds USDC trading collateral on Arbitrum (Ostium).
export const PROTOCOL_WALLET = '0x2cdE129778a416279d9f6F1E9B5c3abb302D1CD7';

export const EXPLORER_URL = 'https://robinhoodchain.blockscout.com';
export const ARBITRUM_EXPLORER_URL = 'https://arbiscan.io';

// Supported Robinhood Chain launchpads (factories verified on-chain).
// Pons ("Creator wallet") and LaunchHood ("Reward recipient") both have a
// fee-routing field at launch — cleanest integration. On Robinlaunch,
// creator fees follow the wallet that launched the token.
export const LAUNCHPADS = [
  { id: 'pons',        name: 'Pons',        url: 'https://pons.family',    support: 'full',
    tagline: 'Creator wallet field routes fees straight to the engine' },
  { id: 'launchhood',  name: 'LaunchHood',  url: 'https://launchhood.com', support: 'full',
    tagline: 'Reward recipient field routes fees straight to the engine' },
  { id: 'robinlaunch', name: 'Robinlaunch', url: 'https://robinlaunch.fun', support: 'partial',
    tagline: 'Launch from the protocol wallet or transfer fee rights' },
  { id: 'noxa',        name: 'NOXA',        url: 'https://noxa.fun',       support: 'coming-soon',
    tagline: 'Support lands when their contracts go live' },
];

// Stock perp markets on Ostium (permissionless RWA perp DEX, Arbitrum) —
// up to 50x on equities. These mirror the most-traded names in the
// Robinhood app.
export const STOCK_TOKENS = [
  { symbol: 'AAPL', name: 'Apple',             hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'TSLA', name: 'Tesla',             hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'NVDA', name: 'NVIDIA',            hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'MSFT', name: 'Microsoft',         hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'GOOG', name: 'Alphabet',          hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'AMZN', name: 'Amazon',            hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'META', name: 'Meta Platforms',    hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'HOOD', name: 'Robinhood',         hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'COIN', name: 'Coinbase',          hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'MSTR', name: 'Strategy',          hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'NFLX', name: 'Netflix',           hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'AMD',  name: 'AMD',               hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'PLTR', name: 'Palantir',          hasPerps: true, provider: 'ostium', maxLev: 50 },
  { symbol: 'AVGO', name: 'Broadcom',          hasPerps: true, provider: 'ostium', maxLev: 50 },
];

// All tokens are perps-enabled
export const POPULAR_TOKENS = STOCK_TOKENS;

// Trading strategy modes — how the engine trades a token's fee income.
// Mirrors backend/services/strategies.js. maxLev bounds the leverage cap
// a creator can pick; trade=false disables the trading controls entirely.
export const STRATEGIES = [
  { id: 'conservative', label: 'Conservative', desc: '3-10x · regular market hours · tight stop',    trade: true,  maxLev: 10 },
  { id: 'balanced',     label: 'Balanced',     desc: '5-25x · regular + extended sessions · standard stop',     trade: true,  maxLev: 25 },
  { id: 'degen',        label: 'Degen',        desc: 'up to 50x · every market session · signal-driven', trade: true, maxLev: 50 },
  { id: 'off',          label: 'Off',          desc: 'no trading — fees go to buybacks only',     trade: false, maxLev: 0 },
];

// Stats fallback — all zeros when backend is offline.
export const STATS_DATA = [
  { label: 'Active Derivatives',  value: 0,  key: 'derivatives' },
  { label: 'Position PnL',        value: 0,  key: 'pnl' },
  { label: 'Buybacks Executed',   value: 0,  key: 'buybacks' },
];

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
