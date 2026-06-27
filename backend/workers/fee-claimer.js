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
    // Check claimable balance — skip if under 0.5 SOL
    try {
      const token = await db.getToken(mint);
      if (token?.sharingConfigPDA) {
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const conn = new Connection(config.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
        const pdaBalance = await conn.getBalance(new PublicKey(token.sharingConfigPDA));
        const pdaSol = pdaBalance / 1e9;
        if (pdaSol < 0.5) {
          logger.info('Below 0.5 SOL threshold, skipping', { mint, balance: pdaSol.toFixed(4) });
          return null;
        }
      }
    } catch (balErr) {
      logger.warn('Fee balance check failed (proceeding anyway)', { error: balErr.message });
    }

    // Execute claim
    const txSig = await claimFees(mint);
    if (!txSig) {
      logger.info('No fees to claim', { mint });
      return null;
    }

    // Wait for confirmation
    let feesClaimed = 0;
    try {
      const { Connection } = await import('@solana/web3.js');
      const conn = new Connection(config.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

      // Wait for confirmation
      await new Promise((r) => setTimeout(r, 3000));

      // Read the actual SOL delta from the confirmed transaction
      const txInfo = await conn.getTransaction(txSig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (txInfo && txInfo.meta && !txInfo.meta.err) {
        const accounts = txInfo.transaction.message.staticAccountKeys || txInfo.transaction.message.accountKeys;
        const protocolKey = config.PROTOCOL_PUBKEY.toBase58();

        for (let i = 0; i < accounts.length; i++) {
          const pubkey = typeof accounts[i] === 'string' ? accounts[i] : accounts[i].toBase58();
          if (pubkey === protocolKey) {
            const pre = txInfo.meta.preBalances[i] || 0;
            const post = txInfo.meta.postBalances[i] || 0;
            const delta = (post - pre) / 1e9;
            // delta is negative if only tx fee was paid, positive if fees were received
            // We want the gross received amount (ignore tx fee which is tiny)
            if (delta > 0) {
              feesClaimed = delta;
            } else {
              // Net negative means only tx fee was deducted, actual claim was 0
              feesClaimed = 0;
            }
            break;
          }
        }
      }

      logger.info('Transaction confirmed, measured fee delta', {
        mint,
        txSig,
        feesClaimed: feesClaimed.toFixed(6),
      });
    } catch (confirmErr) {
      logger.warn('Transaction measurement failed, checking balance directly', { error: confirmErr.message });
      // Fallback: check current balance and estimate
      const currentBalance = await getSolBalance(config.PROTOCOL_PUBKEY);
      logger.info('Current wallet balance (fallback)', { balance: currentBalance.toFixed(4) });
    }

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
