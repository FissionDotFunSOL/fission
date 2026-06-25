import { PublicKey } from '@solana/web3.js';
import config from '../config.js';
import logger from '../utils/logger.js';
import { getConnection, sendTx } from './solana.js';

// ---------------------------------------------------------------------------
// Jupiter Perpetuals Service
//
// Jupiter Perps uses a request-based model:
//   1. Submit a PositionRequest instruction on-chain
//   2. An automated keeper fulfils the request
//
// This service wraps the raw instructions into the same interface the
// position-manager and risk-manager workers expect.
// ---------------------------------------------------------------------------

const JUP_PERPS_PROGRAM_ID = new PublicKey(
  config.JUPITER_PERPS_PROGRAM_ID || 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
);

// Jupiter Perpetuals Pool (derived PDA)
const JLP_POOL = new PublicKey(
  config.JLP_POOL_ADDRESS || '2ve5JwfyDUw8kULb2oHM9iDvS683QCJTsa8tTSgpcnqM'
);

// Custody accounts for supported assets (mainnet)
const CUSTODY_ACCOUNTS = {
  'SOL':  new PublicKey('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz'),
  'BTC':  new PublicKey('5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm'),
  'ETH':  new PublicKey('AQCGyheWPLeo764h9nh6JLeMArHwfBPdChp1JViXdGmX'),
  'USDC': new PublicKey('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa'),
  'USDT': new PublicKey('4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk'),
};

// Collateral mints
const COLLATERAL_MINTS = {
  'SOL': new PublicKey('So11111111111111111111111111111111111111112'),
  'USDC': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
};

// ---------------------------------------------------------------------------
// Position PDA derivation
// ---------------------------------------------------------------------------

function derivePositionPDA(wallet, custodyKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('position'),
      wallet.toBuffer(),
      JLP_POOL.toBuffer(),
      custodyKey.toBuffer(),
    ],
    JUP_PERPS_PROGRAM_ID,
  );
  return pda;
}

function derivePositionRequestPDA(wallet, custodyKey, counter) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64LE(BigInt(counter));
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('position_request'),
      wallet.toBuffer(),
      JLP_POOL.toBuffer(),
      custodyKey.toBuffer(),
      counterBuf,
    ],
    JUP_PERPS_PROGRAM_ID,
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Read position from on-chain account
// ---------------------------------------------------------------------------

/**
 * Get current position data for a given market.
 *
 * @param {string} market — asset symbol (SOL, BTC, ETH)
 * @returns {{ exists, pnl, size, entry, marketIndex }}
 */
