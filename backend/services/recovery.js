import config from '../config.js';
import logger from '../utils/logger.js';
import * as db from '../db/firebase.js';
import { getProvider } from './chain.js';

// ---------------------------------------------------------------------------
// Recovery pool — the make-good for the retired first $FILL token.
//
// 10% of every fee claim accrues to the pool; the pool pays out real ETH on
// Robinhood Chain to the wallets that lost money on the old token (ledger
// built from chain data by scripts/build-recovery-ledger.js) until every
// victim's loss is repaid. Then the carve-out switches itself off forever.
// Fully automatic; every payout is an on-chain tx recorded in the ledger.
// ---------------------------------------------------------------------------

const LEDGER_KEY = 'recovery-ledger';
export const RECOVERY_CUT = 0.10;          // 10% of gross fee claims
const MIN_PAYOUT_ETH = 0.0005;             // don't dust victims with micro-txs
const GAS_FLOOR_ETH = 0.004;               // never drain the wallet below this
const round8 = (n) => Math.round(n * 1e8) / 1e8;

const ELIGIBILITY_KEY = 'recovery-eligibility';

export async function getLedger() {
  try { return await db.getConfig(LEDGER_KEY); } catch { return null; }
}

export async function getEligibility() {
  try { return await db.getConfig(ELIGIBILITY_KEY); } catch { return null; }
}

/**
 * Claim-based entry: a wallet self-registers on the site, we verify it
 * against the on-chain eligibility database (net ETH lost on the retired
 * token), and only verified claimants enter the payout queue. Anyone can
 * submit any wallet — payouts only ever go TO the claimed wallet itself,
 * so there is nothing to steal. Idempotent: re-claiming returns status.
 */
export async function claimRecovery(walletRaw) {
  const wallet = String(walletRaw || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    return { ok: false, reason: 'invalid-address' };
  }
  const elig = await getEligibility();
  if (!elig?.wallets) return { ok: false, reason: 'not-open-yet' };

  const lostEth = elig.wallets[wallet] || 0;
  if (!(lostEth > 0)) {
    return { ok: false, reason: 'no-loss-found', lostEth: 0 };
  }

  const ledger = (await getLedger()) || {
    token: elig.token, victims: {}, liabilityEth: 0,
    accruedEth: 0, paidEth: 0, complete: false, createdAt: Date.now(),
  };

  const existing = ledger.victims[wallet];
  if (!existing) {
    ledger.victims[wallet] = { lostEth, paidEth: 0, claimedAt: Date.now() };
  } else {
    existing.lostEth = Math.max(existing.lostEth || 0, lostEth); // refreshed snapshot may raise it
  }
  ledger.liabilityEth = round8(Object.values(ledger.victims)
    .reduce((s, v) => s + (v.lostEth || 0), 0));
  // A new unpaid claim re-opens the pool (re-arms the 10% carve-out)
  const v = ledger.victims[wallet];
  if ((v.paidEth || 0) < (v.lostEth || 0) - 1e-8) ledger.complete = false;

  await db.setConfig(LEDGER_KEY, ledger);
  logger.info('Recovery claim verified & queued', { wallet, lostEth });
  return {
    ok: true, lostEth: v.lostEth, paidEth: v.paidEth || 0,
    madeWhole: (v.paidEth || 0) >= (v.lostEth || 0) - 1e-8,
  };
}

/**
 * Accrue the recovery share of a fee claim. Returns the ETH amount taken
 * (0 when there is no active ledger — i.e. before setup or after complete),
 * so the caller can split the REMAINDER as usual.
 */
export async function takeRecoveryCut(feesClaimed) {
  const ledger = await getLedger();
  if (!ledger || ledger.complete || !(feesClaimed > 0)) return 0;
  const cut = round8(feesClaimed * RECOVERY_CUT);
  await db.setConfig(LEDGER_KEY, {
    ...ledger,
    accruedEth: round8((ledger.accruedEth || 0) + cut),
  });
  logger.info('Recovery pool accrued', { cut: cut.toFixed(8), poolTotal: round8((ledger.accruedEth || 0) + cut) });
  return cut;
}

