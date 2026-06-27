import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, VersionedTransaction } from '@solana/web3.js';
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

      // Primary: read Pyth oracle price directly from on-chain (no external API needed)
      try {
        const oracleKey = CUSTODY_ORACLES['SOL'];
        const oracleInfo = await conn.getAccountInfo(oracleKey);
        if (oracleInfo && oracleInfo.data && oracleInfo.data.length >= 96) {
          // Pyth v2 price account: aggregate price at offset 64, exponent is -8
          const priceRaw = oracleInfo.data.readBigInt64LE(64);
          solPrice = Number(priceRaw) * 1e-8;
        }
      } catch (oracleErr) {
        logger.debug('Pyth oracle read failed, trying APIs', { error: oracleErr.message });
      }

      // Fallback 1: Jupiter quote
      if (!solPrice || solPrice <= 0) {
        try {
          solPrice = await getSolPrice();
        } catch {}
      }

      // Fallback 2: CoinGecko
      if (!solPrice || solPrice <= 0) {
        try {
          const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
          if (cgRes.ok) {
            const cgData = await cgRes.json();
            solPrice = cgData?.solana?.usd || 0;
          }
        } catch {}
      }

      // Fallback 3: Binance
      if (!solPrice || solPrice <= 0) {
        try {
          const bnRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
          if (bnRes.ok) {
            const bnData = await bnRes.json();
            solPrice = parseFloat(bnData?.price) || 0;
          }
        } catch {}
      }

      logger.debug('Price resolved for PnL', { market, solPrice: solPrice.toFixed(2) });

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
// Open / Increase a position using Jupiter Perps v2 API
// The v2 API builds the transaction server-side with correct leverage,
// eliminating the keeper partial-fill issue from raw instructions.
// ---------------------------------------------------------------------------

/**
 * Open or add to a position on Jupiter Perps via v2 API.
 *
 * @param {string} market — asset symbol (SOL, BTC, ETH)
 * @param {number} sizeUsd — total position size in USD (after leverage) — used to calc leverage
 * @param {number} collateralSol — collateral amount in SOL
 * @param {'long'|'short'} side — position direction
 */