export async function getPositionPnl(market) {
  try {
    if (!config.protocolKeypair) {
      return { exists: false, pnl: 0, size: 0, entry: 0, error: 'No keypair' };
    }

    const custodyKey = CUSTODY_ACCOUNTS[market];
    if (!custodyKey) {
      return { exists: false, pnl: 0, size: 0, entry: 0, error: `Unknown market: ${market}` };
    }

    const positionPDA = derivePositionPDA(config.protocolKeypair.publicKey, custodyKey);
    const conn = getConnection();
    const accountInfo = await conn.getAccountInfo(positionPDA);

    if (!accountInfo || !accountInfo.data) {
      return { exists: false, pnl: 0, size: 0, entry: 0 };
    }

    // Parse position account data
    // Jupiter Perps Position layout (after 8-byte discriminator):
    // offset 8:  owner (32 bytes)
    // offset 40: pool (32 bytes)
    // offset 72: custody (32 bytes)
    // offset 104: collateralCustody (32 bytes)
    // offset 136: openTime (i64, 8 bytes)
    // offset 144: updateTime (i64, 8 bytes)
    // offset 152: side (u8) — 1 = Long, 2 = Short
    // offset 153: price (u64, 8 bytes) — entry price scaled
    // offset 161: sizeUsd (u64, 8 bytes)
    // offset 169: collateralUsd (u64, 8 bytes)
    // offset 177: unrealizedPnl (i64, 8 bytes) — in USD
    // offset 185: cumulativeInterestSnapshot (u128, 16 bytes)
    // offset 201: lockedAmount (u64, 8 bytes)
    // offset 209: bump (u8)
    const data = accountInfo.data;

    if (data.length < 186) {
      logger.warn('Position account data too short', { market, length: data.length });
      // Fallback: position exists but can't parse PnL
      return { exists: true, pnl: 0, size: 0, entry: 0, market };
    }

    const side = data[152]; // 1 = Long, 2 = Short
    const entryPrice = Number(data.readBigUInt64LE(153)) / 1e6;
    const sizeUsd = Number(data.readBigUInt64LE(161)) / 1e6;
    const collateralUsd = Number(data.readBigUInt64LE(169)) / 1e6;

    // Unrealized PnL — signed i64
    let unrealizedPnl = 0;
    if (data.length >= 185) {
      unrealizedPnl = Number(data.readBigInt64LE(177)) / 1e6;
    }

    const sizeDirection = side === 1 ? 1 : -1; // positive for long, negative for short

    logger.debug('Position read', {
      market,
      side: side === 1 ? 'LONG' : 'SHORT',
      entryPrice,
      sizeUsd,
      collateralUsd,
      unrealizedPnl,
    });

    return {
      exists: true,
      pnl: unrealizedPnl,
      size: sizeUsd * sizeDirection,
      entry: entryPrice,
      collateral: collateralUsd,
      market,
      side: side === 1 ? 'long' : 'short',
    };
  } catch (err) {
    logger.error('getPositionPnl failed', { market, error: err.message });
    return { exists: false, pnl: 0, size: 0, entry: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Open / Increase a long position
// ---------------------------------------------------------------------------

/**
 * Open or increase a long position on Jupiter Perps.
 *
 * Jupiter Perps uses a request-based model:
 * 1. We build and send a CreateIncreasePositionRequest instruction
 * 2. A keeper automatically fulfils it
 *
 * @param {string} market   — asset symbol (SOL, BTC, ETH)
 * @param {number} sizeUsd  — notional position size in USD
 * @param {number} collateralSol — collateral in SOL (defaults to sizeUsd equivalent)
 */
export async function openLong(market, sizeUsd, collateralSol) {
  try {
    if (!config.protocolKeypair) {
      throw new Error('Protocol keypair not loaded');
    }

    const custodyKey = CUSTODY_ACCOUNTS[market];
    if (!custodyKey) {
      throw new Error(`Unsupported market: ${market}. Available: ${Object.keys(CUSTODY_ACCOUNTS).join(', ')}`);
    }

    const conn = getConnection();
    const wallet = config.protocolKeypair.publicKey;

    // Build the increase position instruction using raw instruction data
    // Jupiter Perps program instruction discriminator for CreateIncreasePositionRequest
    const discriminator = Buffer.from([0x47, 0x5d, 0x64, 0xca, 0x9a, 0xa0, 0x19, 0x92]); // create_increase_position_request

    // Encode parameters
    const sizeUsdScaled = BigInt(Math.round(sizeUsd * 1e6));
    const paramsBuf = Buffer.alloc(24);
    paramsBuf.writeBigUInt64LE(sizeUsdScaled, 0);     // size_usd_delta
    paramsBuf.writeBigUInt64LE(BigInt(0), 8);           // acceptable_price (0 = market)
    paramsBuf.writeBigUInt64LE(BigInt(0), 16);          // counter (auto)

    const ixData = Buffer.concat([discriminator, paramsBuf]);

    // Derive necessary accounts
    const positionPDA = derivePositionPDA(wallet, custodyKey);

    const ix = {
      programId: JUP_PERPS_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },         // owner
        { pubkey: JLP_POOL, isSigner: false, isWritable: true },      // pool
        { pubkey: custodyKey, isSigner: false, isWritable: true },     // custody
        { pubkey: positionPDA, isSigner: false, isWritable: true },    // position
      ],
      data: ixData,
    };

    // For now, log the intent and submit the instruction
    // Note: In production this would need all the correct account metas
    // from the IDL. For MVP we log the parameters.
    logger.info('Jupiter Perps: opening/increasing long', {
      market,
      sizeUsd,
      positionPDA: positionPDA.toBase58(),
      custodyKey: custodyKey.toBase58(),
    });

    // Submit the position request
    const sig = await sendTx([ix], [config.protocolKeypair]);
    logger.info('Jupiter Perps: position request submitted', { market, sizeUsd, txSig: sig });
    return { txSig: sig };
  } catch (err) {
    logger.error('openLong failed', { market, sizeUsd, error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Close a position (full)
// ---------------------------------------------------------------------------

export async function closePosition(market) {
  try {
    if (!config.protocolKeypair) {
      throw new Error('Protocol keypair not loaded');
    }

    const custodyKey = CUSTODY_ACCOUNTS[market];
    if (!custodyKey) {
      throw new Error(`Unsupported market: ${market}`);
    }

    const wallet = config.protocolKeypair.publicKey;
    const positionPDA = derivePositionPDA(wallet, custodyKey);

    // Check position exists
    const pnlInfo = await getPositionPnl(market);
    if (!pnlInfo.exists) {
      logger.warn('No position to close', { market });
      return null;
    }

    // Build decrease position request (full close)
    const discriminator = Buffer.from([0x84, 0x27, 0x2e, 0x45, 0xe0, 0xfb, 0x32, 0x18]); // create_decrease_position_request
    const sizeUsd = BigInt(Math.round(Math.abs(pnlInfo.size) * 1e6));

    const paramsBuf = Buffer.alloc(24);
    paramsBuf.writeBigUInt64LE(sizeUsd, 0);            // size_usd_delta (full position)
    paramsBuf.writeBigUInt64LE(BigInt(0), 8);           // acceptable_price (0 = market)
    paramsBuf.writeBigUInt64LE(BigInt(0), 16);          // counter

    const ixData = Buffer.concat([discriminator, paramsBuf]);

    const ix = {
      programId: JUP_PERPS_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: JLP_POOL, isSigner: false, isWritable: true },
        { pubkey: custodyKey, isSigner: false, isWritable: true },
        { pubkey: positionPDA, isSigner: false, isWritable: true },
      ],
      data: ixData,
    };

    logger.info('Jupiter Perps: closing position', { market, sizeUsd: Number(sizeUsd) / 1e6 });
    const sig = await sendTx([ix], [config.protocolKeypair]);
    logger.info('Jupiter Perps: close request submitted', { market, txSig: sig });
    return { txSig: sig };
  } catch (err) {
    logger.error('closePosition failed', { market, error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reduce position by percentage
// ---------------------------------------------------------------------------

export async function reducePosition(market, pct) {
  try {
    if (!config.protocolKeypair) {
      throw new Error('Protocol keypair not loaded');
    }

    const pnlInfo = await getPositionPnl(market);
    if (!pnlInfo.exists) {
      logger.warn('No position to reduce', { market });
      return null;
    }

    const reduceSize = Math.abs(pnlInfo.size) * pct;
    const custodyKey = CUSTODY_ACCOUNTS[market];
    const wallet = config.protocolKeypair.publicKey;
    const positionPDA = derivePositionPDA(wallet, custodyKey);

    const discriminator = Buffer.from([0x84, 0x27, 0x2e, 0x45, 0xe0, 0xfb, 0x32, 0x18]);
    const sizeUsd = BigInt(Math.round(reduceSize * 1e6));

    const paramsBuf = Buffer.alloc(24);
    paramsBuf.writeBigUInt64LE(sizeUsd, 0);
    paramsBuf.writeBigUInt64LE(BigInt(0), 8);
    paramsBuf.writeBigUInt64LE(BigInt(0), 16);

    const ixData = Buffer.concat([discriminator, paramsBuf]);

    const ix = {
      programId: JUP_PERPS_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: JLP_POOL, isSigner: false, isWritable: true },
        { pubkey: custodyKey, isSigner: false, isWritable: true },
        { pubkey: positionPDA, isSigner: false, isWritable: true },
      ],
      data: ixData,
    };

    logger.info('Jupiter Perps: reducing position', { market, pct, reduceSizeUsd: reduceSize });
    const sig = await sendTx([ix], [config.protocolKeypair]);
    logger.info('Jupiter Perps: reduce request submitted', { market, pct, txSig: sig });
    return { txSig: sig };
  } catch (err) {
    logger.error('reducePosition failed', { market, pct, error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Free collateral (wallet SOL balance as proxy)
// ---------------------------------------------------------------------------

export async function getFreeCollateral() {
  try {
    if (!config.protocolKeypair) return 0;
    const conn = getConnection();
    const balance = await conn.getBalance(config.protocolKeypair.publicKey);
    // Return USDC-equivalent (approx) — this is a simplified check
    // In production, also check USDC token account balance
    return balance / 1e9; // SOL balance as collateral proxy
  } catch (err) {
    logger.error('getFreeCollateral failed', { error: err.message });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Available markets
// ---------------------------------------------------------------------------

export function getAvailableMarkets() {
  return Object.keys(CUSTODY_ACCOUNTS).filter(m => m !== 'USDC' && m !== 'USDT');
}

// ---------------------------------------------------------------------------
// Shutdown (no persistent connection to close for Jupiter)
// ---------------------------------------------------------------------------

export async function shutdown() {
  logger.info('Jupiter Perps service shutdown (no persistent connections)');
}
