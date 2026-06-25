import { PublicKey, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createBurnInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import config from '../config.js';
import logger from '../utils/logger.js';
import { getConnection, sendTx } from './solana.js';
import { solToLamports } from '../utils/helpers.js';

// ---------------------------------------------------------------------------
// Jupiter API helpers
// ---------------------------------------------------------------------------
const JUPITER_BASE = config.JUPITER_API_URL;

// SOL mint for Jupiter
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Get a swap quote from Jupiter.
 *
 * @param {string} inputMint  — input token mint (e.g. SOL)
 * @param {string} outputMint — output token mint (derivative)
 * @param {number} amountLamports — amount in smallest unit
 * @param {number} slippageBps — slippage tolerance in basis points
 */
export async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 100) {
  try {
    const url = new URL(`${JUPITER_BASE}/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amountLamports.toString());
    url.searchParams.set('slippageBps', slippageBps.toString());

    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jupiter quote failed (${res.status}): ${text}`);
    }
    const quote = await res.json();
    logger.debug('Jupiter quote received', {
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
    });
    return quote;
  } catch (err) {
    logger.error('getQuote error', { inputMint, outputMint, error: err.message });
    throw err;
  }
}

/**
 * Get a serialised swap transaction from Jupiter.
 */
export async function getSwapTransaction(quoteResponse, userPublicKey) {
  try {
    const res = await fetch(`${JUPITER_BASE}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: userPublicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jupiter swap failed (${res.status}): ${text}`);
    }

    const { swapTransaction } = await res.json();
    return swapTransaction;
  } catch (err) {
    logger.error('getSwapTransaction error', { error: err.message });
    throw err;
  }
}

/**
 * Execute a SOL → token swap via Jupiter and return the tx signature.
 *
 * @param {string} tokenMint — derivative token mint
 * @param {number} solAmount — amount of SOL to swap
 */
export async function swapSolForToken(tokenMint, solAmount) {
  if (!config.protocolKeypair) {
    throw new Error('Protocol keypair not loaded');
  }

  const lamports = solToLamports(solAmount);
  const quote = await getQuote(SOL_MINT, tokenMint, lamports);
  const swapTxB64 = await getSwapTransaction(quote, config.protocolKeypair.publicKey);

  // Deserialise and sign
  const conn = getConnection();
  const txBuf = Buffer.from(swapTxB64, 'base64');

  // Jupiter returns a versioned transaction
  const { VersionedTransaction } = await import('@solana/web3.js');
  const vtx = VersionedTransaction.deserialize(txBuf);
  vtx.sign([config.protocolKeypair]);

  const sig = await conn.sendRawTransaction(vtx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await conn.confirmTransaction(sig, 'confirmed');

  logger.info('Jupiter swap executed', { tokenMint, solAmount, signature: sig });
  return { signature: sig, outAmount: quote.outAmount };
}

// ---------------------------------------------------------------------------
// Burn SPL tokens
// ---------------------------------------------------------------------------

/**
 * Burn SPL tokens from the protocol wallet.
 *
 * @param {string} tokenMint — mint address
 * @param {number} amount    — UI amount to burn (will be converted using decimals)
 * @param {number} decimals  — token decimals (default 6)
 */
export async function burnTokens(tokenMint, amount, decimals = 6) {
  if (!config.protocolKeypair) {
    throw new Error('Protocol keypair not loaded');
  }

  const mintPk = new PublicKey(tokenMint);
  const ownerPk = config.protocolKeypair.publicKey;
  const ata = await getAssociatedTokenAddress(mintPk, ownerPk);

  const rawAmount = BigInt(Math.round(amount * 10 ** decimals));

  const burnIx = createBurnInstruction(
    ata,
    mintPk,
    ownerPk,
    rawAmount,
    [],
    TOKEN_PROGRAM_ID,
  );

  const sig = await sendTx([burnIx], [config.protocolKeypair]);
  logger.info('Tokens burned', { tokenMint, amount, signature: sig });
  return sig;
}

/**
 * Get the current SOL price in USDC from Jupiter.
 */
export async function getSolPrice() {
  try {
    // Get quote for 1 SOL -> USDC
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const quote = await getQuote(SOL_MINT, USDC_MINT, 1_000_000_000); // 1 SOL in lamports
    const price = parseInt(quote.outAmount) / 1e6; // USDC has 6 decimals
    return price;
  } catch (err) {
    logger.error('Failed to fetch SOL price', { error: err.message });
    return 0;
  }
}

export { SOL_MINT };
