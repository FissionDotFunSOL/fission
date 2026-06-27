import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import { getConnection } from '../services/solana.js';

/**
 * Scans recent transactions on the protocol wallet for Pump.fun fee distributions
 * from tokens not yet registered in the DB. Auto-registers any new ones found.
 */
export async function discoverNewTokens() {
  logger.info('Running token auto-discovery');

  try {
    const conn = getConnection();
    const wallet = config.PROTOCOL_PUBKEY;

    // Get existing tokens
    const existingTokens = await db.getAllTokens();
    const existingMints = new Set(existingTokens.map(t => t.id || t.mint));

    // Scan last 100 transactions for pump token interactions
    const sigs = await conn.getSignaturesForAddress(wallet, { limit: 100 });
    const newMints = new Set();

    for (const sig of sigs) {
      try {
        const tx = await conn.getTransaction(sig.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (!tx || !tx.meta) continue;

        const logs = tx.meta.logMessages?.join(' ') || '';
        // Only look at Pump.fun fee distribution txs
        if (!logs.includes('distribute') && !logs.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')) continue;

        const accounts = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
        for (const acc of accounts) {
          const pk = typeof acc === 'string' ? acc : acc.toBase58();
          if (pk.endsWith('pump') && !existingMints.has(pk) && !newMints.has(pk)) {
            // Skip FISSION token itself
            if (pk === config.FISSION_TOKEN_MINT) continue;
            newMints.add(pk);
          }
        }
      } catch (e) {
        // Skip failed tx parsing
      }
    }

    if (newMints.size === 0) {
      logger.info('No new tokens discovered');
      return { discovered: 0 };
    }

    logger.info('Found new tokens to register', { count: newMints.size });

    let registered = 0;
    for (const mint of newMints) {
      try {
        // Fetch token info from Pump.fun API
        const resp = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`);
        if (!resp.ok) {
          logger.warn('Pump.fun API failed for mint', { mint: mint.slice(0, 16), status: resp.status });
          continue;
        }
        const data = await resp.json();

        const tokenData = {
          mint,
          name: data.name || 'Unknown',
          symbol: data.symbol || 'UNK',
          image: data.image_uri || '',
          underlying: 'SOL',
          perpsMarket: 'SOL',
          provider: 'jupiter',
          side: 'long',
          leverage: 100,
          createdAt: Date.now(),
          status: 'active',
          autoDiscovered: true,
        };

        await db.setToken(mint, tokenData);
        registered++;
        logger.info('Auto-registered new token', {
          mint: mint.slice(0, 16),
          symbol: data.symbol,
          name: data.name,
        });
      } catch (e) {
        logger.warn('Failed to auto-register token', { mint: mint.slice(0, 16), error: e.message });
      }
    }

    logger.info('Token discovery complete', { discovered: newMints.size, registered });
    return { discovered: newMints.size, registered };
  } catch (err) {
    logger.error('Token discovery failed', { error: err.message });
    throw err;
  }
}