/**
 * Pure payout planner (unit-tested): given victims {wallet:{lostEth,paidEth}}
 * and the ETH available, produce payments — largest outstanding loss first,
 * never more than a wallet is owed, never below the dust minimum (unless it
 * clears that wallet's remaining debt).
 */
export function planPayouts(victims, availableEth, minPayout = MIN_PAYOUT_ETH) {
  const owed = Object.entries(victims)
    .map(([wallet, v]) => ({ wallet, due: round8((v.lostEth || 0) - (v.paidEth || 0)) }))
    .filter((x) => x.due > 0)
    .sort((a, b) => b.due - a.due);
  const plan = [];
  let left = availableEth;
  for (const { wallet, due } of owed) {
    if (left <= 0) break;
    const amount = round8(Math.min(due, left));
    if (amount < minPayout && amount < due) continue; // too small to bother, not final
    if (amount < 1e-8) continue;
    plan.push({ wallet, amount });
    left = round8(left - amount);
  }
  return plan;
}

/**
 * Pay victims from the pool. Called once per fee-claimer cycle. Sends real
 * ETH on Robinhood Chain; each payment is recorded with its tx hash. When
 * the last victim is made whole, marks the ledger complete (which stops the
 * 10% carve-out automatically).
 */
export async function processRecoveryPayouts() {
  try {
    if (!config.protocolWallet) return null;
    const ledger = await getLedger();
    if (!ledger || ledger.complete) return null;

    const poolAvailable = round8((ledger.accruedEth || 0) - (ledger.paidEth || 0));
    if (poolAvailable < MIN_PAYOUT_ETH) return null;

    const provider = getProvider();
    const signer = config.protocolWallet.connect(provider);
    const { formatEther, parseEther } = await import('ethers');
    const balance = parseFloat(formatEther(await provider.getBalance(config.PROTOCOL_ADDRESS)));

    // Never spend more than the wallet can afford above the gas floor
    const spendable = Math.min(poolAvailable, Math.max(0, balance - GAS_FLOOR_ETH));
    if (spendable < MIN_PAYOUT_ETH) return null;

    const plan = planPayouts(ledger.victims || {}, spendable);
    if (!plan.length) return null;

    const payouts = ledger.payouts || [];
    let paidNow = 0;
    for (const { wallet, amount } of plan) {
      try {
        const tx = await signer.sendTransaction({ to: wallet, value: parseEther(amount.toFixed(8)) });
        const receipt = await tx.wait();
        ledger.victims[wallet].paidEth = round8((ledger.victims[wallet].paidEth || 0) + amount);
        payouts.push({ to: wallet, amountEth: amount, hash: receipt.hash, at: Date.now() });
        paidNow = round8(paidNow + amount);
        logger.info('Recovery payout sent', { to: wallet, amountEth: amount.toFixed(6), hash: receipt.hash });
      } catch (payErr) {
        logger.error('Recovery payout failed — will retry next cycle', { to: wallet, error: payErr.message });
        break; // stop the batch; state stays consistent, retried next cycle
      }
    }
    if (paidNow <= 0) return null;

    const paidEth = round8((ledger.paidEth || 0) + paidNow);
    const complete = Object.values(ledger.victims).every((v) => (v.paidEth || 0) >= (v.lostEth || 0) - 1e-8);
    await db.setConfig(LEDGER_KEY, { ...ledger, paidEth, payouts, complete, ...(complete ? { completedAt: Date.now() } : {}) });
    if (complete) logger.info('RECOVERY COMPLETE — every victim made whole; 10% carve-out ends', { totalPaid: paidEth });
    return { paidNow, complete };
  } catch (err) {
    logger.error('processRecoveryPayouts failed', { error: err.message });
    return null;
  }
}
