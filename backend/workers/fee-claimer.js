import logger from '../utils/logger.js';
import config from '../config.js';
import { getAllTokens } from '../db/firebase.js';
import { sendTx } from '../services/solana.js';
import * as db from '../db/firebase.js';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Fee claiming for pump.fun tokens.
//
// Pump.fun tokens have TWO fee sources:
//   1. AMM creator vault -- fees from Raydium-style AMM trading (big money)
//   2. Bonding curve fee vault -- fees from bonding curve trades (small)
//
// The pump SDK was using wrong accounts and missing the AMM vault entirely.
// These accounts were extracted from successful manual claims on pump.fun.
// ---------------------------------------------------------------------------

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOC_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Discriminators
const AMM_COLLECT_DISC = Buffer.from('01214eb921432c5c', 'hex');
const BC_DISTRIBUTE_DISC = Buffer.from('a572670079cef751', 'hex');

// Known fee account mapping for FISSION token
// Extracted from successful pump.fun claims
const FEE_ACCOUNTS = {
  '2Ymo8SHM4yhhjvnjvZue6qXfQHUJXtZt2wUCgsMZpump': {
    // AMM fee accounts (Raydium-style AMM -- where the big fees are)
    amm: {
      pool1: new PublicKey('3suCrQaLH8e8yX3iwWjS1S8aPJPF3ZM5yjJ8wsa68dir'),
      pool2: new PublicKey('73pymGzbQZCQfG9HgpKQY1cz1B4CpMjvvPkDMKqbTWUc'),
      creatorVault: new PublicKey('62xpH6Sh9uL2ft3d7qTvHmRY9pmGss6AXosmcAaKut4X'),
      creatorWsolAta: new PublicKey('5kgW5CRXmRDdSUdMhFy4X3PPWyn4NvAbwspPeig7Ybet'),
      lpMintOrAuth: new PublicKey('9rhdVaraMrCz8vTenACe8z9wJfUJeVWmd5Qg4sLsHvqi'),
      ammGlobal: new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR'),
    },
    // Bonding curve fee accounts (small fees from BC trades)
    bc: {
      coinAccount: new PublicKey('72CbNExR3v3CaftiEPEYnR7gUqqsjwpECRfhmXc7pump'),
      pumpPda: new PublicKey('5H59SfNDYhWvy9mcwUD4Pj1NQDtjMKDb2cNUmGsof25m'),
      feePda: new PublicKey('23RmERwaQYAgMW48aDWUW1ekH5eqjGotkkKdvdLxMhX2'),
      feeVault: new PublicKey('GuFxjDpKtVe5mEXGPHjBAP6pPdnUNtpv5ZAZf12BbaNn'),
    },
  },
};

// Minimum claim threshold
const MIN_CLAIM_SOL = 0.002;

/**
 * Build the AMM creator fee collect instruction (the big one).
 */
function buildAmmCollectIx(mint) {
  const accounts = FEE_ACCOUNTS[mint]?.amm;
  if (!accounts) return null;

  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM,
    data: AMM_COLLECT_DISC,
    keys: [
      { pubkey: config.PROTOCOL_PUBKEY, isSigner: true, isWritable: true },
      { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ASSOC_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: accounts.pool1, isSigner: false, isWritable: true },
      { pubkey: accounts.pool2, isSigner: false, isWritable: true },
      { pubkey: accounts.creatorVault, isSigner: false, isWritable: true },
      { pubkey: accounts.creatorWsolAta, isSigner: false, isWritable: true },
      { pubkey: accounts.lpMintOrAuth, isSigner: false, isWritable: true },
      { pubkey: accounts.ammGlobal, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },
    ],
  });
}

/**
 * Build the bonding curve fee distribute instruction (small one).
 */
function buildBcDistributeIx(mint) {
  const accounts = FEE_ACCOUNTS[mint]?.bc;
  if (!accounts) return null;

  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    data: BC_DISTRIBUTE_DISC,
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
    const feeAccounts = FEE_ACCOUNTS[mint];
    if (!feeAccounts) {
      logger.debug('No fee accounts for token, skipping', { mint });
      return null;
    }

    const conn = new Connection(config.SOLANA_RPC_URL, 'confirmed');

    // Check AMM vault balance (the main fee source)
    const ammVaultBal = await conn.getBalance(feeAccounts.amm.creatorVault);
    const ammSol = ammVaultBal / 1e9;

    // Check BC fee vault
    const bcVaultBal = await conn.getBalance(feeAccounts.bc.feeVault);
    const bcSol = bcVaultBal / 1e9;

    const totalAvailable = ammSol + bcSol;

    if (totalAvailable < MIN_CLAIM_SOL) {
      logger.debug('Fees below threshold', {
        mint, ammSol: ammSol.toFixed(6), bcSol: bcSol.toFixed(6),
      });
      return null;
    }

    logger.info('Claimable fees found', {
      mint, ammSol: ammSol.toFixed(6), bcSol: bcSol.toFixed(6),
    });

    // Build instructions
    const instructions = [];

    // Always try AMM claim first (big fees)
    if (ammSol >= MIN_CLAIM_SOL) {
      const ammIx = buildAmmCollectIx(mint);
      if (ammIx) instructions.push(ammIx);
    }

    // Also claim BC fees if available
    if (bcSol >= MIN_CLAIM_SOL) {
      const bcIx = buildBcDistributeIx(mint);
      if (bcIx) instructions.push(bcIx);
    }

    if (instructions.length === 0) {
      return null;
    }

    // Get balance before
    const balBefore = await conn.getBalance(config.PROTOCOL_PUBKEY);

    // Try all instructions together, fall back to individual
    let txSig;
    try {
      txSig = await sendTx(instructions, [config.protocolKeypair]);
    } catch (combinedErr) {
      logger.warn('Combined claim failed, trying individually', { error: combinedErr.message });
      // Send them one by one
      for (const ix of instructions) {
        try {
          txSig = await sendTx([ix], [config.protocolKeypair]);
        } catch (singleErr) {
          logger.warn('Individual claim failed', { error: singleErr.message });
        }
      }
    }

    if (!txSig) {
      logger.warn('All claim attempts failed', { mint });
      return null;
    }

    // Wait for confirmation and measure delta
    await new Promise((r) => setTimeout(r, 4000));

    const balAfter = await conn.getBalance(config.PROTOCOL_PUBKEY);
    // Also check the wSOL intermediary account
    let wsolDelta = 0;
    try {
      const wsolBal = await conn.getBalance(feeAccounts.amm.creatorWsolAta);
      wsolDelta = wsolBal / 1e9;
    } catch {}

    const deltaLamports = balAfter - balBefore;
    const feesClaimed = Math.max(0, deltaLamports / 1e9) + wsolDelta;

    logger.info('Fee claim completed', {
      mint, txSig,
      feesClaimed: feesClaimed.toFixed(6),
      nativeDelta: (deltaLamports / 1e9).toFixed(6),
      wsolDelta: wsolDelta.toFixed(6),
    });

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
      runId, txSig,
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
