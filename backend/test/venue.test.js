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
