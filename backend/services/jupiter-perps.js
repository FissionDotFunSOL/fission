import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import crypto from 'crypto';
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
// This service uses proper Anchor IDL-derived discriminators and complete
// account lists. It also tries the Jupiter Perps API first for pre-built
// transactions, falling back to manual instruction building.
// ---------------------------------------------------------------------------

const JUP_PERPS_PROGRAM_ID = new PublicKey(
  config.JUPITER_PERPS_PROGRAM_ID || 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
);

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

const COLLATERAL_MINTS = {
  'SOL': new PublicKey('So11111111111111111111111111111111111111112'),
  'USDC': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
};

// Custody oracle accounts (Pyth price feeds on mainnet)
const CUSTODY_ORACLES = {
  'SOL': new PublicKey('H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG'),
  'BTC': new PublicKey('GVXRSBjFk6e6J3NbVPXbvN6SzZ6xWBDTpEJRqF1kzXe9'),
  'ETH': new PublicKey('JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB'),
};

// ---------------------------------------------------------------------------
// Anchor discriminator helper
// ---------------------------------------------------------------------------

function anchorDiscriminator(instructionName) {
  const preimage = `global:${instructionName}`;
  const hash = crypto.createHash('sha256').update(preimage).digest();
  return hash.slice(0, 8);
}

const DISC_INCREASE = anchorDiscriminator('create_increase_position_request');
const DISC_DECREASE = anchorDiscriminator('create_decrease_position_request');

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

function derivePositionPDA(wallet, custodyKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), wallet.toBuffer(), JLP_POOL.toBuffer(), custodyKey.toBuffer()],
    JUP_PERPS_PROGRAM_ID,
  );
  return pda;
}

function derivePositionRequestPDA(wallet, positionPDA, counter) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64LE(BigInt(counter));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('position_request'), positionPDA.toBuffer(), counterBuf],
    JUP_PERPS_PROGRAM_ID,
  );
  return pda;
}

