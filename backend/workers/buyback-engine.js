import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import { swapSolForToken, burnTokens } from '../services/jupiter.js';
import { getTokenBalance } from '../services/solana.js';
import { getAllTokens } from '../db/firebase.js';

/**
 * Execute buyback & burn for a single token.
 *
 * 1. Sum up unspent buyback allocation from splits.
 * 2. Swap SOL → derivative token via Jupiter.
 * 3. Burn the received tokens.
 * 4. Record buyback in Firestore.
 */
export async function buybackAndBurn(mint) {
  logger.info('Starting buyback & burn', { mint });

  try {
    const token = await db.getToken(mint);
    if (!token || token.status !== 'active') {
      logger.warn('Token not active, skipping buyback', { mint });
      return null;
    }

    // Sum all buyback allocations for this token
    const splits = await db.queryDocs('splits', [['tokenMint', '==', mint]], null, 500);
    const totalBuybackAlloc = splits.reduce((sum, s) => sum + (s.buybackAmount || 0), 0);

    // Sum already-executed buybacks
    const buybacks = await db.getBuybacksForToken(mint, 500);
    const totalBuybackSpent = buybacks.reduce((sum, b) => sum + (b.amountSol || 0), 0);

    const availableSol = totalBuybackAlloc - totalBuybackSpent;

    if (availableSol < 0.001) {
      logger.debug('Insufficient buyback funds', { mint, availableSol });
      return null;
    }

    logger.info('Executing buyback swap', { mint, solAmount: availableSol });

    // Step 1: Swap SOL → token via Jupiter
    const swapResult = await swapSolForToken(mint, availableSol);

    // Step 2: Check token balance after swap
    const tokenBalance = await getTokenBalance(
      config.protocolKeypair.publicKey,
      mint,
    );

    if (tokenBalance <= 0) {
      logger.warn('No tokens received from swap', { mint });
      return null;
    }

    // Step 3: Burn all received tokens
    const burnSig = await burnTokens(mint, tokenBalance, token.decimals || 6);

    // Step 4: Record buyback
    const buybackId = await db.addBuyback({
      tokenMint: mint,
      amountSol: availableSol,
      tokensBurned: tokenBalance,
      swapTxSig: swapResult.signature,
      burnTxSig: burnSig,
    });

    logger.info('Buyback & burn completed', {
      mint,
      amountSol: availableSol,
      tokensBurned: tokenBalance,
      buybackId,
    });

    return {
      buybackId,
      amountSol: availableSol,
      tokensBurned: tokenBalance,
      swapTxSig: swapResult.signature,
      burnTxSig: burnSig,
    };
  } catch (err) {
    logger.error('Buyback & burn failed', { mint, error: err.message, stack: err.stack });
    return null;
  }
}

/**
 * Run buyback & burn for ALL active tokens.
 */
export async function buybackAllTokens() {
  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');

  if (active.length === 0) {
    logger.info('No active tokens for buyback');
    return [];
  }

  const results = [];
  for (const token of active) {
    const result = await buybackAndBurn(token.id || token.mint);
    if (result) results.push({ mint: token.id || token.mint, ...result });
  }

  logger.info(`Buyback cycle complete: ${results.length}/${active.length}`);
  return results;
}
