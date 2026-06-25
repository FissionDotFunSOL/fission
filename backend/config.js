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

// ---------------------------------------------------------------------------
// Fee split percentages
// ---------------------------------------------------------------------------
const FEE_SPLIT = {
  positionFund: 0.6,   // 60 %
  buyback:      0.2,   // 20 %
  revenue:      0.1,   // 10 %
  ecosystem:    0.1,   // 10 %
};

// ---------------------------------------------------------------------------
// Risk management
// ---------------------------------------------------------------------------
const RISK = {
  maxDrawdownPct:       0.40,  // 40 % → auto-reduce position
  circuitBreakerPct:    0.50,  // 50 % underlying drop in 24 h → auto-close
  reservePct:           0.20,  // keep 20 % of position fund as cash buffer
};

// ---------------------------------------------------------------------------
// Worker timing (seconds)
// ---------------------------------------------------------------------------
const INTERVALS = {
  minSeconds: parseInt(process.env.MIN_INTERVAL_SECONDS, 10) || 1800,   // 30 min
  maxSeconds: parseInt(process.env.MAX_INTERVAL_SECONDS, 10) || 7200,   // 120 min
};

// ---------------------------------------------------------------------------
// Solana / Drift / Jupiter
// ---------------------------------------------------------------------------
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const DRIFT_ENV     = process.env.DRIFT_ENV || 'mainnet-beta';
const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v1';

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
// Drift perp market indices
// ---------------------------------------------------------------------------
const DRIFT_MARKET_INDICES = {
  'SOL': 0,
  'BTC': 1,
  'ETH': 2,
  'JTO': 20,
  'BONK': 22,
  'PYTH': 23,
  'WIF': 24,
  'RNDR': 25,
  'HNT': 27,
  'JUP': 28,
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
const config = {
  protocolKeypair,
  PROTOCOL_PUBKEY,
  PUMP_FEES_PROGRAM_ID,
  FEE_SPLIT,
  RISK,
  INTERVALS,
  SOLANA_RPC_URL,
  DRIFT_ENV,
  JUPITER_API_URL,
  DRIFT_MARKET_INDICES,
  PORT,
  NODE_ENV,
  FIREBASE_SERVICE_ACCOUNT,
};

export default config;
