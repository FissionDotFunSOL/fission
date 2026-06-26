import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import { swapSolForToken, burnTokens } from '../services/jupiter.js';
import { getTokenBalance } from '../services/solana.js';
import { getAllTokens } from '../db/firebase.js';

/**
 * Execute buyback for FISSION protocol token using creator fee allocations.
 *
 * 30% of ALL creator token fees are allocated to buying back the FISSION
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

    // Burn the FISSION tokens received
    let burnSig = null;
    let tokensBurned = 0;

    try {
      const balance = await getTokenBalance(config.protocolKeypair.publicKey, config.FISSION_TOKEN_MINT);
      if (balance > 0) {
        burnSig = await burnTokens(config.FISSION_TOKEN_MINT, balance);
        tokensBurned = balance;
        logger.info('FISSION tokens burned', { tokensBurned: balance, burnSig });
      }
    } catch (burnErr) {
      logger.error('FISSION burn step failed (swap succeeded)', { error: burnErr.message });
    }

    // Record buyback
    const buybackId = await db.addBuyback({
      tokenMint: mint,
      targetMint: config.FISSION_TOKEN_MINT,
      amountSol: availableSol,
      tokensBurned,
      swapTxSig: swapResult.signature,
      burnTxSig: burnSig,
      type: 'fission-buyback-burn',
    });

    logger.info('FISSION buyback & burn completed', {
      sourceMint: mint,
      amountSol: availableSol,
      tokensBurned,
      buybackId,
    });

    return {
      buybackId,
      amountSol: availableSol,
      tokensBurned,
      swapTxSig: swapResult.signature,
      burnTxSig: burnSig,
    };
  } catch (err) {
    logger.error('FISSION buyback failed', { mint, error: err.message, stack: err.stack });
    return null;
  }
}

/**
 * Execute buyback for the SOURCE TOKEN — the token whose creator fees
 * generated the perpetual position profits.
 *
 * 70% of take-profit proceeds buy back this token and burn it.
 * This creates direct buy pressure on the derivative token itself.
 */
export async function buybackSourceToken(mint) {
  logger.info('Starting source token buyback', { mint });

  try {
    const token = await db.getToken(mint);
    if (!token || token.status !== 'active') {
      logger.warn('Token not active, skipping source buyback', { mint });
      return null;
    }

    // Sum all source token buyback allocations
    const splits = await db.queryDocs('splits', [['tokenMint', '==', mint]], null, 500);
    const totalSourceAlloc = splits.reduce((sum, s) => sum + (s.sourceTokenBuyback || 0), 0);

    // Sum already-executed source buybacks
    const buybacks = await db.getBuybacksForToken(mint, 500);
    const totalSourceSpent = buybacks
      .filter(b => b.type === 'source-buyback-burn')
      .reduce((sum, b) => sum + (b.amountSol || 0), 0);

    const availableSol = totalSourceAlloc - totalSourceSpent;

    if (availableSol < 0.001) {
      logger.debug('Insufficient source token buyback funds', { mint, availableSol });
      return null;
    }

    logger.info('Executing source token buyback swap', {
      mint,
      solAmount: availableSol,
    });

    // Swap SOL → source token via Jupiter
    const swapResult = await swapSolForToken(mint, availableSol);

    // Burn the tokens received
    let burnSig = null;
    let tokensBurned = 0;

    try {
      const balance = await getTokenBalance(config.protocolKeypair.publicKey, mint);
      if (balance > 0) {
        burnSig = await burnTokens(mint, balance);
        tokensBurned = balance;
        logger.info('Source tokens burned', { mint, tokensBurned: balance, burnSig });
      }
    } catch (burnErr) {
      logger.error('Source token burn step failed (swap succeeded)', { mint, error: burnErr.message });
    }

    // Record buyback
    const buybackId = await db.addBuyback({
      tokenMint: mint,
      targetMint: mint,
      amountSol: availableSol,
      tokensBurned,
      swapTxSig: swapResult.signature,
      burnTxSig: burnSig,
      type: 'source-buyback-burn',
    });

    logger.info('Source token buyback & burn completed', {
      mint,
      amountSol: availableSol,
      tokensBurned,
      buybackId,
    });

    return {
      buybackId,
      amountSol: availableSol,
      tokensBurned,
      swapTxSig: swapResult.signature,
      burnTxSig: burnSig,
    };
  } catch (err) {
    logger.error('Source token buyback failed', { mint, error: err.message, stack: err.stack });
    return null;
  }
}

/**
 * Run BOTH buyback types for ALL active tokens:
 *   1. Source token buyback (70% of profits → buy the derivative token)
 *   2. FISSION buyback (30% of fees + 30% of profits → buy FISSION)
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
    const mint = token.id || token.mint;

    // 1. Source token buyback (from take-profit proceeds)
    const sourceResult = await buybackSourceToken(mint);
    if (sourceResult) results.push({ mint, type: 'source', ...sourceResult });

    // 2. FISSION buyback (from fee splits + take-profit proceeds)
    if (config.FISSION_TOKEN_MINT) {
      const fissionResult = await buybackFission(mint);
      if (fissionResult) results.push({ mint, type: 'fission', ...fissionResult });
    }
  }

  logger.info(`Buyback cycle complete: ${results.length} buybacks executed`);
  return results;
}
