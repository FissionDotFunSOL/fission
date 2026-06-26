import config from '../config.js';
import logger from '../utils/logger.js';
import { getConnection, sendTx } from './solana.js';
import { VersionedTransaction } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Flash Trade V2 Perpetuals Service
//
// Flash Trade uses a transaction-builder REST API:
//   1. POST to /v2/transaction-builder/<action> to get unsigned tx
//   2. Sign the tx with our keypair
//   3. Submit to Flash V2 RPC endpoint
//
// Account setup (one-time, idempotent):
//   - init-deposit-ledger
//   - init-basket
// ---------------------------------------------------------------------------

const FLASH_API = config.FLASH_API_URL || 'https://flashapi.trade/v2';
const FLASH_RPC = config.FLASH_V2_RPC_URL || 'https://flash.magicblock.xyz';

// Track whether setup has been done this session
let setupDone = false;

// ---------------------------------------------------------------------------
// Account Setup (idempotent — safe to call multiple times)
// ---------------------------------------------------------------------------

async function ensureAccountSetup() {
  if (setupDone) return;
  if (!config.protocolKeypair) throw new Error('Protocol keypair not loaded');

  const wallet = config.protocolKeypair.publicKey.toBase58();

  try {
    // Init deposit ledger
    const ledgerRes = await fetch(`${FLASH_API}/transaction-builder/init-deposit-ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: wallet }),
    });

    if (ledgerRes.ok) {
      const { transaction } = await ledgerRes.json();
      if (transaction) {
        await signAndSubmitSetup(transaction);
        logger.info('Flash Trade: deposit ledger initialized');
      }
    }

    // Init basket
    const basketRes = await fetch(`${FLASH_API}/transaction-builder/init-basket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: wallet }),
    });

    if (basketRes.ok) {
      const { transaction } = await basketRes.json();
      if (transaction) {
        await signAndSubmitSetup(transaction);
        logger.info('Flash Trade: basket initialized');
      }
    }

    setupDone = true;
    logger.info('Flash Trade account setup complete');
  } catch (err) {
    // Non-fatal — accounts may already exist
    logger.warn('Flash Trade account setup warning (may already exist)', { error: err.message });
    setupDone = true; // Don't retry every cycle
  }
}

// Sign and submit a setup transaction to standard Solana RPC
async function signAndSubmitSetup(base64Tx) {
  const txBuf = Buffer.from(base64Tx, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([config.protocolKeypair]);

  const conn = getConnection();
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

// Sign and submit a trading transaction to Flash V2 RPC
async function signAndSubmitTrading(base64Tx) {
  const txBuf = Buffer.from(base64Tx, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([config.protocolKeypair]);

  const serialized = tx.serialize();
  const encoded = Buffer.from(serialized).toString('base64');

  // Submit to Flash V2 RPC (MagicBlock ephemeral rollup)
  const res = await fetch(FLASH_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [encoded, { encoding: 'base64', skipPreflight: true }],
    }),
  });

  const result = await res.json();
  if (result.error) {
    throw new Error(`Flash V2 RPC error: ${JSON.stringify(result.error)}`);
  }

  return result.result; // transaction signature
}

// ---------------------------------------------------------------------------
// Open / Increase a position
// ---------------------------------------------------------------------------

/**
 * Open or add to a position on Flash Trade.
 *
 * @param {string} market — asset symbol (BONK, WIF, JUP, etc.)
 * @param {number} sizeUsd — total position size in USD (after leverage)
 * @param {number} collateralSol — collateral amount in SOL
 * @param {'long'|'short'} side — position direction
 */
