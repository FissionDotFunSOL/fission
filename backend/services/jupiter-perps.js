import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { createRequire } from 'module';
import crypto from 'crypto';
import config from '../config.js';
import logger from '../utils/logger.js';
import { getConnection, sendTx } from './solana.js';
import { getSolPrice, getQuote, getSwapTransaction } from './jupiter.js';

// ---------------------------------------------------------------------------
// Jupiter Perpetuals Service
//
// Uses the on-chain Anchor IDL to build correct instructions.
// Jupiter Perps uses a request-based model:
//   1. Submit a PositionRequest instruction on-chain
//   2. An automated keeper fulfils the request
// ---------------------------------------------------------------------------

const JUP_PERPS_PROGRAM_ID = new PublicKey(
  config.JUPITER_PERPS_PROGRAM_ID || 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
);

const JLP_POOL = new PublicKey(
  config.JLP_POOL_ADDRESS || '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq'
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

// Event authority PDA (required by current program version)
const [EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  JUP_PERPS_PROGRAM_ID,
);

// Referral — use system program (no referral)
const REFERRAL_ACCOUNT = new PublicKey('11111111111111111111111111111111');

// ---------------------------------------------------------------------------
// Anchor discriminator helper
//
// Jupiter Perps uses camelCase instruction names for discriminators.
// Discriminator = sha256("global:<instructionName>")[:8]
// ---------------------------------------------------------------------------

function anchorDiscriminator(instructionName) {
  const preimage = `global:${instructionName}`;
  const hash = crypto.createHash('sha256').update(preimage).digest();
  return hash.slice(0, 8);
}

// camelCase in IDL but snake_case for discriminator hash (confirmed from on-chain tx data)
const DISC_INCREASE = anchorDiscriminator('create_increase_position_market_request');
const DISC_DECREASE = anchorDiscriminator('create_decrease_position_market_request');

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

function derivePositionPDA(wallet, custodyKey, collateralCustodyKey, side) {
  // side: 1=Long, 2=Short
  const sideEnum = side === 'short' ? 2 : 1;
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('position'),
      wallet.toBuffer(),
      JLP_POOL.toBuffer(),
      custodyKey.toBuffer(),
      collateralCustodyKey.toBuffer(),
      Buffer.from([sideEnum]),
    ],
    JUP_PERPS_PROGRAM_ID,
  );
  return pda;
}

function derivePositionRequestPDA(positionPDA, counter, requestChange) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64LE(BigInt(counter));
  // requestChange: 1 = increase, 2 = decrease
  const requestChangeByte = requestChange === 'increase' ? 1 : 2;
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('position_request'),
      positionPDA.toBuffer(),
      counterBuf,
      Buffer.from([requestChangeByte]),
    ],
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
 *   152     side                     u8       1  (0=None, 1=Long, 2=Short)
 *   153     price                    u64      8  (entry price, scaled 1e6)
 *   161     sizeUsd                  u64      8  (position size after leverage, scaled 1e6)
 *   169     collateralUsd            u64      8  (collateral after fees, scaled 1e6)
 *   177     realisedPnlUsd           i64      8  (realised PnL from partial closes, scaled 1e6)
 *   185     cumulativeInterestSnap   u128     16
 *   201     lockedAmount             u64      8
 *   209     bump                     u8       1
 */
