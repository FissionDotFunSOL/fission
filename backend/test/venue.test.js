import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ostium from '../services/ostium.js';
import * as hyperliquid from '../services/hyperliquid.js';
import * as venue from '../services/venue.js';

// The workers are written against ostium's interface; every venue (and the
// router) must expose the same surface or the money paths break silently.
const REQUIRED = [
  'getPairs', 'findPair', 'getMidPrice', 'getPositionPnl', 'getAllPositions',
  'openPosition', 'openLong', 'openShort', 'closePosition', 'reducePosition',
  'getFreeCollateral', 'getFills', 'getMaxLeverage', 'getSafeMaxLeverage',
  'isVenuePaused', 'isStockMarketOpen', 'getAvailableMarkets', 'shutdown',
];

test('every venue implements the full perps interface', () => {
  for (const [name, impl] of Object.entries({ ostium, hyperliquid, venue })) {
    for (const fn of REQUIRED) {
      assert.equal(typeof impl[fn], 'function', `${name}.${fn} is a function`);
    }
  }
});

test('getPositionPnl returns the {exists:false} contract when no position', async () => {
  // The double-open guard reads .exists — a null return would silently
  // break it (TypeError swallowed -> blind retry -> possible double open).
  const shapes = await Promise.all([
    ostium.getPositionPnl('AAPL').catch(() => null),
    hyperliquid.getPositionPnl('AAPL').catch(() => null),
  ]);
  for (const [i, s] of shapes.entries()) {
    const who = i === 0 ? 'ostium' : 'hyperliquid';
    assert.ok(s && typeof s === 'object', `${who} returns an object, never null`);
    assert.equal(typeof s.exists, 'boolean', `${who} has .exists`);
    for (const k of ['pnl', 'size', 'entry']) {
      assert.equal(typeof s[k], 'number', `${who} has numeric .${k}`);
    }
  }
});

test('venue router resolves an active venue and reports status', async () => {
  const id = await venue.activeVenueId();
  assert.ok(['hyperliquid', 'ostium'].includes(id));
  const st = await venue.getVenueStatus();
  assert.equal(st.active, id);
  assert.ok(st.venues.length >= 2);
  const active = st.venues.find(v => v.active);
  assert.ok(active && !active.paused, 'active venue is never a paused venue');
});

test('computeAutoDeposit: idle USDC always moves, bridge-minimum + reserve respected', async () => {
  const { computeAutoDeposit } = hyperliquid;
  // idle USDC moves even when HL already holds funds (it's useless on Arbitrum)
  assert.equal(computeAutoDeposit(530, 47, 1), 530);
  assert.equal(computeAutoDeposit(45.69, 0, 10), 45.69);
  // below the 5 USDC bridge minimum -> NEVER send (it would be burned)
  assert.equal(computeAutoDeposit(4.99, 0, 10), 0);
  assert.equal(computeAutoDeposit(0, 0, 10), 0);
  // reserve is respected
  assert.equal(computeAutoDeposit(45, 0, 10, 41), 0);   // leftover 4 < bridge min
  assert.equal(computeAutoDeposit(45, 0, 10, 20), 25);
});

test('discovery: extractCandidates harvests emitter + address topics, never the wallet', async () => {
  const { extractCandidates, walletTopicFor } = await import('../workers/token-discovery.js');
  const wallet = '0x2cdE129778a416279d9f6F1E9B5c3abb302D1CD7';
  const wt = walletTopicFor(wallet);
  assert.equal(wt, '0x0000000000000000000000002cde129778a416279d9f6f1e9b5c3abb302d1cd7');
  // Pons manager launch event: (token, creatorWallet) both indexed
  const log = {
    address: '0x736D76699C26D0d966744cAe304C000d471f7F35',
    topics: [
      '0x193b011c00000000000000000000000000000000000000000000000000000000',
      '0x000000000000000000000000fedf348a2128122a82bcdd7b8004a95c49cd43f5',
      wt,
    ],
  };
  const got = extractCandidates(log, wt);
  assert.ok(got.includes('0x736d76699c26d0d966744cae304c000d471f7f35'), 'emitter harvested');
  assert.ok(got.includes('0xfedf348a2128122a82bcdd7b8004a95c49cd43f5'), 'token topic harvested');
  assert.ok(!got.some(a => a === wallet.toLowerCase()), 'wallet itself never a candidate');
  // zero-address and non-address topics are ignored
  const junk = extractCandidates({ address: null, topics: [
    '0xddf252ad00000000000000000000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    '0xffffffff000000000000000000000000fedf348a2128122a82bcdd7b8004a95c',
  ] }, wt);
  assert.deepEqual(junk, []);
});

test('roundPx obeys Hyperliquid price rules (5 sig figs, 6-szDecimals decimals)', async () => {
  const { roundPx } = hyperliquid;
  assert.equal(roundPx(157.29 * 1.005, 3), 158.08);    // 5 sig figs is the tighter cap here
  assert.equal(roundPx(333.39456, 3), 333.39);          // 5 sig figs cap
  assert.equal(roundPx(95.416789, 3), 95.417);
  assert.equal(roundPx(643.5849, 3), 643.58);
  assert.equal(roundPx(100.123456, 0), 100.12);         // 0 szDec -> 6 decimals, 5 sig figs
});