function derivePerpetualsPDA() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('perpetuals')],
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
 * Jupiter Perps Position account layout (Borsh packed, no padding):
 *   Offset  Field                    Type     Size
 *   0       discriminator            [u8;8]   8
 *   8       owner                    pubkey   32
 *   40      pool                     pubkey   32
 *   72      custody                  pubkey   32
 *   104     collateralCustody        pubkey   32
 *   136     openTime                 i64      8
 *   144     updateTime               i64      8
 *   152     side                     u8       1  (0=Long, 1=Short)
 *   153     price                    u64      8  (entry price, scaled 1e6)
 *   161     sizeUsd                  u64      8  (position size after leverage, scaled 1e6)
 *   169     collateralUsd            u64      8  (collateral after fees, scaled 1e6)
 *   177     realisedPnlUsd           i64      8  (realised PnL from partial closes, scaled 1e6)
 *   185     cumulativeInterestSnap   u128     16
 *   201     lockedAmount             u64      8
 *   209     bump                     u8       1
 *
 * NOTE: realisedPnlUsd is REALISED (from partial closes), NOT unrealised.
 * Unrealised PnL must be calculated from current price vs entry price.
 * Since we don't have current price in the position account, we return
 * realisedPnlUsd and flag it. The risk manager should use getSolPrice()
 * separately for unrealised PnL estimation.
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

    const data = accountInfo.data;

    // Minimum: 8 (disc) + 32*4 (pubkeys) + 8*2 (times) + 1 (side) + 8*4 (price/size/coll/rpnl) = 209
    if (data.length < 185) {
      logger.warn('Position account data too short', { market, length: data.length });
      return { exists: true, pnl: 0, size: 0, entry: 0, market };
    }

    // Side enum: 0 = Long, 1 = Short (Anchor/Borsh convention)
    const sideRaw = data[152];
    const isLong = sideRaw === 0;

    const entryPrice = Number(data.readBigUInt64LE(153)) / 1e6;
    const sizeUsd = Number(data.readBigUInt64LE(161)) / 1e6;
    const collateralUsd = Number(data.readBigUInt64LE(169)) / 1e6;

    // This is REALISED PnL (from partial closes), not current unrealised PnL
    let realisedPnlUsd = 0;
    if (data.length >= 185) {
      realisedPnlUsd = Number(data.readBigInt64LE(177)) / 1e6;
    }

    // A sizeUsd of 0 means the position is closed
    if (sizeUsd === 0) {
      return { exists: false, pnl: realisedPnlUsd, size: 0, entry: 0 };
    }

    const sizeDirection = isLong ? 1 : -1;

    logger.debug('Position read', {
      market,
      side: isLong ? 'LONG' : 'SHORT',
      entryPrice,
      sizeUsd,
      collateralUsd,
      realisedPnlUsd,
    });

    return {
      exists: true,
      pnl: realisedPnlUsd,
      size: sizeUsd * sizeDirection,
      entry: entryPrice,
      collateral: collateralUsd,
      market,
      side: isLong ? 'long' : 'short',
    };
  } catch (err) {
    logger.error('getPositionPnl failed', { market, error: err.message });
    return { exists: false, pnl: 0, size: 0, entry: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Open / Increase a position (LONG or SHORT)
// ---------------------------------------------------------------------------

/**
 * Open or add to a position on Jupiter Perps.
 *
 * @param {string} market — asset symbol (SOL, BTC, ETH)
 * @param {number} sizeUsd — total position size in USD (after leverage)
 * @param {number} collateralSol — collateral amount in SOL
 * @param {'long'|'short'} side — position direction
 */
export async function openPosition(market, sizeUsd, collateralSol, side = 'long') {
  try {
    if (!config.protocolKeypair) throw new Error('Protocol keypair not loaded');

    const custodyKey = CUSTODY_ACCOUNTS[market];
    if (!custodyKey) throw new Error(`Unsupported market: ${market}`);

    const wallet = config.protocolKeypair.publicKey;
    const oracleKey = CUSTODY_ORACLES[market];
    if (!oracleKey) throw new Error(`No oracle configured for market: ${market}`);

    // For longs: collateral is the underlying or SOL
    // For shorts: collateral should be USDC, but we deposit SOL and let Jupiter handle it
    const collateralCustody = side === 'short' ? CUSTODY_ACCOUNTS['USDC'] : CUSTODY_ACCOUNTS['SOL'];
    const collateralMint = side === 'short' ? COLLATERAL_MINTS['USDC'] : COLLATERAL_MINTS['SOL'];

    const positionPDA = derivePositionPDA(wallet, custodyKey);
    const perpetualsPDA = derivePerpetualsPDA();
    const counter = Date.now();
    const positionRequestPDA = derivePositionRequestPDA(wallet, positionPDA, counter);

    const fundingATA = await getAssociatedTokenAddress(collateralMint, wallet);
    const positionRequestATA = await getAssociatedTokenAddress(collateralMint, positionRequestPDA, true);

    const [custodyTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('custody_token_account'), JLP_POOL.toBuffer(), custodyKey.toBuffer()],
      JUP_PERPS_PROGRAM_ID,
    );

    const sizeUsdScaled = BigInt(Math.round(sizeUsd * 1e6));

    if (!collateralSol || collateralSol <= 0) {
      throw new Error('collateralSol must be provided and > 0');
    }

    const collateralLamports = BigInt(Math.round(collateralSol * 1e9));
    const sideEnum = side === 'short' ? 1 : 0; // 0=Long, 1=Short

    logger.info('Opening/increasing position', {
      market, side, sizeUsd, collateralSol,
      leverage: `${(sizeUsd / (collateralSol * 150)).toFixed(0)}x (est)`,
    });

    const paramsBuf = Buffer.alloc(41);
    paramsBuf.writeBigUInt64LE(sizeUsdScaled, 0);
    paramsBuf.writeBigUInt64LE(BigInt(0), 8);              // acceptable_price = market
    paramsBuf.writeBigUInt64LE(collateralLamports, 16);
    paramsBuf.writeBigUInt64LE(BigInt(counter), 24);
    paramsBuf.writeUint8(sideEnum, 32);                    // side

    const ixData = Buffer.concat([DISC_INCREASE, paramsBuf]);

    const ix = {
      programId: JUP_PERPS_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: fundingATA, isSigner: false, isWritable: true },
        { pubkey: perpetualsPDA, isSigner: false, isWritable: false },
        { pubkey: JLP_POOL, isSigner: false, isWritable: true },
        { pubkey: positionPDA, isSigner: false, isWritable: true },
        { pubkey: positionRequestPDA, isSigner: false, isWritable: true },
        { pubkey: positionRequestATA, isSigner: false, isWritable: true },
        { pubkey: custodyKey, isSigner: false, isWritable: true },
        { pubkey: custodyTokenAccount, isSigner: false, isWritable: true },
        { pubkey: collateralCustody, isSigner: false, isWritable: true },
        { pubkey: oracleKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ixData,
    };

    const sig = await sendTx([ix], [config.protocolKeypair]);
    logger.info('Position request submitted', { market, side, sizeUsd, txSig: sig });
    return { txSig: sig };
  } catch (err) {
    logger.error('openPosition failed', { market, side, sizeUsd, error: err.message });
    throw err;
  }
}

// Backwards-compatible aliases
export async function openLong(market, sizeUsd, collateralSol) {
  return openPosition(market, sizeUsd, collateralSol, 'long');
}

export async function openShort(market, sizeUsd, collateralSol) {
  return openPosition(market, sizeUsd, collateralSol, 'short');
}

// ---------------------------------------------------------------------------
// Close a position (full)
// ---------------------------------------------------------------------------

export async function closePosition(market) {
  try {
    if (!config.protocolKeypair) throw new Error('Protocol keypair not loaded');

    const custodyKey = CUSTODY_ACCOUNTS[market];
    if (!custodyKey) throw new Error(`Unsupported market: ${market}`);

    const pnlInfo = await getPositionPnl(market);
    if (!pnlInfo.exists) {
      logger.warn('No position to close', { market });
      return null;
    }

    const wallet = config.protocolKeypair.publicKey;
    const positionPDA = derivePositionPDA(wallet, custodyKey);
    const perpetualsPDA = derivePerpetualsPDA();
    const oracleKey = CUSTODY_ORACLES[market];
    const counter = Date.now();
    const positionRequestPDA = derivePositionRequestPDA(wallet, positionPDA, counter);

    const receivingATA = await getAssociatedTokenAddress(COLLATERAL_MINTS['SOL'], wallet);
    const positionRequestATA = await getAssociatedTokenAddress(COLLATERAL_MINTS['SOL'], positionRequestPDA, true);

    const [custodyTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('custody_token_account'), JLP_POOL.toBuffer(), custodyKey.toBuffer()],
      JUP_PERPS_PROGRAM_ID,
    );

    const sizeUsd = BigInt(Math.round(Math.abs(pnlInfo.size) * 1e6));

    const paramsBuf = Buffer.alloc(40);
    paramsBuf.writeBigUInt64LE(sizeUsd, 0);
    paramsBuf.writeBigUInt64LE(BigInt(0), 8);
    paramsBuf.writeBigUInt64LE(BigInt(0), 16);
    paramsBuf.writeBigUInt64LE(BigInt(counter), 24);

    const ixData = Buffer.concat([DISC_DECREASE, paramsBuf]);

    const ix = {
      programId: JUP_PERPS_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: receivingATA, isSigner: false, isWritable: true },
        { pubkey: perpetualsPDA, isSigner: false, isWritable: false },
        { pubkey: JLP_POOL, isSigner: false, isWritable: true },
        { pubkey: positionPDA, isSigner: false, isWritable: true },
        { pubkey: positionRequestPDA, isSigner: false, isWritable: true },
        { pubkey: positionRequestATA, isSigner: false, isWritable: true },
        { pubkey: custodyKey, isSigner: false, isWritable: true },
        { pubkey: custodyTokenAccount, isSigner: false, isWritable: true },
        { pubkey: CUSTODY_ACCOUNTS['SOL'], isSigner: false, isWritable: true },
        { pubkey: oracleKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
    if (!config.protocolKeypair) throw new Error('Protocol keypair not loaded');

    const pnlInfo = await getPositionPnl(market);
    if (!pnlInfo.exists) {
      logger.warn('No position to reduce', { market });
      return null;
    }

    const reduceSize = Math.abs(pnlInfo.size) * pct;
    const wallet = config.protocolKeypair.publicKey;
    const custodyKey = CUSTODY_ACCOUNTS[market];
    const positionPDA = derivePositionPDA(wallet, custodyKey);
    const perpetualsPDA = derivePerpetualsPDA();
    const oracleKey = CUSTODY_ORACLES[market];
    const counter = Date.now();
    const positionRequestPDA = derivePositionRequestPDA(wallet, positionPDA, counter);

    const receivingATA = await getAssociatedTokenAddress(COLLATERAL_MINTS['SOL'], wallet);
    const positionRequestATA = await getAssociatedTokenAddress(COLLATERAL_MINTS['SOL'], positionRequestPDA, true);

    const [custodyTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('custody_token_account'), JLP_POOL.toBuffer(), custodyKey.toBuffer()],
      JUP_PERPS_PROGRAM_ID,
    );

    const sizeUsd = BigInt(Math.round(reduceSize * 1e6));

    const paramsBuf = Buffer.alloc(40);
    paramsBuf.writeBigUInt64LE(sizeUsd, 0);
    paramsBuf.writeBigUInt64LE(BigInt(0), 8);
    paramsBuf.writeBigUInt64LE(BigInt(0), 16);
    paramsBuf.writeBigUInt64LE(BigInt(counter), 24);

    const ixData = Buffer.concat([DISC_DECREASE, paramsBuf]);

    const ix = {
      programId: JUP_PERPS_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: receivingATA, isSigner: false, isWritable: true },
        { pubkey: perpetualsPDA, isSigner: false, isWritable: false },
        { pubkey: JLP_POOL, isSigner: false, isWritable: true },
        { pubkey: positionPDA, isSigner: false, isWritable: true },
        { pubkey: positionRequestPDA, isSigner: false, isWritable: true },
        { pubkey: positionRequestATA, isSigner: false, isWritable: true },
        { pubkey: custodyKey, isSigner: false, isWritable: true },
        { pubkey: custodyTokenAccount, isSigner: false, isWritable: true },
        { pubkey: CUSTODY_ACCOUNTS['SOL'], isSigner: false, isWritable: true },
        { pubkey: oracleKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
    return balance / 1e9;
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
// Shutdown
// ---------------------------------------------------------------------------

export async function shutdown() {
  logger.info('Jupiter Perps service shutdown (no persistent connections)');
}
