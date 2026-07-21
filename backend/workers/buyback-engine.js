import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import { swapEthForToken, burnTokens, burnAllTokens, getEthPrice } from '../services/uniswap.js';
import { getTokenBalance, getEthBalance } from '../services/chain.js';
import { getAllTokens } from '../db/firebase.js';
import * as notifier from '../services/notifier.js';
import { sleep } from '../utils/helpers.js';

/**
 * Execute buyback for FILL protocol token using creator fee allocations.
 *
 * 30% of ALL creator token fees are allocated to buying back the FILL
 * protocol token. This creates constant buy pressure on FILL from every
 * token launched on the platform.
 *
 * Flow:
 *   1. Sum up unspent buyback allocations across all tokens.
 *   2. Swap ETH → FILL via Uniswap (Robinhood Chain).
 *   3. Burn the FILL received (transfer to dead address).
 *   4. Record buyback in Firestore.
 */
export async function buybackFill(tokenAddress) {
  logger.info('Starting FILL buyback', { sourceToken: tokenAddress });

  try {
    // Check FILL token is configured
    if (!config.FILL_TOKEN_ADDRESS) {
      logger.debug('FILL_TOKEN_ADDRESS not set — buyback skipped (set in .env when token is launched on Pons)');
      return null;
    }

    const token = await db.getToken(tokenAddress);
    if (!token || token.status !== 'active') {
      logger.warn('Token not active, skipping buyback', { token: tokenAddress });
      return null;
    }

    // Sum all FILL buyback allocations for this token:
    //   - 30% of claimed creator fees (recorded in ETH)
    //   - 30% of realized trading profits (recorded in USD, converted here)
    const splits = await db.queryDocs('splits', [['tokenAddress', '==', tokenAddress]], null, 500);
    const feeAllocEth = splits.reduce((sum, s) => sum + (s.buybackAmount || 0), 0);
    const profitAllocUsd = splits.reduce((sum, s) => sum + (s.profitFillUsd || 0), 0);
    const ethPrice = await getEthPrice();
    const profitAllocEth = ethPrice > 0 ? profitAllocUsd / ethPrice : 0;

    // Sum already-executed buybacks
    const buybacks = await db.getBuybacksForToken(tokenAddress, 500);
    const totalBuybackSpent = buybacks
      .filter(b => b.type !== 'source-buyback-burn')
      .reduce((sum, b) => sum + (b.amountEth || 0), 0);

    const availableEth = feeAllocEth + profitAllocEth - totalBuybackSpent;

    if (availableEth < 0.0001) {
      logger.debug('Insufficient buyback funds', { token: tokenAddress, availableEth });
      return null;
    }

    // Check wallet has enough ETH before attempting swap
    const walletBalance = await getEthBalance(config.PROTOCOL_ADDRESS);
    const minRequired = availableEth + config.RISK.minWalletBalanceEth; // swap amount + gas buffer
    if (walletBalance < minRequired) {
      logger.debug('Wallet balance too low for buyback', { token: tokenAddress, walletBalance, needed: minRequired });
      return null;
    }

    logger.info('Executing FILL buyback swap', {
      sourceToken: tokenAddress,
      ethAmount: availableEth,
      targetToken: config.FILL_TOKEN_ADDRESS,
    });

    // Swap ETH → FILL via Uniswap
    const swapResult = await swapEthForToken(config.FILL_TOKEN_ADDRESS, availableEth);

    // Bought FILL: burn or hold as treasury, per BURN_MODE
    let burnHash = null;
    let tokensBurned = 0;

    if (config.BURN_MODE === 'burn') {
      try {
        const balance = await getTokenBalance(config.PROTOCOL_ADDRESS, config.FILL_TOKEN_ADDRESS);
        if (balance > 0) {
          burnHash = await burnTokens(config.FILL_TOKEN_ADDRESS, balance);
          tokensBurned = balance;
          logger.info('FILL tokens burned', { tokensBurned: balance, burnHash });
        }
      } catch (burnErr) {
        logger.error('FILL burn step failed (swap succeeded)', { error: burnErr.message });
      }
    } else {
      logger.info('FILL buyback held as treasury (BURN_MODE=hold)');
    }

    // Record buyback
    const buybackId = await db.addBuyback({
      tokenAddress,
      targetToken: config.FILL_TOKEN_ADDRESS,
      amountEth: availableEth,
      tokensBurned,
      swapTxHash: swapResult.signature,
      burnTxHash: burnHash,
      type: 'fill-buyback-burn',
    });

    logger.info('FILL buyback & burn completed', {
      sourceToken: tokenAddress,
      amountEth: availableEth,
      tokensBurned,
      buybackId,
    });

    notifier.notifyBuyback({ token: config.FILL_TOKEN_ADDRESS, amountEth: availableEth, tokensBurned, type: 'FILL' });

    return {
      buybackId,
      amountEth: availableEth,
      tokensBurned,
      swapTxHash: swapResult.signature,
      burnTxHash: burnHash,
    };
  } catch (err) {
    logger.error('FILL buyback failed', { token: tokenAddress, error: err.message, stack: err.stack });
    return null;
  }
}

