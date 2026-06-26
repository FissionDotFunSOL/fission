import logger from '../utils/logger.js';
import config from '../config.js';
import { getAllTokens } from '../db/firebase.js';
import { claimFees } from '../services/pumpfun.js';
import { getSolBalance } from '../services/solana.js';
import { lamportsToSol } from '../utils/helpers.js';
import * as db from '../db/firebase.js';

/**
 * Run a fee-claiming cycle for a single token.
 *
 * 1. Claims fees via Pump.fun distribute instruction.
 * 2. Checks the protocol wallet SOL balance delta.
 * 3. Splits the claimed amount 70/30 (perps / FISSION buyback).
 * 4. Records the run + split in Firestore.
 *
 * @param {string} mint — token mint address
 * @returns {{ runId: string, feesClaimed: number, split: object } | null}
 */
export async function claimFeesForToken(mint) {
  logger.info('Starting fee claim', { mint });

  try {
    // Snapshot balance before
    const balanceBefore = await getSolBalance(config.PROTOCOL_PUBKEY);

    // Execute claim
    const txSig = await claimFees(mint);
    if (!txSig) {
      logger.info('No fees to claim', { mint });
      return null;
    }

    // Wait for confirmed transaction before measuring balance delta
    // This is more reliable than a fixed 2-second delay
    try {
      const { Connection } = await import('@solana/web3.js');
      const conn = new Connection(config.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
      await conn.confirmTransaction(txSig, 'confirmed');
    } catch (confirmErr) {
      logger.warn('Transaction confirmation wait failed, using fallback delay', { error: confirmErr.message });
      await new Promise((r) => setTimeout(r, 4000));
    }

    const balanceAfter = await getSolBalance(config.PROTOCOL_PUBKEY);
    const feesClaimed = Math.max(0, balanceAfter - balanceBefore);

    // Compute split
    const split = {
      positionAmount: feesClaimed * config.FEE_SPLIT.positionFund,
      buybackAmount:  feesClaimed * config.FEE_SPLIT.buyback,
    };

    // Persist run
    const runId = await db.addRun({
      tokenMint: mint,
      feesClaimed,
      txSig,
    });

    // Persist split
    await db.addSplit({
      runId,
      tokenMint: mint,
      ...split,
    });

    logger.info('Fee claim completed', {
      mint,
      feesClaimed: feesClaimed.toFixed(6),
      runId,
      txSig,
    });

    return { runId, feesClaimed, split, txSig };
  } catch (err) {
    logger.error('Fee claim failed', { mint, error: err.message, stack: err.stack });
    return null;
  }
}

/**
 * Run fee claiming for ALL active tokens.
 */
export async function claimAllFees() {
  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');

  if (active.length === 0) {
    logger.info('No active tokens to claim fees for');
    return [];
  }

  const results = [];
  for (const token of active) {
    const result = await claimFeesForToken(token.id || token.mint);
    if (result) results.push(result);
  }

  logger.info(`Fee claim cycle complete: ${results.length}/${active.length} tokens claimed`);
  return results;
}
