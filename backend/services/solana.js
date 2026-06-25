import {
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import config from '../config.js';
import logger from '../utils/logger.js';
import { lamportsToSol } from '../utils/helpers.js';

// ---------------------------------------------------------------------------
// Connection singleton
// ---------------------------------------------------------------------------
let _conn = null;

export function getConnection() {
  if (!_conn) {
    _conn = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60_000,
    });
    logger.info('Solana RPC connection created', { rpc: config.SOLANA_RPC_URL });
  }
  return _conn;
}

// ---------------------------------------------------------------------------
// Balance helpers
// ---------------------------------------------------------------------------
export async function getSolBalance(pubkey) {
  try {
    const conn = getConnection();
    const pk = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
    const lamports = await conn.getBalance(pk);
    return lamportsToSol(lamports);
  } catch (err) {
    logger.error('getSolBalance failed', { error: err.message });
    throw err;
  }
}

export async function getTokenBalance(ownerPubkey, mintPubkey) {
  try {
    const conn = getConnection();
    const owner = typeof ownerPubkey === 'string' ? new PublicKey(ownerPubkey) : ownerPubkey;
    const mint  = typeof mintPubkey === 'string' ? new PublicKey(mintPubkey) : mintPubkey;

    const resp = await conn.getParsedTokenAccountsByOwner(owner, { mint });
    if (resp.value.length === 0) return 0;
    return resp.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  } catch (err) {
    logger.error('getTokenBalance failed', { error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------
export function derivePDA(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------
export async function sendTx(instructions, signers = []) {
  const conn = getConnection();
  const tx = new Transaction();
  for (const ix of instructions) {
    tx.add(ix);
  }

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0]?.publicKey || config.protocolKeypair?.publicKey;

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, {
      commitment: 'confirmed',
      maxRetries: 3,
    });
    logger.info('Transaction confirmed', { signature: sig });
    return sig;
  } catch (err) {
    logger.error('Transaction failed', { error: err.message });
    throw err;
  }
}

/**
 * Fetch an account's data (raw bytes).
 */
export async function getAccountInfo(pubkey) {
  const conn = getConnection();
  const pk = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
  return conn.getAccountInfo(pk);
}

export { Connection, PublicKey, Transaction };