/**
 * Execute buyback for the SOURCE TOKEN — the token whose creator fees
 * generated the perpetual position profits.
 *
 * 70% of take-profit proceeds buy back this token and burn it.
 * This creates direct buy pressure on the derivative token itself.
 */
export async function buybackSourceToken(tokenAddress) {
  logger.info('Starting source token buyback', { token: tokenAddress });

  try {
    const token = await db.getToken(tokenAddress);
    if (!token || token.status !== 'active') {
      logger.warn('Token not active, skipping source buyback', { token: tokenAddress });
      return null;
    }

    // Source-token buybacks are funded by 70% of realized trading profits
    // (recorded in USD by the position manager, converted to ETH here)
    const splits = await db.queryDocs('splits', [['tokenAddress', '==', tokenAddress]], null, 500);
    const legacyAllocEth = splits.reduce((sum, s) => sum + (s.sourceTokenBuyback || 0), 0);
    const profitAllocUsd = splits.reduce((sum, s) => sum + (s.profitSourceUsd || 0), 0);
    const ethPrice = await getEthPrice();
    const profitAllocEth = ethPrice > 0 ? profitAllocUsd / ethPrice : 0;

    // Sum already-executed source buybacks
    const buybacks = await db.getBuybacksForToken(tokenAddress, 500);
    const totalSourceSpent = buybacks
      .filter(b => b.type === 'source-buyback-burn')
      .reduce((sum, b) => sum + (b.amountEth || 0), 0);

    const availableEth = legacyAllocEth + profitAllocEth - totalSourceSpent;

    if (availableEth < 0.0001) {
      logger.debug('Insufficient source token buyback funds', { token: tokenAddress, availableEth });
      return null;
    }

    logger.info('Executing source token buyback swap', {
      token: tokenAddress,
      ethAmount: availableEth,
    });

    // Swap ETH → source token via Uniswap
    const swapResult = await swapEthForToken(tokenAddress, availableEth);

    // Bought source tokens: burn or hold as treasury, per BURN_MODE
    let burnHash = null;
    let tokensBurned = 0;

    if (config.BURN_MODE === 'burn') {
      try {
        const balance = await getTokenBalance(config.PROTOCOL_ADDRESS, tokenAddress);
        if (balance > 0) {
          burnHash = await burnTokens(tokenAddress, balance);
          tokensBurned = balance;
          logger.info('Source tokens burned', { token: tokenAddress, tokensBurned: balance, burnHash });
        }
      } catch (burnErr) {
        logger.error('Source token burn step failed (swap succeeded)', { token: tokenAddress, error: burnErr.message });
      }
    } else {
      logger.info('Source-token buyback held as treasury (BURN_MODE=hold)', { token: tokenAddress });
    }

    // Record buyback
    const buybackId = await db.addBuyback({
      tokenAddress,
      targetToken: tokenAddress,
      amountEth: availableEth,
      tokensBurned,
      swapTxHash: swapResult.signature,
      burnTxHash: burnHash,
      type: 'source-buyback-burn',
    });

    logger.info('Source token buyback & burn completed', {
      token: tokenAddress,
      amountEth: availableEth,
      tokensBurned,
      buybackId,
    });

    notifier.notifyBuyback({ token: tokenAddress, amountEth: availableEth, tokensBurned, type: 'source token' });

    return {
      buybackId,
      amountEth: availableEth,
      tokensBurned,
      swapTxHash: swapResult.signature,
      burnTxHash: burnHash,
    };
  } catch (err) {
    logger.error('Source token buyback failed', { token: tokenAddress, error: err.message, stack: err.stack });
    return null;
  }
}

