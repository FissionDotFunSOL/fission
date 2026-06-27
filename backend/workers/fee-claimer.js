import logger from '../utils/logger.js';
import config from '../config.js';
import { getAllTokens } from '../db/firebase.js';
import { buildClaimFeesIx } from '../services/pumpfun.js';
import { sendTx } from '../services/solana.js';
import { getSolBalance } from '../services/solana.js';
import * as db from '../db/firebase.js';
import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Run a fee-claiming cycle for a single token.
 *
 * 1. Checks if there are distributable fees (avoids wasting SOL on empty claims).
 * 2. Claims fees via Pump.fun distribute instruction.
 * 3. Measures the actual SOL received from the tx.
 * 4. Splits the claimed amount 70/30 (perps / FISSION buyback).
 * 5. Records the run + split in Firestore.
 */
export async function claimFeesForToken(mint) {
  logger.info('Starting fee claim', { mint });

  try {
    // Check if there are actually fees to distribute before sending a tx
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const sdk = require('@pump-fun/pump-sdk');
      const conn = new Connection(config.SOLANA_RPC_URL, 'confirmed');
      const pump = new sdk.OnlinePumpSdk(conn);
      const mintPk = new PublicKey(mint);

      const feeInfo = await pump.getMinimumDistributableFee(mintPk);
      const distributable = feeInfo?.distributableFees?.toNumber?.() || 0;

      if (distributable === 0) {
        logger.debug('No distributable fees, skipping', { mint });
        return null;
      }

      logger.info('Distributable fees found', {
        mint,
        distributableLamports: distributable,
        distributableSol: (distributable / 1e9).toFixed(6),
      });
    } catch (checkErr) {
      // If check fails, proceed with claim anyway (might still work)
      logger.debug('Fee check failed, proceeding with claim attempt', {
        mint,
        error: checkErr.message,
      });
    }

    // Build and send the claim transaction
    const { instructions, method } = await buildClaimFeesIx(mint);

    if (!instructions || instructions.length === 0) {
      logger.debug('No claim instructions', { mint });
      return null;
    }

    // Get balance before
    const conn = new Connection(config.SOLANA_RPC_URL, 'confirmed');
    const balBefore = await conn.getBalance(config.PROTOCOL_PUBKEY);

    const txSig = await sendTx(instructions, [config.protocolKeypair]);

    // Wait for confirmation and measure delta
    await new Promise((r) => setTimeout(r, 3000));

    const balAfter = await conn.getBalance(config.PROTOCOL_PUBKEY);
    const deltaLamports = balAfter - balBefore;
    // delta > 0 means we received SOL (fees claimed minus tx fee)
    // delta < 0 means only tx fee was paid (no fees claimed)
    const feesClaimed = deltaLamports > 0 ? deltaLamports / 1e9 : 0;

    logger.info('Fee claim tx confirmed', {
      mint,
      method,
      txSig,
      feesClaimed: feesClaimed.toFixed(6),
      balBefore: (balBefore / 1e9).toFixed(4),
      balAfter: (balAfter / 1e9).toFixed(4),
    });

    // Only record if we actually received fees
    if (feesClaimed <= 0) {
      logger.info('Claim tx sent but 0 fees received', { mint, txSig });
      return null;
    }

    // Compute split (70% perps, 30% buyback)
    const split = {
      positionAmount: feesClaimed * config.FEE_SPLIT.positionFund,
      buybackAmount: feesClaimed * config.FEE_SPLIT.buyback,
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
      positionAmount: split.positionAmount.toFixed(6),
      buybackAmount: split.buybackAmount.toFixed(6),
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
