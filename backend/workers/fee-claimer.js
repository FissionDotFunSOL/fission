import logger from '../utils/logger.js';
import config from '../config.js';
import { getAllTokens } from '../db/firebase.js';
import { sendTx } from '../services/solana.js';
import * as db from '../db/firebase.js';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Fee claiming using the CORRECT pump.fun instruction accounts.
//
// The pump SDK's buildDistributeCreatorFeesInstructions uses the wrong
// accounts (bonding curve as vault instead of the actual fee vault PDA).
// This was discovered by comparing successful manual claims on pump.fun
// with our SDK-built claims.
//
// The correct instruction format (discriminator a572670079cef751):
//   [0] coin account (Token-2022 mint PDA)
//   [1] pump program PDA (fee state)
//   [2] fee program PDA (sharing config state)
//   [3] fee SOL vault (where fees actually accumulate)
//   [4] system program
//   [5] event authority
//   [6] pump program (self)
//   [7] recipient wallet (signer)
// ---------------------------------------------------------------------------

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const DISTRIBUTE_DISC = Buffer.from('a572670079cef751', 'hex');
const EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

// Known fee account mapping for FISSION token
// These were extracted from successful pump.fun claims
const FEE_ACCOUNTS = {
  '2Ymo8SHM4yhhjvnjvZue6qXfQHUJXtZt2wUCgsMZpump': {
    coinAccount: new PublicKey('72CbNExR3v3CaftiEPEYnR7gUqqsjwpECRfhmXc7pump'),
    pumpPda: new PublicKey('5H59SfNDYhWvy9mcwUD4Pj1NQDtjMKDb2cNUmGsof25m'),
    feePda: new PublicKey('23RmERwaQYAgMW48aDWUW1ekH5eqjGotkkKdvdLxMhX2'),
    feeVault: new PublicKey('GuFxjDpKtVe5mEXGPHjBAP6pPdnUNtpv5ZAZf12BbaNn'),
  },
};

// Minimum claim threshold: 0.002 SOL (avoid wasting gas on tiny amounts)
const MIN_CLAIM_SOL = 0.002;

/**
 * Build the distribute creator fees instruction using the correct accounts.
 */
function buildDistributeIx(mint) {
  const accounts = FEE_ACCOUNTS[mint];
  if (!accounts) {
    logger.warn('No fee accounts configured for token', { mint });
    return null;
  }

  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    data: DISTRIBUTE_DISC,
    keys: [
      { pubkey: accounts.coinAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.pumpPda, isSigner: false, isWritable: true },
      { pubkey: accounts.feePda, isSigner: false, isWritable: true },
      { pubkey: accounts.feeVault, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: config.PROTOCOL_PUBKEY, isSigner: true, isWritable: true },
    ],
  });
}

/**
 * Run a fee-claiming cycle for a single token.
 */
export async function claimFeesForToken(mint) {
  try {
    const accounts = FEE_ACCOUNTS[mint];
    if (!accounts) {
      logger.debug('No fee accounts for token, skipping', { mint });
      return null;
    }

    // Check the fee vault balance directly (the actual source of truth)
    const conn = new Connection(config.SOLANA_RPC_URL, 'confirmed');
    const vaultBal = await conn.getBalance(accounts.feeVault);
    const vaultSol = vaultBal / 1e9;

    if (vaultSol < MIN_CLAIM_SOL) {
      logger.debug('Fee vault below threshold', {
        mint,
        vaultSol: vaultSol.toFixed(6),
        threshold: MIN_CLAIM_SOL,
      });
      return null;
    }

    logger.info('Fee vault has claimable fees', {
      mint,
      vaultSol: vaultSol.toFixed(6),
    });

    // Build the correct distribute instruction
    const ix = buildDistributeIx(mint);
    if (!ix) return null;

    // Get balance before
    const balBefore = await conn.getBalance(config.PROTOCOL_PUBKEY);

    const txSig = await sendTx([ix], [config.protocolKeypair]);

    // Wait for confirmation and measure delta
    await new Promise((r) => setTimeout(r, 3000));

    const balAfter = await conn.getBalance(config.PROTOCOL_PUBKEY);
    const deltaLamports = balAfter - balBefore;
    const feesClaimed = deltaLamports > 0 ? deltaLamports / 1e9 : 0;

    logger.info('Fee claim completed', {
      mint,
      txSig,
      feesClaimed: feesClaimed.toFixed(6),
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

    logger.info('Fees claimed and recorded', {
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