export async function openPosition(market, sizeUsd, collateralSol, side = 'long') {
  try {
    if (!config.protocolKeypair) throw new Error('Protocol keypair not loaded');

    const wallet = config.protocolKeypair.publicKey;
    const collateralLamports = Math.round(collateralSol * 1e9);

    // Calculate leverage from sizeUsd / collateral value
    const solPrice = await getSolPrice();
    const collateralUsd = collateralSol * solPrice;
    const leverage = collateralUsd > 0 ? Math.min(Math.round(sizeUsd / collateralUsd * 10) / 10, 250) : 100;

    logger.info('Opening position via Jupiter v2 API', {
      market, side, leverage: leverage + 'x',
      collateralSol, sizeUsd: sizeUsd.toFixed(0),
    });

    const resp = await fetch('https://perps-api.jup.ag/v2/positions/increase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: market,
        inputToken: side === 'short' ? 'USDC' : market,
        inputTokenAmount: collateralLamports.toString(),
        leverage: leverage.toFixed(1),
        side,
        walletAddress: wallet.toBase58(),
        maxSlippageBps: '300',
      }),
    });

    const data = await resp.json();

    if (!data.serializedTxBase64) {
      logger.error('Jupiter v2 API error', { market, side, error: data.message || JSON.stringify(data) });
      throw new Error('Jupiter v2 API failed: ' + (data.message || 'no transaction returned'));
    }

    logger.info('Jupiter v2 quote received', {
      market, side,
      quoteLeverage: data.quote?.leverage,
      quoteSize: data.quote?.positionSizeUsd,
    });

    // Sign and submit via Jupiter's transaction execute endpoint
    // (direct RPC sends expire before landing; Jupiter's infra is faster)
    const txBuf = Buffer.from(data.serializedTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([config.protocolKeypair]);
    const signedBase64 = Buffer.from(tx.serialize()).toString('base64');

    const execResp = await fetch('https://perps-api.jup.ag/v1/transaction/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'increase-position',
        serializedTxBase64: signedBase64,
      }),
    });
    const execData = await execResp.json();

    if (!execData.txid) {
      logger.error('Jupiter execute failed', { market, side, error: JSON.stringify(execData) });
      throw new Error('Jupiter execute failed: ' + (execData.message || JSON.stringify(execData)));
    }

    const sig = execData.txid;
    logger.info('Position submitted via Jupiter execute', {
      market, side, leverage: leverage + 'x', txSig: sig,
    });

    // -----------------------------------------------------------------------
    // Leverage correction: Jupiter's keeper often partially fills at lower
    // leverage. Wait for the fill, then send a follow-up size increase
    // (0 collateral) to reach the target leverage.
    // -----------------------------------------------------------------------
    try {
      await new Promise(r => setTimeout(r, 10000)); // wait for keeper fill

      const posResp = await fetch('https://perps-api.jup.ag/v1/positions?walletAddress=' + wallet.toBase58());
      const posData = await posResp.json();
      const pos = posData.dataList?.[0];

      if (pos) {
        const actualLev = parseFloat(pos.leverage) || 0;
        const targetLev = leverage;

        if (actualLev > 0 && actualLev < targetLev * 0.8) {
          // Keeper filled at lower leverage, send size increase to correct
          const currentSizeUsd = parseFloat(pos.sizeUsdDelta) || 0;
          const collateralUsdActual = parseFloat(pos.collateralUsd) || 0;
          const targetSizeUsd = Math.round(collateralUsdActual / 1e6 * targetLev * 1e6);
          const missingSizeUsd = targetSizeUsd - currentSizeUsd;

          if (missingSizeUsd > 100000) { // at least $0.10
            logger.info('Leverage correction: increasing size to reach target', {
              market, actualLev: actualLev.toFixed(1) + 'x', targetLev: targetLev + 'x',
              missingSizeUsd: (missingSizeUsd / 1e6).toFixed(0),
            });

            const corrResp = await fetch('https://perps-api.jup.ag/v2/positions/increase', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                asset: market,
                inputToken: side === 'short' ? 'USDC' : market,
                inputTokenAmount: '0',
                sizeUsdDelta: missingSizeUsd.toString(),
                side,
                walletAddress: wallet.toBase58(),
                maxSlippageBps: '300',
              }),
            });
            const corrData = await corrResp.json();

            if (corrData.serializedTxBase64) {
              const corrTxBuf = Buffer.from(corrData.serializedTxBase64, 'base64');
              const corrTx = VersionedTransaction.deserialize(corrTxBuf);
              corrTx.sign([config.protocolKeypair]);
              const corrSigned = Buffer.from(corrTx.serialize()).toString('base64');

              const corrExec = await fetch('https://perps-api.jup.ag/v1/transaction/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'increase-position', serializedTxBase64: corrSigned }),
              });
              const corrExecData = await corrExec.json();
              logger.info('Leverage correction submitted', {
                market, corrTxid: corrExecData.txid,
                expectedLev: corrData.quote?.leverage + 'x',
              });
            }
          }
        } else {
          logger.info('Leverage OK, no correction needed', { market, actualLev: actualLev.toFixed(1) + 'x' });
        }
      }
    } catch (corrErr) {
      logger.warn('Leverage correction failed (non-fatal)', { error: corrErr.message });
    }

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

    const wallet = config.protocolKeypair.publicKey;

    // Get current position from API
    const posResp = await fetch('https://perps-api.jup.ag/v1/positions?walletAddress=' + wallet.toBase58());
    const posData = await posResp.json();
    const pos = posData.dataList?.find(p => p.side === 'long' || p.side === 'short');

    if (!pos) {
      logger.warn('No position to close', { market });
      return null;
    }

    logger.info('Closing position via Jupiter API', {
      market, side: pos.side, size: pos.size, collateral: pos.collateral,
    });

    // Use v1 API for decrease (v2 may also work)
    const closeResp = await fetch('https://perps-api.jup.ag/v1/positions/decrease', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: market,
        desiredMint: 'So11111111111111111111111111111111111111112',
        collateralUsdDelta: pos.collateralUsd,
        sizeUsdDelta: pos.sizeUsdDelta,
        positionPubkey: pos.positionPubkey,
        side: pos.side,
        walletAddress: wallet.toBase58(),
        maxSlippageBps: '500',
      }),
    });

    const closeData = await closeResp.json();

    if (!closeData.serializedTxBase64) {
      logger.error('Jupiter close API error', { market, error: closeData.message || JSON.stringify(closeData) });
      throw new Error('Jupiter close API failed: ' + (closeData.message || 'no transaction'));
    }

    const txBuf = Buffer.from(closeData.serializedTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([config.protocolKeypair]);
    const signedBase64 = Buffer.from(tx.serialize()).toString('base64');

    const execResp = await fetch('https://perps-api.jup.ag/v1/transaction/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'decrease-position',
        serializedTxBase64: signedBase64,
      }),
    });
    const execData = await execResp.json();

    const sig = execData.txid || 'unknown';
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