/**
 * Run BOTH buyback types for ALL active tokens:
 *   1. Source token buyback (70% of profits → buy the derivative token)
 *   2. FILL buyback (30% of fees + 30% of profits → buy FILL)
 */

/**
 * Burn sweeper — self-healing for "bought but not burned". A buyback's
 * burn tx can fail after its swap succeeded (nonce races between workers
 * signing from the same wallet), stranding tokens in the protocol wallet.
 * Every cycle, any balance of the official FILL token or an active
 * registry token gets burned and recorded. Retired tokens are left alone.
 */
async function sweepUnburnedTokens() {
  // In hold mode, bought tokens ARE the treasury — never sweep-burn them.
  if (config.BURN_MODE !== 'burn') return 0;
  const targets = new Set();
  if (config.FILL_TOKEN_ADDRESS) targets.add(config.FILL_TOKEN_ADDRESS);
  const tokens = await getAllTokens();
  for (const t of tokens) {
    if (t.status === 'active') targets.add(t.address || t.id);
  }
  let swept = 0;
  for (const token of targets) {
    try {
      const balance = await getTokenBalance(config.PROTOCOL_ADDRESS, token);
      if (!(balance > 1e-6)) continue;
      const burnHash = await burnAllTokens(token); // raw balance, no float drift
      await db.addBuyback({
        tokenAddress: token,
        targetToken: token,
        amountEth: 0,               // the buy was already recorded — this is the burn
        tokensBurned: balance,
        burnTxHash: burnHash,
        type: 'burn-sweep',
      });
      swept++;
      logger.info('Burn sweep: stranded tokens burned', { token: token.slice(0, 12), tokensBurned: balance, burnHash });
      await sleep(1500);
    } catch (err) {
      logger.warn('Burn sweep failed for token — retried next cycle', { token: token.slice(0, 12), error: err.message });
    }
  }
  return swept;
}

export async function buybackAllTokens() {
  // Pons pools live on a Uniswap V3 fork whose router isn't published yet.
  // Until UNISWAP_ROUTER is set, buyback allocations accrue safely in ETH.
  if (!config.UNISWAP_ROUTER) {
    logger.info('UNISWAP_ROUTER not set — buyback allocations accruing until a router is configured');
    return [];
  }

  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');

  if (active.length === 0) {
    logger.info('No active tokens for buyback');
    return [];
  }

  const results = [];

  // Check wallet balance once before starting
  let walletEth = 0;
  try {
    walletEth = await getEthBalance(config.PROTOCOL_ADDRESS);
    logger.info('Buyback wallet balance', { eth: walletEth });
  } catch {
    logger.warn('Could not fetch wallet balance, proceeding with caution');
  }

  if (walletEth < config.RISK.minWalletBalanceEth) {
    logger.warn('Wallet ETH too low for buybacks, skipping cycle', { balance: walletEth });
    return [];
  }

  for (let i = 0; i < active.length; i++) {
    const token = active[i];
    const tokenAddress = token.id || token.address;

    // 1. Source token buyback (from take-profit proceeds)
    const sourceResult = await buybackSourceToken(tokenAddress);
    if (sourceResult) results.push({ token: tokenAddress, type: 'source', ...sourceResult });

    // 2. FILL buyback (from fee splits + take-profit proceeds)
    if (config.FILL_TOKEN_ADDRESS) {
      const fillResult = await buybackFill(tokenAddress);
      if (fillResult) results.push({ token: tokenAddress, type: 'fill', ...fillResult });
    }

    // Rate limit: 2s delay between tokens
    if (i < active.length - 1) {
      await sleep(2000);
    }
  }

  // Self-heal any strandings from this or previous cycles
  try {
    const swept = await sweepUnburnedTokens();
    if (swept > 0) logger.info('Burn sweep complete', { tokensSwept: swept });
  } catch (sweepErr) {
    logger.warn('Burn sweep errored', { error: sweepErr.message });
  }

  logger.info(`Buyback cycle complete: ${results.length} buybacks executed`);
  return results;
}
