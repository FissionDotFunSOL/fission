import { Contract, ZeroAddress } from 'ethers';
import config from '../config.js';
import logger from '../utils/logger.js';
import { getProvider, getSigner, getEthBalance, getTokenBalance, unwrapAllWeth } from './chain.js';

// ---------------------------------------------------------------------------
// Launchpad service — Robinhood Chain memecoin launchpads
//
// Supports the top launchpads on the chain, each identified by the factory
// contract that deploys its tokens (verified on-chain):
//   pons        — factory + locker, "Creator wallet" field routes fees anywhere
//   launchhood  — factory; "Reward recipient" field routes fees anywhere
//   noxa        — registered but not live yet
//
// A token's launchpad is detected from its on-chain deployer (Blockscout),
// verification confirms fees route to the protocol wallet, and claiming
// probes the launchpad's locker/factory with staticCall-guarded candidates.
// ---------------------------------------------------------------------------

// Candidate view methods for resolving a token's creator/fee-recipient.
// Launchpads on this chain are young and unverified, so we probe common
// factory layouts in order and use the first one that responds.
const CREATOR_VIEW_ABIS = [
  'function creatorOf(address token) view returns (address)',
  'function tokenCreator(address token) view returns (address)',
  'function creators(address token) view returns (address)',
  'function launches(address token) view returns (address creator)',
  'function feeRecipient(address token) view returns (address)',
];

// Candidate claim methods on the locker (post-graduation LP fees) and the
// factory (pre-graduation bonding-curve fees).
const CLAIM_ABIS = [
  'function claimFees(address token)',
  'function collectFees(address token)',
  'function claimCreatorFees(address token)',
  'function collect(address token)',
];

const CLAIMABLE_VIEW_ABIS = [
  'function claimableFees(address token, address creator) view returns (uint256)',
  'function claimableCreatorFees(address token) view returns (uint256)',
  'function pendingFees(address token) view returns (uint256)',
];

/**
 * True if an ABI-encoded hex blob (calldata, log data, or a topic) contains
 * the address as a left-padded 32-byte word — i.e. it was passed as a real
 * parameter, not a random byte coincidence.
 */
export function hexMentionsAddress(hexBlob, address) {
  if (!hexBlob || !address) return false;
  const padded = '0'.repeat(24) + address.toLowerCase().replace(/^0x/, '');
  return hexBlob.toLowerCase().includes(padded);
}

// ---------------------------------------------------------------------------
// Launchpad registry helpers
// ---------------------------------------------------------------------------

export function getLaunchpads() {
  return Object.values(config.LAUNCHPADS);
}

export function getLaunchpad(id) {
  return config.LAUNCHPADS[id] || null;
}

/** Launchpads with a live factory (excludes coming-soon entries). */
function activeLaunchpads() {
  return getLaunchpads().filter(lp => lp.factory);
}

/** Contracts worth probing for a launchpad: locker first (big fees), then factory. */
function claimTargets(lp) {
  return [lp.locker, lp.factory].filter(Boolean);
}

/**
 * Detect which launchpad deployed a token by matching its on-chain creator
 * against the registry factories (via the Blockscout API).
 */