test('recovery: planPayouts pays largest debts first, never overpays, respects dust', async () => {
  const { planPayouts, RECOVERY_CUT } = await import('../services/recovery.js');
  assert.equal(RECOVERY_CUT, 0.10);
  const victims = {
    a: { lostEth: 0.05, paidEth: 0 },
    b: { lostEth: 0.02, paidEth: 0.01 },   // 0.01 due
    c: { lostEth: 0.001, paidEth: 0.001 }, // fully paid
  };
  // plenty of funds -> everyone due gets exactly their remainder
  let plan = planPayouts(victims, 1);
  assert.deepEqual(plan, [{ wallet: 'a', amount: 0.05 }, { wallet: 'b', amount: 0.01 }]);
  // limited funds -> largest first, partial for the next
  plan = planPayouts(victims, 0.055);
  assert.deepEqual(plan, [{ wallet: 'a', amount: 0.05 }, { wallet: 'b', amount: 0.005 }]);
  // dust-sized remainder for a NOT-final payment is skipped
  plan = planPayouts(victims, 0.0001);
  assert.deepEqual(plan, []);
  // but a dust-sized FINAL payment (clears the debt) goes through
  plan = planPayouts({ z: { lostEth: 0.0002, paidEth: 0 } }, 1);
  assert.deepEqual(plan, [{ wallet: 'z', amount: 0.0002 }]);
  // nothing due -> empty
  assert.deepEqual(planPayouts({ c: victims.c }, 1), []);
});

test('recovery: claim flow verifies eligibility, is idempotent, re-opens pool', async () => {
  const db = await import('../db/firebase.js');
  if (!db._mockMode) return; // only meaningful against the mock store
  const { claimRecovery } = await import('../services/recovery.js');
  const W = '0x' + 'a1'.repeat(20);

  // claims not open yet
  let r = await claimRecovery(W);
  assert.equal(r.ok, false); assert.equal(r.reason, 'not-open-yet');

  await db.setConfig('recovery-eligibility', { wallets: { [W]: 0.03 }, eligibleCount: 1, totalEligibleEth: 0.03 });

  // invalid address
  r = await claimRecovery('nonsense');
  assert.equal(r.reason, 'invalid-address');
  // eligible wallet -> queued with its real loss
  r = await claimRecovery(W.toUpperCase().replace('0X', '0x')); // case-insensitive
  assert.equal(r.ok, true); assert.equal(r.lostEth, 0.03); assert.equal(r.paidEth, 0);
  // idempotent re-claim
  r = await claimRecovery(W);
  assert.equal(r.ok, true); assert.equal(r.lostEth, 0.03);
  // non-eligible wallet
  r = await claimRecovery('0x' + 'b2'.repeat(20));
  assert.equal(r.ok, false); assert.equal(r.reason, 'no-loss-found');
  // ledger reflects one claim, liability = claimed only
  const ledger = await db.getConfig('recovery-ledger');
  assert.equal(Object.keys(ledger.victims).length, 1);
  assert.equal(ledger.liabilityEth, 0.03);
  // a completed pool re-opens when a new unpaid claim arrives
  await db.setConfig('recovery-ledger', { ...ledger, complete: true });
  await db.setConfig('recovery-eligibility', { wallets: { [W]: 0.03, ['0x' + 'c3'.repeat(20)]: 0.01 }, eligibleCount: 2 });
  r = await claimRecovery('0x' + 'c3'.repeat(20));
  assert.equal(r.ok, true);
  assert.equal((await db.getConfig('recovery-ledger')).complete, false, 'new claim re-opens the pool');
});

test('brand guard: FILL copycats refused, official token exempt', async () => {
  const { isBrandImpersonation } = await import('../services/pons.js');
  const config = (await import('../config.js')).default;
  const official = config.FILL_TOKEN_ADDRESS || '0x7f0404070cf6FB703af9f3B89f84Af3FFE2A54B3';
  // the official token is never an impersonation
  assert.equal(isBrandImpersonation('FILL', 'Fill Protocol', official), false);
  // copycats in every observed shape are refused
  for (const [sym, name] of [
    ['FILL', 'Fill Protocol'], ['FILL', 'Fill Protocal'], ['FILL', 'FILL'],
    ['FILL', 'Fill'], ['FILL', 'FillDotFun'], ['FILL', 'Fill.fun'], ['FILL', 'FILLFUN'],
    ['fill', 'whatever'], ['FILL', 'Order Fill'],
  ]) {
    assert.equal(isBrandImpersonation(sym, name, '0x' + 'd4'.repeat(20)), true, `${sym}/${name} refused`);
  }
  // normal tokens pass
  assert.equal(isBrandImpersonation('APE', 'Hypnosis', '0x' + 'd4'.repeat(20)), false);
  assert.equal(isBrandImpersonation('FILLER', 'Filler Token', '0x' + 'd4'.repeat(20)), false);
  assert.equal(isBrandImpersonation('SPOTIFY', 'Spotify Wrapped', '0x' + 'd4'.repeat(20)), false);
});

test('capital bridge: computeBridgeable respects reserves and clamps', async () => {
  const { computeBridgeable } = await import('../services/capital-bridge.js');
  const opts = { gasReserve: 0.02, buybackFloat: 0.10, min: 0.1, max: 0.5 };
  // 0.479 on RHC, 0.046 owed to recovery -> reserves 0.166 -> bridge ~0.313
  assert.equal(computeBridgeable(0.479, 0.046, opts), 0.313);
  // below min -> nothing
  assert.equal(computeBridgeable(0.25, 0.046, opts), 0);
  assert.equal(computeBridgeable(0.1, 0, opts), 0);
  // large balance clamps to max per cycle
  assert.equal(computeBridgeable(5, 0, opts), 0.5);
  // recovery obligations always stay behind
  assert.equal(computeBridgeable(0.479, 0.479, opts), 0);
});