export async function getPositionPnl(market) {
  try {
    if (!config.protocolKeypair) {
      return { exists: false, pnl: 0, size: 0, entry: 0, error: 'No keypair' };
    }

    const custodyKey = CUSTODY_ACCOUNTS[market];
    if (!custodyKey) {
      return { exists: false, pnl: 0, size: 0, entry: 0, error: `Unsupported market: ${market}` };
    }

    const wallet = config.protocolKeypair.publicKey;
    const conn = getConnection();

    // Try long first, then short
    let positionPDA;
    let acctInfo;
    let detectedSide = 'long';
    for (const tryS of ['long', 'short']) {
      const cc = tryS === 'short' ? CUSTODY_ACCOUNTS['USDC'] : CUSTODY_ACCOUNTS['SOL'];
      const pda = derivePositionPDA(wallet, custodyKey, cc, tryS);
      const info = await conn.getAccountInfo(pda);
      if (info && info.data && info.data.length >= 210) {
        positionPDA = pda;
        acctInfo = info;
        detectedSide = tryS;
        break;
      }
    }
    if (!positionPDA) positionPDA = derivePositionPDA(wallet, custodyKey, CUSTODY_ACCOUNTS['SOL'], 'long');

    if (!acctInfo || !acctInfo.data || acctInfo.data.length < 210) {
      return { exists: false, pnl: 0, size: 0, entry: 0 };
    }

    const data = acctInfo.data;
    const entryRaw = data.readBigUInt64LE(153);
    const sizeRaw = data.readBigUInt64LE(161);
    const collateralRaw = data.readBigUInt64LE(169);

    const entry = Number(entryRaw) / 1e6;
    const sizeUsd = Number(sizeRaw) / 1e6;
    const collateralUsd = Number(collateralRaw) / 1e6;

    let pnl = 0;
    let currentPrice = 0;
    try {
      let solPrice = 0;
      try {
        solPrice = await getSolPrice();
      } catch {
        // Jupiter rate-limited
      }

      if (!solPrice || solPrice <= 0) {
        try {
          const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
          if (cgRes.ok) {
            const cgData = await cgRes.json();
            solPrice = cgData?.solana?.usd || 0;
          }
        } catch {}
      }

      // Third fallback: Binance public API
      if (!solPrice || solPrice <= 0) {
        try {
          const bnRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
          if (bnRes.ok) {
            const bnData = await bnRes.json();
            solPrice = parseFloat(bnData?.price) || 0;
          }
        } catch {}
      }

      currentPrice = market === 'SOL' ? solPrice
        : market === 'BTC' ? solPrice * 400
        : market === 'ETH' ? solPrice * 16
        : solPrice;

      if (entry > 0 && currentPrice > 0) {
        const sideEnum = data[152];
        const isLong = sideEnum === 1;
        pnl = isLong
          ? sizeUsd * ((currentPrice - entry) / entry)
          : sizeUsd * ((entry - currentPrice) / entry);
      }
    } catch (priceErr) {
      logger.warn('PnL price calculation failed', { market, error: priceErr.message });
    }

    const sideFromData = data[152] === 2 ? 'short' : 'long';
    return { exists: true, pnl, size: sizeUsd, entry, collateralUsd, side: sideFromData, currentPrice };
  } catch (err) {
    logger.error('getPositionPnl error', { market, error: err.message });
    return { exists: false, pnl: 0, size: 0, entry: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Open / Increase a position (LONG or SHORT) using Anchor IDL
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

    const isShort = side === 'short';
    const collateralCustody = isShort ? CUSTODY_ACCOUNTS['USDC'] : CUSTODY_ACCOUNTS['SOL'];
    const collateralMint = isShort ? COLLATERAL_MINTS['USDC'] : COLLATERAL_MINTS['SOL'];

    let collateralAmount;
    if (isShort) {
      const solPrice = await getSolPrice();
      if (solPrice <= 0) throw new Error('Cannot get SOL price for USDC swap');
      collateralAmount = BigInt(Math.round(collateralSol * solPrice * 1e6));
    } else {
      collateralAmount = BigInt(Math.round(collateralSol * 1e9));
    }

    const positionPDA = derivePositionPDA(wallet, custodyKey, collateralCustody, side);
    const perpetualsPDA = derivePerpetualsPDA();
    const counter = Math.floor(Math.random() * 1_000_000_000);
    const positionRequestPDA = derivePositionRequestPDA(positionPDA, counter, 'increase');


    const fundingATA = await getAssociatedTokenAddress(collateralMint, wallet);
    const positionRequestATA = await getAssociatedTokenAddress(collateralMint, positionRequestPDA, true);

    const sizeUsdScaled = BigInt(Math.round(sizeUsd * 1e6));

    // Slippage protection: 3% buffer
    let priceSlippage = BigInt(0);
    try {
      const solPrice = await getSolPrice();
      if (solPrice > 0) {
        const slippageMult = isShort ? 0.97 : 1.03;
        const priceEstimate = market === 'SOL' ? solPrice
          : market === 'BTC' ? solPrice * 400
          : market === 'ETH' ? solPrice * 16
          : solPrice;
        priceSlippage = BigInt(Math.round(priceEstimate * slippageMult * 1e6));
        logger.info('Slippage protection set', {
          market, side, priceEstimate: priceEstimate.toFixed(2),
          priceSlippage: (Number(priceSlippage) / 1e6).toFixed(2),
        });
      }
    } catch (err) {
      logger.warn('Could not set slippage protection', { error: err.message });
    }

    // Side enum: None=0, Long=1, Short=2
    const sideEnum = isShort ? 2 : 1;

    logger.info('Opening/increasing position', {
      market, side, sizeUsd, collateralSol,
    });

    // Setup instructions: create wSOL ATA + fund it
    const setupIxs = [];

    if (!isShort) {
      // For long SOL: create wSOL ATA if needed, transfer SOL, sync native
      setupIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet, fundingATA, wallet, collateralMint,
        ),
      );
      setupIxs.push(
        SystemProgram.transfer({
          fromPubkey: wallet,
          toPubkey: fundingATA,
          lamports: collateralAmount,
        }),
      );
      setupIxs.push(
        createSyncNativeInstruction(fundingATA),
      );
    }

    // Borsh-serialize params:
    // sizeUsdDelta: u64, collateralTokenDelta: u64, side: u8,
    // priceSlippage: u64, jupiterMinimumOut: Option<u64> (0=None), counter: u64
    const paramsBuf = Buffer.alloc(8 + 8 + 1 + 8 + 1 + 8); // 34 bytes
    paramsBuf.writeBigUInt64LE(sizeUsdScaled, 0);       // sizeUsdDelta
    paramsBuf.writeBigUInt64LE(collateralAmount, 8);     // collateralTokenDelta
    paramsBuf.writeUint8(sideEnum, 16);                  // side
    paramsBuf.writeBigUInt64LE(priceSlippage, 17);       // priceSlippage
    paramsBuf.writeUint8(0, 25);                         // jupiterMinimumOut = None
    paramsBuf.writeBigUInt64LE(BigInt(counter), 26);     // counter

    const ixData = Buffer.concat([DISC_INCREASE, paramsBuf]);

    // 16 accounts matching createIncreasePositionMarketRequest
    const ix = {
      programId: JUP_PERPS_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },           // owner
        { pubkey: fundingATA, isSigner: false, isWritable: true },      // fundingAccount
        { pubkey: perpetualsPDA, isSigner: false, isWritable: false },   // perpetuals
        { pubkey: JLP_POOL, isSigner: false, isWritable: false },       // pool
        { pubkey: positionPDA, isSigner: false, isWritable: true },     // position
        { pubkey: positionRequestPDA, isSigner: false, isWritable: true }, // positionRequest
        { pubkey: positionRequestATA, isSigner: false, isWritable: true }, // positionRequestAta
        { pubkey: custodyKey, isSigner: false, isWritable: false },     // custody
        { pubkey: collateralCustody, isSigner: false, isWritable: false }, // collateralCustody
        { pubkey: collateralMint, isSigner: false, isWritable: false }, // inputMint
        { pubkey: REFERRAL_ACCOUNT, isSigner: false, isWritable: false }, // referral
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // tokenProgram
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // associatedTokenProgram
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // systemProgram
        { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false }, // eventAuthority
        { pubkey: JUP_PERPS_PROGRAM_ID, isSigner: false, isWritable: false }, // program
      ],
      data: ixData,
    };

    const sig = await sendTx([...setupIxs, ix], [config.protocolKeypair]);
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
    const isShort = pnlInfo.side === 'short';
    const collateralCustody = isShort ? CUSTODY_ACCOUNTS['USDC'] : CUSTODY_ACCOUNTS['SOL'];
    const receivingMint = isShort ? COLLATERAL_MINTS['USDC'] : COLLATERAL_MINTS['SOL'];

    const positionPDA = derivePositionPDA(wallet, custodyKey, collateralCustody, pnlInfo.side);
    const perpetualsPDA = derivePerpetualsPDA();
    const counter = Math.floor(Math.random() * 1_000_000_000);
    const positionRequestPDA = derivePositionRequestPDA(positionPDA, counter, 'decrease');

    const receivingATA = await getAssociatedTokenAddress(receivingMint, wallet);
    const positionRequestATA = await getAssociatedTokenAddress(receivingMint, positionRequestPDA, true);

    const sizeUsd = BigInt(Math.round(Math.abs(pnlInfo.size) * 1e6));

    logger.info('Jupiter Perps: closing position', { market, side: pnlInfo.side, sizeUsd: Number(sizeUsd) / 1e6 });

    // Borsh-serialize decrease params:
    // collateralUsdDelta: u64, sizeUsdDelta: u64, priceSlippage: u64,
    // jupiterMinimumOut: Option<u64> (0=None), entirePosition: Option<bool> (1=Some + 1=true), counter: u64
    const paramsBuf = Buffer.alloc(8 + 8 + 8 + 1 + 2 + 8); // 35 bytes
    paramsBuf.writeBigUInt64LE(BigInt(0), 0);            // collateralUsdDelta
    paramsBuf.writeBigUInt64LE(sizeUsd, 8);              // sizeUsdDelta
    paramsBuf.writeBigUInt64LE(BigInt(0), 16);            // priceSlippage (0 = market)
    paramsBuf.writeUint8(0, 24);                          // jupiterMinimumOut = None
    paramsBuf.writeUint8(1, 25);                          // entirePosition = Some
    paramsBuf.writeUint8(1, 26);                          // entirePosition value = true
    paramsBuf.writeBigUInt64LE(BigInt(counter), 27);      // counter

    const ixData = Buffer.concat([DISC_DECREASE, paramsBuf]);

    const ix = {
      programId: JUP_PERPS_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: receivingATA, isSigner: false, isWritable: true },
        { pubkey: perpetualsPDA, isSigner: false, isWritable: false },
        { pubkey: JLP_POOL, isSigner: false, isWritable: false },
        { pubkey: positionPDA, isSigner: false, isWritable: true },
        { pubkey: positionRequestPDA, isSigner: false, isWritable: true },
        { pubkey: positionRequestATA, isSigner: false, isWritable: true },
        { pubkey: custodyKey, isSigner: false, isWritable: false },
        { pubkey: collateralCustody, isSigner: false, isWritable: false },
        { pubkey: receivingMint, isSigner: false, isWritable: false },
        { pubkey: REFERRAL_ACCOUNT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: JUP_PERPS_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: ixData,
    };

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
    const isShort = pnlInfo.side === 'short';
    const collateralCustody = isShort ? CUSTODY_ACCOUNTS['USDC'] : CUSTODY_ACCOUNTS['SOL'];
    const receivingMint = isShort ? COLLATERAL_MINTS['USDC'] : COLLATERAL_MINTS['SOL'];

    const positionPDA = derivePositionPDA(wallet, custodyKey, collateralCustody, pnlInfo.side);
    const perpetualsPDA = derivePerpetualsPDA();
    const counter = Math.floor(Math.random() * 1_000_000_000);
    const positionRequestPDA = derivePositionRequestPDA(positionPDA, counter, 'decrease');

    const receivingATA = await getAssociatedTokenAddress(receivingMint, wallet);
    const positionRequestATA = await getAssociatedTokenAddress(receivingMint, positionRequestPDA, true);

    const sizeUsd = BigInt(Math.round(reduceSize * 1e6));

    logger.info('Jupiter Perps: reducing position', { market, side: pnlInfo.side, pct, reduceSizeUsd: reduceSize });

    // entirePosition = Some(false) for partial close
    const paramsBuf = Buffer.alloc(8 + 8 + 8 + 1 + 2 + 8);
    paramsBuf.writeBigUInt64LE(BigInt(0), 0);
    paramsBuf.writeBigUInt64LE(sizeUsd, 8);
    paramsBuf.writeBigUInt64LE(BigInt(0), 16);
    paramsBuf.writeUint8(0, 24);
    paramsBuf.writeUint8(1, 25);                          // entirePosition = Some
    paramsBuf.writeUint8(0, 26);                          // entirePosition value = false
    paramsBuf.writeBigUInt64LE(BigInt(counter), 27);

    const ixData = Buffer.concat([DISC_DECREASE, paramsBuf]);

    const ix = {
      programId: JUP_PERPS_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: receivingATA, isSigner: false, isWritable: true },
        { pubkey: perpetualsPDA, isSigner: false, isWritable: false },
        { pubkey: JLP_POOL, isSigner: false, isWritable: false },
        { pubkey: positionPDA, isSigner: false, isWritable: true },
        { pubkey: positionRequestPDA, isSigner: false, isWritable: true },
        { pubkey: positionRequestATA, isSigner: false, isWritable: true },
        { pubkey: custodyKey, isSigner: false, isWritable: false },
        { pubkey: collateralCustody, isSigner: false, isWritable: false },
        { pubkey: receivingMint, isSigner: false, isWritable: false },
        { pubkey: REFERRAL_ACCOUNT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: JUP_PERPS_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: ixData,
    };

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
