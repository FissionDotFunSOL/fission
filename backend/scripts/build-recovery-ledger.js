#!/usr/bin/env node
/*
 * Build (or rebuild) the ELIGIBILITY database for the recovery pool.
 *
 * Computes every wallet's net ETH loss on the retired first $FILL token:
 *   loss = ETH sent to the bonding curve (buys) − ETH received back (sells)
 * and stores it as 'recovery-eligibility'. Nobody is paid from this alone:
 * victims CLAIM on the site (enter their wallet), the backend verifies the
 * wallet against this database, and only verified claimants enter the
 * payout ledger. 10% of all fees repay claimants until each is whole.
 *
 * Idempotent: re-running refreshes eligibility; the claims ledger and all
 * paid amounts are preserved. Re-run right before the relaunch post so
 * late buyers are included.
 *
 *   node scripts/build-recovery-ledger.js          # preview only
 *   node scripts/build-recovery-ledger.js --write  # write to Firestore
 */
import config from '../config.js';
import * as db from '../db/firebase.js';

const OLD_TOKEN = '0xfcaee2abed4a4e5cab9c12089d14e8963f7f2042';
const CURVE = '0xdAF8F478C1cFC6241303b108A1D82B4246E13b18'.toLowerCase();
const DUST_ETH = 0.00005; // ignore losses below this
const API = `${config.EXPLORER_URL}/api/v2`;

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (res.ok) return await res.json();
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
      return null;
    } catch { /* timeout/network — retry */ }
    finally { clearTimeout(t); }
  }
  return null;
}

async function pageAll(path, pick) {
  const out = [];
  let url = `${API}${path}`;
  for (let page = 0; page < 100 && url; page++) {
    const d = await fetchJson(url);
    if (!d) break;
    for (const it of d.items || []) out.push(pick(it));
    const np = d.next_page_params;
    url = np ? `${API}${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(np)}` : null;
    if (page % 10 === 9) console.log(`  …page ${page + 1}, ${out.length} items`);
  }
  return out;
}

const flows = new Map(); // wallet -> { in: ethSpent, out: ethReceived }
const flow = (w) => {
  const k = w.toLowerCase();
  if (!flows.has(k)) flows.set(k, { in: 0, out: 0 });
  return flows.get(k);
};

// Trades route through a router, so ETH flows are only visible per-trade:
// walk the token's transfers (curve->wallet = buy, wallet->curve = sell),
// then pull each parent transaction for the real ETH amounts.
const transfers = await pageAll(`/tokens/${OLD_TOKEN}/transfers`, (t) => ({
  from: (t.from?.hash || '').toLowerCase(),
  to: (t.to?.hash || '').toLowerCase(),
  hash: t.transaction_hash || t.tx_hash || '',
}));
const buyTx = new Map();   // hash -> buyer (token receiver)
const sellTx = new Map();  // hash -> seller (token sender)
for (const t of transfers) {
  if (!t.hash) continue;
  if (t.from === CURVE) buyTx.set(t.hash, t.to);
  if (t.to === CURVE) sellTx.set(t.hash, t.from);
}
console.log(`trade txs: ${buyTx.size} buys, ${sellTx.size} sells`);

async function mapLimit(items, limit, fn) {
  const arr = [...items]; let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < arr.length) { const idx = i++; await fn(arr[idx]).catch(() => {}); }
  }));
}
let _done = 0;
const get = async (path) => {
  const r = await fetchJson(`${API}${path}`);
  if (++_done % 50 === 0) console.log(`  …${_done} txs fetched`);
  return r;
};

await mapLimit(buyTx, 20, async ([hash, buyer]) => {
  const tx = await get(`/transactions/${hash}`);
  if (tx?.status !== 'ok') return;
  const value = parseFloat(tx.value || 0) / 1e18;
  const sender = (tx.from?.hash || buyer).toLowerCase();
  if (value > 0) flow(sender).in += value;
});
await mapLimit(sellTx, 20, async ([hash, seller]) => {
  const itx = await get(`/transactions/${hash}/internal-transactions`);
  // ETH the seller actually received back in this tx
  for (const it of itx?.items || []) {
    const to = (it.to?.hash || '').toLowerCase();
    const v = parseFloat(it.value || 0) / 1e18;
    if (to === seller && v > 0) flow(seller).out += v;
  }
});

// Victims = net losers, excluding protocol machinery
const exclude = new Set([CURVE, config.PROTOCOL_ADDRESS.toLowerCase(), OLD_TOKEN]);
const victims = {};
let liabilityEth = 0;
for (const [wallet, f] of flows) {
  if (exclude.has(wallet)) continue;
  const lost = Math.round((f.in - f.out) * 1e8) / 1e8;
  if (lost < DUST_ETH) continue;
  victims[wallet] = { lostEth: lost, paidEth: 0 };
  liabilityEth += lost;
}
liabilityEth = Math.round(liabilityEth * 1e8) / 1e8;

console.log(`victims: ${Object.keys(victims).length} | total liability: ${liabilityEth} ETH`);
for (const [w, v] of Object.entries(victims).sort((a, b) => b[1].lostEth - a[1].lostEth)) {
  console.log(`  ${w}  lost ${v.lostEth} ETH`);
}

if (process.argv.includes('--write')) {
  // Eligibility database (who MAY claim)
  const wallets = {};
  for (const [w, v] of Object.entries(victims)) wallets[w] = v.lostEth;
  await db.setConfig('recovery-eligibility', {
    token: OLD_TOKEN,
    curve: CURVE,
    wallets,
    totalEligibleEth: liabilityEth,
    eligibleCount: Object.keys(wallets).length,
    snapshotAt: Date.now(),
  });

  // Claims ledger: create if missing, ALWAYS preserve existing claims/payments
  const ledger = await db.getConfig('recovery-ledger').catch(() => null);
  if (!ledger) {
    await db.setConfig('recovery-ledger', {
      token: OLD_TOKEN,
      victims: {},          // filled by claims, not by this script
      liabilityEth: 0,      // sum of CLAIMED losses
      accruedEth: 0,
      paidEth: 0,
      complete: false,
      createdAt: Date.now(),
    });
  }
  console.log('eligibility written ✓ (claims ledger preserved)');
} else {
  console.log('(preview only — pass --write to store)');
}
process.exit(0);