export async function openPosition(market, sizeUsd, collateralSol, side = 'long') {
  try {
    if (!config.protocolKeypair) throw new Error('Protocol keypair not loaded');

    await ensureAccountSetup();

    const wallet = config.protocolKeypair.publicKey.toBase58();
    const collateralUsd = collateralSol * (await getApproxSolPrice());

    logger.info('Flash Trade: opening position', {
      market,
      side,
      sizeUsd: sizeUsd.toFixed(2),
      collateralSol: collateralSol.toFixed(6),
      collateralUsd: collateralUsd.toFixed(2),
    });

    const res = await fetch(`${FLASH_API}/transaction-builder/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: wallet,
        marketSymbol: market,
        side: side === 'short' ? 'Short' : 'Long',
        sizeUsdUi: sizeUsd.toFixed(2),
        collateralUsdUi: collateralUsd.toFixed(2),
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Flash API error (${res.status}): ${errBody}`);
    }

    const { transaction, error } = await res.json();
    if (error) throw new Error(`Flash API returned error: ${error}`);
    if (!transaction) throw new Error('Flash API returned no transaction');

    const sig = await signAndSubmitTrading(transaction);

    logger.info('Flash Trade: position opened', {
      market, side, sizeUsd, sig,
    });

    return {
      success: true,
      signature: sig,
      market,
      side,
      sizeUsd,
      collateralSol,
      provider: 'flash',
    };
  } catch (err) {
    logger.error('Flash Trade openPosition failed', {
      market, side, sizeUsd, error: err.message,
    });
    return { success: false, error: err.message, provider: 'flash' };
  }
}

// ---------------------------------------------------------------------------
// Close a position
// ---------------------------------------------------------------------------

export async function closePosition(market, side = 'long') {
  try {
    if (!config.protocolKeypair) throw new Error('Protocol keypair not loaded');

    await ensureAccountSetup();

    const wallet = config.protocolKeypair.publicKey.toBase58();

    const res = await fetch(`${FLASH_API}/transaction-builder/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: wallet,
        marketSymbol: market,
        side: side === 'short' ? 'Short' : 'Long',
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Flash API error (${res.status}): ${errBody}`);
    }

    const { transaction, error } = await res.json();
    if (error) throw new Error(`Flash API returned error: ${error}`);
    if (!transaction) throw new Error('Flash API returned no transaction');

    const sig = await signAndSubmitTrading(transaction);

    logger.info('Flash Trade: position closed', { market, side, sig });
    return { success: true, signature: sig, provider: 'flash' };
  } catch (err) {
    logger.error('Flash Trade closePosition failed', { market, error: err.message });
    return { success: false, error: err.message, provider: 'flash' };
  }
}

// ---------------------------------------------------------------------------
// Get Position PnL
// ---------------------------------------------------------------------------

/**
 * Query position info from Flash Trade API.
 * Returns same shape as jupiter-perps.getPositionPnl() for compatibility.
 */
export async function getPositionPnl(market, side = 'long') {
  try {
    if (!config.protocolKeypair) {
      return { exists: false, pnl: 0, size: 0, entry: 0, error: 'No keypair', provider: 'flash' };
    }

    const wallet = config.protocolKeypair.publicKey.toBase58();

    const res = await fetch(
      `${FLASH_API}/positions?owner=${wallet}&marketSymbol=${market}&side=${side === 'short' ? 'Short' : 'Long'}`,
    );

    if (!res.ok) {
      return { exists: false, pnl: 0, size: 0, entry: 0, error: `API ${res.status}`, provider: 'flash' };
    }

    const data = await res.json();

    // Flash API returns position data or empty
    if (!data || !data.position || data.position.sizeUsd === 0) {
      return { exists: false, pnl: 0, size: 0, entry: 0, provider: 'flash' };
    }

    const pos = data.position;
    const isLong = (pos.side || '').toLowerCase() !== 'short';

    return {
      exists: true,
      pnl: pos.pnlUsd || 0,
      size: (pos.sizeUsd || 0) * (isLong ? 1 : -1),
      entry: pos.entryPrice || 0,
      collateral: pos.collateralUsd || 0,
      market,
      side: isLong ? 'long' : 'short',
      provider: 'flash',
    };
  } catch (err) {
    logger.error('Flash Trade getPositionPnl failed', { market, error: err.message });
    return { exists: false, pnl: 0, size: 0, entry: 0, error: err.message, provider: 'flash' };
  }
}

// ---------------------------------------------------------------------------
// Helper: get approximate SOL price (for collateral conversion)
// ---------------------------------------------------------------------------

async function getApproxSolPrice() {
  try {
    // Use Jupiter price API
    const res = await fetch('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112');
    if (res.ok) {
      const data = await res.json();
      const price = data?.data?.['So11111111111111111111111111111111111111112']?.price;
      if (price) return parseFloat(price);
    }
  } catch { /* fall through */ }
  return 150; // Fallback estimate
}
