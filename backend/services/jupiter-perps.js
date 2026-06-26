import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
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

// Event authority PDA (required for new program version)
const [EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  JUP_PERPS_PROGRAM_ID,
);

// Referral — use default (no referral)
const REFERRAL_ACCOUNT = new PublicKey('11111111111111111111111111111111');

// ---------------------------------------------------------------------------
// Anchor IDL-based Program (lazy loaded)
// ---------------------------------------------------------------------------

let _program = null;

async function getPerpsProgram() {
  if (_program) return _program;

  try {
    const require = createRequire(import.meta.url);
    const { Program, AnchorProvider } = require('@coral-xyz/anchor');
    const { PublicKey: CjsPublicKey } = require('@solana/web3.js');

    const conn = getConnection();

    // Use CJS PublicKey for the wallet — Anchor needs matching class instances
    const walletPubkey = config.protocolKeypair?.publicKey
      ? new CjsPublicKey(config.protocolKeypair.publicKey.toBase58())
      : CjsPublicKey.default;

    const dummyWallet = {
      publicKey: walletPubkey,
      signTransaction: (tx) => tx,
      signAllTransactions: (txs) => txs,
    };

    const provider = new AnchorProvider(conn, dummyWallet, {
      commitment: 'confirmed',
      skipPreflight: false,
    });

    // Convert program ID to CJS PublicKey
    const programId = new CjsPublicKey(JUP_PERPS_PROGRAM_ID.toBase58());

    const idl = await Program.fetchIdl(programId, provider);
    if (!idl) throw new Error('Could not fetch Jupiter Perps IDL from chain');

    _program = new Program(idl, programId, provider);
    logger.info('Jupiter Perps Anchor program loaded', {
      instructionCount: idl.instructions.length,
    });

    return _program;
  } catch (err) {
    logger.error('Failed to load Jupiter Perps program', { error: err.message });
    throw err;
  }
}

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
    const positionPDA = derivePositionPDA(wallet, custodyKey);
    const conn = getConnection();
    const acctInfo = await conn.getAccountInfo(positionPDA);

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
    try {
      const solPrice = await getSolPrice();
      const currentPrice = market === 'SOL' ? solPrice
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
    } catch {
      // Can't compute unrealised PnL without price, return 0
    }

    return { exists: true, pnl, size: sizeUsd, entry, collateralUsd };
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

    const program = await getPerpsProgram();
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

    const positionPDA = derivePositionPDA(wallet, custodyKey);
    const perpetualsPDA = derivePerpetualsPDA();
    const counter = Date.now();
    const positionRequestPDA = derivePositionRequestPDA(wallet, positionPDA, counter);

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

    logger.info('Opening/increasing position via Anchor', {
      market, side, sizeUsd, collateralSol,
    });

    // Build instruction using Anchor's Program methods
    // Side enum: { none: {}, long: {}, short: {} }
    const sideArg = isShort ? { short: {} } : { long: {} };

    const require = createRequire(import.meta.url);
    const { BN } = require('@coral-xyz/anchor');

    const ix = await program.methods
      .createIncreasePositionMarketRequest({
        sizeUsdDelta: new BN(sizeUsdScaled.toString()),
        collateralTokenDelta: new BN(collateralAmount.toString()),
        side: sideArg,
        priceSlippage: new BN(priceSlippage.toString()),
        jupiterMinimumOut: null,
        counter: new BN(counter),
      })
      .accounts({
        owner: wallet.toBase58(),
        fundingAccount: fundingATA.toBase58(),
        perpetuals: perpetualsPDA.toBase58(),
        pool: JLP_POOL.toBase58(),
        position: positionPDA.toBase58(),
        positionRequest: positionRequestPDA.toBase58(),
        positionRequestAta: positionRequestATA.toBase58(),
        custody: custodyKey.toBase58(),
        collateralCustody: collateralCustody.toBase58(),
        inputMint: collateralMint.toBase58(),
        referral: REFERRAL_ACCOUNT.toBase58(),
        tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
        systemProgram: SystemProgram.programId.toBase58(),
        eventAuthority: EVENT_AUTHORITY.toBase58(),
        program: JUP_PERPS_PROGRAM_ID.toBase58(),
      })
      .instruction();

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

    const program = await getPerpsProgram();
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
    const counter = Date.now();
    const positionRequestPDA = derivePositionRequestPDA(wallet, positionPDA, counter);

    const isShort = pnlInfo.side === 'short';
    const receivingMint = isShort ? COLLATERAL_MINTS['USDC'] : COLLATERAL_MINTS['SOL'];
    const collateralCustody = isShort ? CUSTODY_ACCOUNTS['USDC'] : CUSTODY_ACCOUNTS['SOL'];

    const receivingATA = await getAssociatedTokenAddress(receivingMint, wallet);
    const positionRequestATA = await getAssociatedTokenAddress(receivingMint, positionRequestPDA, true);

    const sizeUsd = Math.round(Math.abs(pnlInfo.size) * 1e6);

    const require = createRequire(import.meta.url);
    const { BN } = require('@coral-xyz/anchor');

    logger.info('Jupiter Perps: closing position via Anchor', { market, side: pnlInfo.side, sizeUsd: sizeUsd / 1e6 });

    const ix = await program.methods
      .createDecreasePositionMarketRequest({
        collateralUsdDelta: new BN(0),
        sizeUsdDelta: new BN(sizeUsd),
        priceSlippage: new BN(0),
        jupiterMinimumOut: null,
        entirePosition: true,
        counter: new BN(counter),
      })
      .accounts({
        owner: wallet,
        receivingAccount: receivingATA,
        perpetuals: perpetualsPDA,
        pool: JLP_POOL,
        position: positionPDA,
        positionRequest: positionRequestPDA,
        positionRequestAta: positionRequestATA,
        custody: custodyKey,
        collateralCustody: collateralCustody,
        desiredMint: receivingMint,
        referral: REFERRAL_ACCOUNT,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        eventAuthority: EVENT_AUTHORITY,
        program: JUP_PERPS_PROGRAM_ID,
      })
      .instruction();

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

    const program = await getPerpsProgram();
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
    const counter = Date.now();
    const positionRequestPDA = derivePositionRequestPDA(wallet, positionPDA, counter);

    const isShort = pnlInfo.side === 'short';
    const receivingMint = isShort ? COLLATERAL_MINTS['USDC'] : COLLATERAL_MINTS['SOL'];
    const collateralCustody = isShort ? CUSTODY_ACCOUNTS['USDC'] : CUSTODY_ACCOUNTS['SOL'];

    const receivingATA = await getAssociatedTokenAddress(receivingMint, wallet);
    const positionRequestATA = await getAssociatedTokenAddress(receivingMint, positionRequestPDA, true);

    const sizeUsd = Math.round(reduceSize * 1e6);

    const require = createRequire(import.meta.url);
    const { BN } = require('@coral-xyz/anchor');

    logger.info('Jupiter Perps: reducing position via Anchor', { market, side: pnlInfo.side, pct, reduceSizeUsd: reduceSize });

    const ix = await program.methods
      .createDecreasePositionMarketRequest({
        collateralUsdDelta: new BN(0),
        sizeUsdDelta: new BN(sizeUsd),
        priceSlippage: new BN(0),
        jupiterMinimumOut: null,
        entirePosition: false,
        counter: new BN(counter),
      })
      .accounts({
        owner: wallet,
        receivingAccount: receivingATA,
        perpetuals: perpetualsPDA,
        pool: JLP_POOL,
        position: positionPDA,
        positionRequest: positionRequestPDA,
        positionRequestAta: positionRequestATA,
        custody: custodyKey,
        collateralCustody: collateralCustody,
        desiredMint: receivingMint,
        referral: REFERRAL_ACCOUNT,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        eventAuthority: EVENT_AUTHORITY,
        program: JUP_PERPS_PROGRAM_ID,
      })
      .instruction();

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
