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

test('computeAutoDeposit: bridge-minimum and reserve rules', async () => {
  const { computeAutoDeposit } = hyperliquid;
  // HL already funded enough -> no deposit
  assert.equal(computeAutoDeposit(45, 20, 10), 0);
  // HL short, idle USDC available -> deposit it all
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
