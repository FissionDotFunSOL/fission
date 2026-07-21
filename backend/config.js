import 'dotenv/config';
import { Wallet, getAddress } from 'ethers';

// ---------------------------------------------------------------------------
// Wallet (EVM — Robinhood Chain)
// ---------------------------------------------------------------------------
const PROTOCOL_PRIVATE_KEY = process.env.PROTOCOL_PRIVATE_KEY;
let protocolWallet = null;
try {
  if (PROTOCOL_PRIVATE_KEY) {
    protocolWallet = new Wallet(PROTOCOL_PRIVATE_KEY);
  }
} catch (err) {
  console.error('Failed to load PROTOCOL_PRIVATE_KEY:', err.message);
}

const PROTOCOL_ADDRESS = getAddress(
  process.env.PROTOCOL_ADDRESS ||
  protocolWallet?.address ||
  '0x0000000000000000000000000000000000000000',
);

// ---------------------------------------------------------------------------
// Robinhood Chain (Arbitrum Orbit L2, chainId 4663, native gas token: ETH)
// Fees + buybacks live here. Perp trading lives on Arbitrum One (Ostium).
// The same protocol wallet address works on both chains.
// ---------------------------------------------------------------------------
const CHAIN_ID = parseInt(process.env.CHAIN_ID, 10) || 4663;
const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const EXPLORER_URL = process.env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com';

// Arbitrum One — where Ostium stock perps settle (USDC collateral)
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
const ARBITRUM_EXPLORER_URL = process.env.ARBITRUM_EXPLORER_URL || 'https://arbiscan.io';

