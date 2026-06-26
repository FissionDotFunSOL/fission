import 'dotenv/config';
import { PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
const PROTOCOL_KEYPAIR_BS58 = process.env.PROTOCOL_KEYPAIR;
let protocolKeypair = null;
try {
  if (PROTOCOL_KEYPAIR_BS58) {
    protocolKeypair = Keypair.fromSecretKey(bs58.decode(PROTOCOL_KEYPAIR_BS58));
  }
} catch (err) {
  console.error('Failed to decode PROTOCOL_KEYPAIR:', err.message);
}

const PROTOCOL_PUBKEY = new PublicKey(
  process.env.PROTOCOL_PUBKEY || 'HgeoK9ASUYey5g2MBSGHfCdauDzLv93x6vAs7j492i9c',
);

// ---------------------------------------------------------------------------
// Program IDs
// ---------------------------------------------------------------------------
const PUMP_FEES_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// Fission protocol token — 20% of ALL creator fees buy this back
const FISSION_TOKEN_MINT = process.env.FISSION_TOKEN_MINT || '';

// ---------------------------------------------------------------------------
// Fee split percentages
// ---------------------------------------------------------------------------
const FEE_SPLIT = {
  positionFund: 0.7,   // 70 % → perps (profits → buyback & burn creator token)
  buyback:      0.3,   // 30 % → buyback & burn FISSION protocol token
};

// ---------------------------------------------------------------------------
// Risk management
// ---------------------------------------------------------------------------
const RISK = {
  maxDrawdownPct:       parseFloat(process.env.MAX_DRAWDOWN_PCT) || 0.80,
  circuitBreakerPct:    parseFloat(process.env.CIRCUIT_BREAKER_PCT) || 0.90,
  reservePct:           parseFloat(process.env.RESERVE_PCT) || 0.05,
  takeProfitPct:        parseFloat(process.env.TAKE_PROFIT_PCT) || 0.50,
  takeProfitReducePct:  parseFloat(process.env.TAKE_PROFIT_REDUCE_PCT) || 0.30,
  drawdownReducePct:    parseFloat(process.env.DRAWDOWN_REDUCE_PCT) || 0.25,
  minDeploySol:         parseFloat(process.env.MIN_DEPLOY_SOL) || 0.005,
  maxPositionSol:       parseFloat(process.env.MAX_POSITION_SOL) || 999999,
  liquidationWarningPct: parseFloat(process.env.LIQUIDATION_WARNING_PCT) || 0.05,
  // Minimum SOL to always keep in the wallet for gas/transaction fees
  // The system will NEVER deploy funds if it would drop below this
  minWalletBalanceSol:  parseFloat(process.env.MIN_WALLET_BALANCE_SOL) || 0.05,
  // Leverage multiplier for perp positions (Jupiter allows 1.1x–250x)
  // Default 100x: maximum aggression — all fees immediately deployed at max leverage
  leverage:             parseFloat(process.env.LEVERAGE) || 100,
};

// ---------------------------------------------------------------------------
// Worker timing (seconds)
// ---------------------------------------------------------------------------
const INTERVALS = {
  minSeconds: parseInt(process.env.MIN_INTERVAL_SECONDS, 10) || 1800,   // 30 min
  maxSeconds: parseInt(process.env.MAX_INTERVAL_SECONDS, 10) || 7200,   // 120 min
};

// ---------------------------------------------------------------------------
// Solana / Jupiter
// ---------------------------------------------------------------------------
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v1';
const JUPITER_PERPS_PROGRAM_ID = process.env.JUPITER_PERPS_PROGRAM_ID || 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu';
const JLP_POOL_ADDRESS = process.env.JLP_POOL_ADDRESS || '2ve5JwfyDUw8kULb2oHM9iDvS683QCJTsa8tTSgpcnqM';

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
// Jupiter Perps — supported markets (SOL, BTC, ETH only)
// These map to custody accounts in the JLP pool
// ---------------------------------------------------------------------------
const JUPITER_MARKETS = ['SOL', 'BTC', 'ETH'];

// ---------------------------------------------------------------------------
// Flash Trade — supported markets (everything else)
// Flash Trade V2 supports ~21 pairs including memecoins
// ---------------------------------------------------------------------------
const FLASH_API_URL = process.env.FLASH_API_URL || 'https://flashapi.trade/v2';
const FLASH_V2_RPC_URL = process.env.FLASH_V2_RPC_URL || 'https://flash.magicblock.xyz';
const FLASH_MARKETS = [
  'BONK', 'WIF', 'JUP', 'JTO', 'PYTH', 'DOGE', 'SUI', 'PEPE',
  'RNDR', 'HNT', 'W', 'TNSR', 'KMNO', 'MEW', 'POPCAT', 'WEN',
  'BOME', 'MYRO',
];
const FLASH_MAX_LEVERAGE = 100;

// Combined list of all supported perps markets
const ALL_PERPS_MARKETS = [...JUPITER_MARKETS, ...FLASH_MARKETS];

// Legacy alias (some code references this)
const PERPS_MARKETS = JUPITER_MARKETS;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
const config = {
  protocolKeypair,
  PROTOCOL_PUBKEY,
  PUMP_FEES_PROGRAM_ID,
  FISSION_TOKEN_MINT,
  FEE_SPLIT,
  RISK,
  INTERVALS,
  SOLANA_RPC_URL,
  JUPITER_API_URL,
  JUPITER_PERPS_PROGRAM_ID,
  JLP_POOL_ADDRESS,
  JUPITER_MARKETS,
  PERPS_MARKETS,
  FLASH_API_URL,
  FLASH_V2_RPC_URL,
  FLASH_MARKETS,
  FLASH_MAX_LEVERAGE,
  ALL_PERPS_MARKETS,
  PORT,
  NODE_ENV,
  FIREBASE_SERVICE_ACCOUNT,
};

export default config;