export async function detectLaunchpad(tokenAddress) {
  try {
    const res = await fetch(`${config.EXPLORER_URL}/api/v2/addresses/${tokenAddress}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const creator = (data.creator_address_hash || '').toLowerCase();
    if (!creator) return null;
    return activeLaunchpads().find(lp => lp.factory.toLowerCase() === creator) || null;
  } catch (err) {
    logger.debug('detectLaunchpad failed', { token: tokenAddress, error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verify creator configuration
// Checks that the token came from a supported launchpad factory AND that its
// fee recipient is the protocol wallet.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Brand-impersonation guard. Snipers mass-deploy FILL copycats (50+ live on
// chain named FILL / Fill Protocol / FillDotFun / Fill.fun) with the creator
// wallet pointed at the protocol — which passes fee-routing verification by
// design. Only the official FILL_TOKEN_ADDRESS may carry the brand; every
// other FILL-presenting token is refused by discovery AND registration.
// ---------------------------------------------------------------------------
export function isBrandImpersonation(symbol, name, address) {
  const official = (config.FILL_TOKEN_ADDRESS || '').toLowerCase();
  if (official && (address || '').toLowerCase() === official) return false;
  const s = (symbol || '').trim().toUpperCase();
  const n = (name || '').toLowerCase().replace(/[^a-z]/g, '');
  return s === 'FILL'
    || n === 'fill'
    || n.includes('fillprotocol') || n.includes('fillprotocal')
    || n.includes('filldotfun') || n.includes('fillfun');
}

export async function verifyCreatorConfig(tokenAddress, launchpadId = null) {
  const provider = getProvider();

  // Check 1: the token contract exists on Robinhood Chain
  try {
    const code = await provider.getCode(tokenAddress);
    if (!code || code === '0x') {
      return { valid: false, reason: 'No contract deployed at this address on Robinhood Chain' };
    }
  } catch (err) {
    return { valid: false, reason: `RPC error checking contract: ${err.message}` };
  }

  // Check 2: resolve which launchpad deployed it
  const detected = await detectLaunchpad(tokenAddress);
  const requested = launchpadId ? getLaunchpad(launchpadId) : null;

  if (requested && detected && requested.id !== detected.id) {
    return {
      valid: false,
      reason: `Token was launched on ${detected.name}, not ${requested.name}. Pick the right launchpad and retry.`,
    };
  }

  const lp = detected || requested;
  if (!lp) {
    const names = activeLaunchpads().map(l => l.name).join(', ');
    return { valid: false, reason: `Token wasn't deployed by a supported launchpad factory (${names})` };
  }
  if (!lp.factory) {
    return { valid: false, reason: `${lp.name} is not live yet` };
  }

  // Check 3: resolve the creator/fee wallet from the launchpad contracts
  for (const target of claimTargets(lp)) {
    for (const abi of CREATOR_VIEW_ABIS) {
      try {
        const c = new Contract(target, [abi], provider);
        const fnName = abi.match(/function (\w+)/)[1];
        const creator = await c[fnName](tokenAddress);
        if (creator && creator !== ZeroAddress) {
          if (creator.toLowerCase() !== config.PROTOCOL_ADDRESS.toLowerCase()) {
            return {
              valid: false,
              launchpad: lp.id,
              reason: `Creator wallet is ${creator}, expected ${config.PROTOCOL_ADDRESS}. ${lp.howTo}`,
            };
          }
          logger.info('Launchpad creator config verified', { token: tokenAddress, launchpad: lp.id, creator });
          return { valid: true, creator, launchpad: lp.id, source: fnName };
        }
      } catch {
        // Method doesn't exist on this contract — try the next candidate
      }
    }
  }

  // Fallback: inspect the launch transaction itself. Pons exposes no
  // fee-wallet getter, but the Creator-wallet field is ABI-encoded into the
  // launch calldata (and echoed in the launch event), so finding the
  // protocol address there proves fees route to us. The sender check runs
  // last — it covers pads where fee rights simply follow the launcher.
  try {
    const res = await fetch(`${config.EXPLORER_URL}/api/v2/addresses/${tokenAddress}`, {
      headers: { accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      const txHash = data.creation_transaction_hash;
      if (txHash) {
        const tx = await provider.getTransaction(txHash);

        if (hexMentionsAddress(tx?.data, config.PROTOCOL_ADDRESS)) {
          logger.info('Creator wallet verified from launch calldata', { token: tokenAddress, launchpad: lp.id });
          return { valid: true, creator: config.PROTOCOL_ADDRESS, launchpad: lp.id, source: 'launch-calldata' };
        }

        const receipt = await provider.getTransactionReceipt(txHash);
        for (const log of receipt?.logs || []) {
          if (hexMentionsAddress(log.data, config.PROTOCOL_ADDRESS) ||
              (log.topics || []).some((t) => hexMentionsAddress(t, config.PROTOCOL_ADDRESS))) {
            logger.info('Creator wallet verified from launch event', { token: tokenAddress, launchpad: lp.id });
            return { valid: true, creator: config.PROTOCOL_ADDRESS, launchpad: lp.id, source: 'launch-event' };
          }
        }

        const launcher = tx?.from?.toLowerCase();
        if (launcher === config.PROTOCOL_ADDRESS.toLowerCase()) {
          return { valid: true, creator: config.PROTOCOL_ADDRESS, launchpad: lp.id, source: 'launch-tx-sender' };
        }
        return {
          valid: false,
          launchpad: lp.id,
          reason: `The launch transaction names neither the protocol wallet as Creator wallet nor as launcher (launched by ${tx?.from}). ${lp.howTo}`,
        };
      }
    }
  } catch (fallbackErr) {
    logger.debug('Launch-tx fallback failed', { token: tokenAddress, error: fallbackErr.message });
  }

  return {
    valid: false,
    launchpad: lp.id,
    reason: `Could not verify the fee wallet on ${lp.name} — its contracts may have changed`,
  };
}

// ---------------------------------------------------------------------------
// Get unclaimed creator fee balance (in ETH) for a token
// ---------------------------------------------------------------------------
export async function getUnclaimedBalance(tokenAddress, launchpadId = null) {
  const provider = getProvider();
  const lp = launchpadId ? getLaunchpad(launchpadId) : await detectLaunchpad(tokenAddress);
  const pads = lp ? [lp] : activeLaunchpads();

  for (const pad of pads) {
    for (const target of claimTargets(pad)) {
      for (const abi of CLAIMABLE_VIEW_ABIS) {
        try {
          const c = new Contract(target, [abi], provider);
          const fnName = abi.match(/function (\w+)/)[1];
          const args = abi.includes('address creator')
            ? [tokenAddress, config.PROTOCOL_ADDRESS]
            : [tokenAddress];
          const wei = await c[fnName](...args);
          return parseFloat(wei) / 1e18;
        } catch {
          // Try next candidate
        }
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Claim creator fees for a token.
// Probes the token's launchpad locker/factory with staticCall guards so a
// wrong method guess never costs gas. Returns the tx hash and the ETH
// received (native delta + WETH delta).
// ---------------------------------------------------------------------------
export async function claimFees(tokenAddress, launchpadId = null) {
  const signer = getSigner();
  const lp = launchpadId ? getLaunchpad(launchpadId) : await detectLaunchpad(tokenAddress);
  const pads = lp ? [lp] : activeLaunchpads();

  const balBefore = await getEthBalance(config.PROTOCOL_ADDRESS);
  let wethBefore = 0;
  try {
    wethBefore = await getTokenBalance(config.PROTOCOL_ADDRESS, config.WETH_ADDRESS);
  } catch {}

  let txHash = null;
  let claimedVia = null;
  outer:
  for (const pad of pads) {
    for (const target of claimTargets(pad)) {
      for (const abi of CLAIM_ABIS) {
        try {
          const c = new Contract(target, [abi], signer);
          const fnName = abi.match(/function (\w+)/)[1];
          // Static-call first so a wrong method guess never costs gas
          await c[fnName].staticCall(tokenAddress);
          const resp = await c[fnName](tokenAddress);
          const receipt = await resp.wait();
          txHash = receipt.hash;
          claimedVia = `${pad.id}:${fnName}`;
          logger.info('Launchpad fee claim submitted', { token: tokenAddress, via: claimedVia, target, txHash });
          break outer;
        } catch {
          // Method missing or nothing claimable — try next candidate
        }
      }
    }
  }

  if (!txHash) {
    logger.debug('No claimable launchpad fees', { token: tokenAddress });
    return null;
  }

  const balAfter = await getEthBalance(config.PROTOCOL_ADDRESS);
  let wethAfter = wethBefore;
  try {
    wethAfter = await getTokenBalance(config.PROTOCOL_ADDRESS, config.WETH_ADDRESS);
  } catch {}

  // Pons pays fees in WETH — unwrap to native ETH right away so buybacks
  // (msg.value swaps) and gas checks can actually spend it. Failure is
  // non-fatal: the fee-claimer cycle sweep retries on the next run.
  if (wethAfter > wethBefore) {
    try {
      await unwrapAllWeth();
    } catch (err) {
      logger.warn('WETH unwrap after claim failed — cycle sweep will retry', { error: err.message });
    }
  }

  const feesClaimed = Math.max(0, balAfter - balBefore) + Math.max(0, wethAfter - wethBefore);
  return { txHash, feesClaimed, via: claimedVia };
}

// ---------------------------------------------------------------------------
// Token metadata via the Robinhood Chain Blockscout API (no auth, no CF)
// ---------------------------------------------------------------------------
export async function getTokenMetadata(tokenAddress) {
  try {
    const res = await fetch(`${config.EXPLORER_URL}/api/v2/tokens/${tokenAddress}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      name: data.name || null,
      symbol: data.symbol || null,
      image: data.icon_url || null,
      totalSupply: data.total_supply || null,
      holders: data.holders_count ? parseInt(data.holders_count) : null,
    };
  } catch (err) {
    logger.warn('Blockscout metadata fetch failed', { token: tokenAddress, error: err.message });
    return null;
  }
}