// ---------------------------------------------------------------------------
// Launchpad registry — the top Robinhood Chain memecoin launchpads.
// Factory addresses verified on-chain (each launchpad's factory is the
// contract that deploys its tokens). Pons has full support: its launch form
// has a "Creator wallet" field that routes fees to any address. On the
// others, fee rights follow the launching wallet.
// ---------------------------------------------------------------------------
const WETH_ADDRESS = getAddress(process.env.PONS_WETH || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');

const LAUNCHPADS = {
  pons: {
    id: 'pons',
    name: 'Pons',
    url: 'https://ponsfamily.com/launchpad',
    factory: getAddress(process.env.PONS_FACTORY || '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB'),
    locker:  getAddress(process.env.PONS_LOCKER  || '0x736D76699C26D0d966744cAe304C000d471f7F35'),
    apiUrl: process.env.PONS_API_URL || 'https://ponsfamily.com/api',
    support: 'full',
    howTo: 'Set the Creator wallet field (Advanced) to the protocol wallet at launch.',
    graduationEth: 4.2,
    launchFeeEth: 0.0005,
  },
  launchhood: {
    id: 'launchhood',
    name: 'LaunchHood',
    url: 'https://launchhood.com',
    factory: getAddress(process.env.LAUNCHHOOD_FACTORY || '0x62B33A039D289CBDa50EbeB72Fe4261449E61Bcf'),
    locker: process.env.LAUNCHHOOD_LOCKER ? getAddress(process.env.LAUNCHHOOD_LOCKER) : '',
    // Verified on the live create form: an Advanced "Reward recipient" field
    // routes the creator share of locked-LP fees to any address
    support: 'full',
    howTo: 'Set the Reward recipient field (Advanced) to the protocol wallet at launch.',
  },
  noxa: {
    id: 'noxa',
    name: 'NOXA',
    url: 'https://noxa.fun',
    factory: process.env.NOXA_FACTORY ? getAddress(process.env.NOXA_FACTORY) : '',
    locker: '',
    support: 'coming-soon',
    howTo: 'NOXA is not live yet — support lands when their contracts ship.',
  },
};

// Back-compat shim: parts of the codebase still read config.PONS
const PONS = {
  FACTORY: LAUNCHPADS.pons.factory,
  LOCKER: LAUNCHPADS.pons.locker,
  WETH: WETH_ADDRESS,
  API_URL: LAUNCHPADS.pons.apiUrl,
  GRADUATION_ETH: LAUNCHPADS.pons.graduationEth,
  LAUNCH_FEE_ETH: LAUNCHPADS.pons.launchFeeEth,
};

// What happens to bought-back tokens: 'burn' sends them to the dead
// address; 'hold' keeps them in the protocol wallet as treasury.
const BURN_MODE = (process.env.BURN_MODE || 'hold').toLowerCase() === 'burn' ? 'burn' : 'hold';

// FILL protocol token (launched on Pons) — 30% of ALL creator fees buy this back
const FILL_TOKEN_ADDRESS = process.env.FILL_TOKEN_ADDRESS || '';

// ---------------------------------------------------------------------------
// Fee split percentages
// ---------------------------------------------------------------------------
const FEE_SPLIT = {
  positionFund: 0.7,   // 70 % → stock perps (profits → buyback & burn creator token)
  buyback:      0.3,   // 30 % → buyback & burn FILL protocol token
};

// When perp positions are profitable and take-profit triggers:
const PROFIT_SPLIT = {
  sourceToken: 0.7,    // 70 % of profits → buy back the token whose fees funded the position
  fill:     0.3,    // 30 % of profits → buy back FILL protocol token
};

// ---------------------------------------------------------------------------
// Risk management
// ---------------------------------------------------------------------------
const RISK = {
  maxDrawdownPct:       parseFloat(process.env.MAX_DRAWDOWN_PCT) || 0.80,
  circuitBreakerPct:    parseFloat(process.env.CIRCUIT_BREAKER_PCT) || 0.90,
  reservePct:           parseFloat(process.env.RESERVE_PCT) || 0.05,
  takeProfitPct:        parseFloat(process.env.TAKE_PROFIT_PCT) || 0.50,
  earlyTakeProfitPct:   parseFloat(process.env.EARLY_TAKE_PROFIT_PCT) || 0.20,
  takeProfitReducePct:  parseFloat(process.env.TAKE_PROFIT_REDUCE_PCT) || 0.30,
  drawdownReducePct:    parseFloat(process.env.DRAWDOWN_REDUCE_PCT) || 0.25,
  // Minimum USDC to deploy into a single position (Ostium min notional applies too)
  minDeployUsd:         parseFloat(process.env.MIN_DEPLOY_USD) || 25,
  // Minimum order VALUE (collateral × leverage). Hyperliquid rejects
  // notional under $10; keep a small buffer above it by default.
  minNotionalUsd:       parseFloat(process.env.MIN_NOTIONAL_USD) || 50,
  maxPositionUsd:       parseFloat(process.env.MAX_POSITION_USD) || 999999,
  liquidationWarningPct: parseFloat(process.env.LIQUIDATION_WARNING_PCT) || 0.05,
  // Minimum ETH to always keep in the Robinhood Chain wallet for gas fees
  // The system will NEVER deploy funds if it would drop below this
  minWalletBalanceEth:  parseFloat(process.env.MIN_WALLET_BALANCE_ETH) || 0.002,
  // Leverage multiplier for stock perp positions (Ostium equities max is 50x)
  leverage:             parseFloat(process.env.LEVERAGE) || 50,
  // Total USDC the engine keeps in play across all markets
  maxTradingCapitalUsd: parseFloat(process.env.MAX_TRADING_CAPITAL_USD) || 1500,
};

// ---------------------------------------------------------------------------
// Worker timing (seconds)
// ---------------------------------------------------------------------------
const INTERVALS = {
  minSeconds: parseInt(process.env.MIN_INTERVAL_SECONDS, 10) || 1800,   // 30 min
  maxSeconds: parseInt(process.env.MAX_INTERVAL_SECONDS, 10) || 7200,   // 120 min
};

// ---------------------------------------------------------------------------
// Ostium — permissionless RWA perp DEX on Arbitrum One.
// Stock perps (AAPL, TSLA, …) up to 50x, USDC collateral, no API keys or
// waitlist: the protocol wallet signs trades directly via the official SDK.
// ---------------------------------------------------------------------------
const OSTIUM = {
  MAX_LEVERAGE: parseFloat(process.env.OSTIUM_MAX_LEVERAGE) || 50,
  SLIPPAGE_BPS: parseInt(process.env.OSTIUM_SLIPPAGE_BPS, 10) || 50,
};

// ---------------------------------------------------------------------------
// Perp venue selection. Ostium halted after the 2026-07-15 oracle exploit,
// so the engine trades on Hyperliquid's trade[XYZ] equity dex for now and
// switches back to Ostium once it safely resumes. Each venue self-reports a
// paused state; the router (services/venue.js) picks the primary, and if it's
// paused, fails over to any other live venue.
// ---------------------------------------------------------------------------
const TRADING_VENUE = process.env.TRADING_VENUE || 'hyperliquid';
const VENUES = {
  hyperliquid: {
    id: 'hyperliquid',
    name: 'Hyperliquid',
    dex: 'trade[XYZ] equity perps',
    chain: 'Hyperliquid L1',
    collateral: 'USDC (on Hyperliquid)',
    url: 'https://app.hyperliquid.xyz',
  },
  ostium: {
    id: 'ostium',
    name: 'Ostium',
    dex: 'RWA perps',
    chain: 'Arbitrum One',
    collateral: 'USDC (on Arbitrum)',
    url: 'https://ostium.com',
    note: 'Trading globally paused since 2026-07-15 (oracle exploit). Re-enabled automatically when the venue resumes.',
  },
};

// ---------------------------------------------------------------------------
// Uniswap on Robinhood Chain — Pons tokens graduate to locked Uniswap pools,
// so buybacks route through the Uniswap V3 SwapRouter02.
// Default is the official deployment from Uniswap's sdk-core, verified
// on-chain (bytecode present; factory() and WETH9() match the published
// v3 factory and the Pons WETH).
// ---------------------------------------------------------------------------
const UNISWAP_ROUTER = getAddress(
  process.env.UNISWAP_ROUTER || '0xcaf681a66d020601342297493863e78c959e5cb2',
);

// ---------------------------------------------------------------------------
// Ostium stock perp markets — mirrors the Robinhood app's most-traded names.
// These are the underlyings a derivative token can be pegged to. The engine
// resolves each against Ostium's live pair list at trade time.
// ---------------------------------------------------------------------------
const STOCK_MARKETS = [
  'AAPL', 'TSLA', 'NVDA', 'MSFT', 'GOOG', 'AMZN', 'META',
  'HOOD', 'COIN', 'MSTR', 'NFLX', 'AMD', 'PLTR', 'AVGO',
];

// Extra markets the engine also scalps with pooled capital (anchored to
// FILL). Opt-in via env — off by default so no capital trades outside
// the fully-managed per-token flow unless explicitly enabled.
const EXTRA_MARKETS = (process.env.EXTRA_MARKETS || '').split(',').map(s => s.trim()).filter(Boolean);

// Default market when a token doesn't specify an underlying
const DEFAULT_MARKET = process.env.DEFAULT_MARKET || 'AAPL';

// Legacy alias (some code references this)
const ALL_PERPS_MARKETS = STOCK_MARKETS;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const PORT     = parseInt(process.env.PORT, 10) || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ---------------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------------
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || '';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
const config = {
  protocolWallet,
  PROTOCOL_ADDRESS,
  CHAIN_ID,
  RPC_URL,
  EXPLORER_URL,
  ARBITRUM_RPC_URL,
  ARBITRUM_EXPLORER_URL,
  LAUNCHPADS,
  WETH_ADDRESS,
  PONS,
  FILL_TOKEN_ADDRESS,
  FEE_SPLIT,
  PROFIT_SPLIT,
  RISK,
  INTERVALS,
  OSTIUM,
  TRADING_VENUE,
  VENUES,
  UNISWAP_ROUTER,
  STOCK_MARKETS,
  EXTRA_MARKETS,
  DEFAULT_MARKET,
  BURN_MODE,
  ALL_PERPS_MARKETS,
  PORT,
  NODE_ENV,
  FIREBASE_SERVICE_ACCOUNT,
};

export default config;
