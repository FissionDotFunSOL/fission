import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import { swapSolForToken } from '../services/jupiter.js';
import { getAllTokens } from '../db/firebase.js';

/**
 * Execute buyback for FISSION protocol token using creator fee allocations.
 *
 * 20% of ALL creator token fees are allocated to buying back the FISSION
 * protocol token. This creates constant buy pressure on FISSION from every
 * token launched on the platform.
 *
 * Flow:
 *   1. Sum up unspent buyback allocations across all tokens.
 *   2. Swap SOL → FISSION via Jupiter.
 *   3. Hold FISSION in the protocol wallet (or burn — configurable later).
 *   4. Record buyback in Firestore.
 */
export async function buybackFission(mint) {
  logger.info('Starting FISSION buyback', { sourceMint: mint });

  try {
    // Check FISSION token is configured
    if (!config.FISSION_TOKEN_MINT) {
      logger.debug('FISSION_TOKEN_MINT not set — buyback skipped (set in .env when token is launched)');
      return null;
    }

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

    logger.info('Executing FISSION buyback swap', {
      sourceMint: mint,
      solAmount: availableSol,
      targetMint: config.FISSION_TOKEN_MINT,
    });

    // Swap SOL → FISSION via Jupiter
    const swapResult = await swapSolForToken(config.FISSION_TOKEN_MINT, availableSol);

    // Record buyback
    const buybackId = await db.addBuyback({
      tokenMint: mint,
      targetMint: config.FISSION_TOKEN_MINT,
      amountSol: availableSol,
      tokensReceived: swapResult.outputAmount || 0,
      swapTxSig: swapResult.signature,
      type: 'fission-buyback',
    });

    logger.info('FISSION buyback completed', {
      sourceMint: mint,
      amountSol: availableSol,
      tokensReceived: swapResult.outputAmount || 0,
      buybackId,
    });

    return {
      buybackId,
      amountSol: availableSol,
      tokensReceived: swapResult.outputAmount || 0,
      swapTxSig: swapResult.signature,
    };
  } catch (err) {
    logger.error('FISSION buyback failed', { mint, error: err.message, stack: err.stack });
    return null;
  }
}

/**
 * Run FISSION buyback for ALL active tokens.
 */
export async function buybackAllTokens() {
  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');

  if (active.length === 0) {
    logger.info('No active tokens for buyback');
    return [];
  }

  if (!config.FISSION_TOKEN_MINT) {
    logger.info('FISSION_TOKEN_MINT not configured — buyback engine idle');
    return [];
  }

  const results = [];
  for (const token of active) {
    const result = await buybackFission(token.id || token.mint);
    if (result) results.push({ mint: token.id || token.mint, ...result });
  }

  logger.info(`FISSION buyback cycle complete: ${results.length}/${active.length}`);
  return results;
}
