import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import { getProvider } from '../services/chain.js';
import { getTokenMetadata, detectLaunchpad, verifyCreatorConfig } from '../services/pons.js';
import { DEFAULT_STRATEGY } from '../services/strategies.js';

/**
 * Auto-discovery: registers tokens that route fees to the protocol wallet
 * WITHOUT the site's register step (which also still works).
 *
 * How: launchpads emit events referencing the creator wallet — Pons's
 * manager contract emits (token, creatorWallet) both indexed at launch, and
 * fee claims/transfers reference the wallet too. We scan chain-wide for ANY
 * event with the protocol wallet as an indexed topic, harvest every
 * address-shaped value around it as a candidate, and then let
 * verifyCreatorConfig() — the same authoritative on-chain check the
 * register endpoint uses — decide. Only tokens that provably route fees to
 * the protocol wallet get registered; WETH, routers, and random mentions
 * fail verification and are dropped.
 *
 * A persistent block cursor (Firestore config) means downtime never loses a
 * launch: each cycle resumes exactly where the last one stopped.
 */

const CHUNK_BLOCKS = 200_000;
// First-ever run looks this far back (~1 week; the wallet is younger)
const BACKFILL_BLOCKS = parseInt(process.env.DISCOVERY_BACKFILL_BLOCKS, 10) || 3_000_000;
const CURSOR_KEY = 'discovery-cursor';

export function walletTopicFor(address) {
  return '0x' + address.slice(2).toLowerCase().padStart(64, '0');
}

/**
 * Pure: pull candidate token addresses out of one log that references the
 * protocol wallet — the emitter itself plus every other address-shaped
 * indexed topic. (Unit-tested.)
 */
export function extractCandidates(log, walletTopic) {
  const out = new Set();
  if (log.address) out.add(log.address.toLowerCase());
  for (const topic of (log.topics || []).slice(1)) {
    const t = topic.toLowerCase();
    if (t === walletTopic) continue;
    if (!t.startsWith('0x000000000000000000000000')) continue; // address-shaped only
    const addr = '0x' + t.slice(26);
    if (/^0x0{40}$/.test(addr)) continue;
    out.add(addr);
  }
  return [...out];
}

// Symbol straight onto a listed stock market (e.g. COIN) — else the default.
function inferUnderlying(symbol) {
  const s = (symbol || '').toUpperCase();
  return config.STOCK_MARKETS.includes(s) ? s : config.DEFAULT_MARKET;
}

export async function discoverNewTokens() {
  logger.info('Running token auto-discovery');

  // The zero address appears in every mint/burn event — never scan with it
  if (!config.PROTOCOL_ADDRESS || /^0x0{40}$/i.test(config.PROTOCOL_ADDRESS)) {
    logger.warn('PROTOCOL_ADDRESS not configured — skipping token discovery');
    return { discovered: 0 };
  }

  const provider = getProvider();
  const walletTopic = walletTopicFor(config.PROTOCOL_ADDRESS);

  const latest = await provider.getBlockNumber();
  const cursor = await db.getConfig(CURSOR_KEY).catch(() => null);
  const fromBlock = cursor?.lastBlock
    ? Math.min(cursor.lastBlock + 1, latest)
    : Math.max(0, latest - BACKFILL_BLOCKS);

  const existingTokens = await db.getAllTokens();
  const existingAddresses = new Set(
    existingTokens.map(t => (t.id || t.address || '').toLowerCase()),
  );
  const skip = new Set([
    config.WETH_ADDRESS.toLowerCase(),
    (config.FILL_TOKEN_ADDRESS || '').toLowerCase(),
    // Dead/abandoned tokens that must never re-register (e.g. a token whose
    // fee events still reference the wallet after being retired)
    ...(process.env.DISCOVERY_IGNORE_TOKENS || '')
      .split(',').map(a => a.trim().toLowerCase()).filter(Boolean),
  ]);

  // Chain-wide scan: wallet as indexed topic in any of the 3 positions
  const candidates = new Set();
  let scanErrors = 0;
  for (let pos = 1; pos <= 3; pos++) {
    const topics = [null];
    for (let i = 0; i < pos; i++) topics.push(i === pos - 1 ? walletTopic : null);
    for (let from = fromBlock; from <= latest; from += CHUNK_BLOCKS) {
      const to = Math.min(from + CHUNK_BLOCKS - 1, latest);
      try {
        const logs = await provider.getLogs({ fromBlock: from, toBlock: to, topics });
        for (const log of logs) {
          for (const addr of extractCandidates(log, walletTopic)) {
            if (skip.has(addr) || existingAddresses.has(addr)) continue;
            candidates.add(addr);
          }
        }
      } catch (err) {
        scanErrors++;
        logger.debug('Discovery log chunk failed', { from, to, error: err.message });
      }
    }
  }

  let registered = 0;
  for (const address of candidates) {
    try {
      // Must be a contract
      const code = await provider.getCode(address);
      if (!code || code === '0x') continue;

      // Authoritative gate: the SAME on-chain fee-routing verification the
      // register endpoint runs. Non-launchpad contracts and tokens whose
      // creator isn't the protocol wallet are rejected here.
      const check = await verifyCreatorConfig(address);
      if (!check?.valid) continue;

      const meta = await getTokenMetadata(address);
      if (!meta?.symbol) {
        logger.warn('No metadata for discovered token, skipping', { token: address.slice(0, 16) });
        continue;
      }

      const lp = await detectLaunchpad(address);
      const underlying = inferUnderlying(meta.symbol);
      await db.setToken(address, {
        address,
        name: meta.name || 'Unknown',
        symbol: meta.symbol || 'UNK',
        image: meta.image || '',
        launchpad: lp?.id || check.launchpad || 'pons',
        underlying,
        perpsMarket: underlying,
        provider: 'ostium',
        side: 'long',
        strategy: DEFAULT_STRATEGY,
        leverage: config.RISK.leverage,
        createdAt: Date.now(),
        status: 'active',
        autoDiscovered: true,
      });
      registered++;
      logger.info('Auto-registered new token', {
        token: address.slice(0, 16), symbol: meta.symbol, name: meta.name, underlying,
      });
    } catch (e) {
      logger.warn('Failed to auto-register token', { token: address.slice(0, 16), error: e.message });
    }
  }

  // Advance the cursor only when the scan itself succeeded — a failed chunk
  // stays unscanned and is retried next cycle.
  if (scanErrors === 0) {
    await db.setConfig(CURSOR_KEY, { lastBlock: latest, updatedAt: Date.now() }).catch(() => {});
  }

  if (registered === 0) {
    logger.info('No new tokens discovered', { candidates: candidates.size, scannedFrom: fromBlock });
  } else {
    logger.info('Token discovery complete', { candidates: candidates.size, registered });
  }
  return { discovered: candidates.size, registered };
}
