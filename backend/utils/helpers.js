import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import config from '../config.js';
import logger from './logger.js';

// ---------------------------------------------------------------------------
// SOL ↔ lamports
// ---------------------------------------------------------------------------
export function solToLamports(sol) {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function lamportsToSol(lamports) {
  return lamports / LAMPORTS_PER_SOL;
}

// ---------------------------------------------------------------------------
// Random interval (with jitter)
// ---------------------------------------------------------------------------
export function randomIntervalMs(
  minSec = config.INTERVALS.minSeconds,
  maxSec = config.INTERVALS.maxSeconds,
) {
  const sec = minSec + Math.random() * (maxSec - minSec);
  return Math.round(sec * 1000);
}

// ---------------------------------------------------------------------------
// Retry wrapper with exponential backoff
// ---------------------------------------------------------------------------
export async function retry(fn, {
  retries = 3,
  delayMs = 1000,
  factor = 2,
  label = 'operation',
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = delayMs * factor ** (attempt - 1);
      logger.warn(`Retry ${attempt}/${retries} for ${label} — waiting ${wait}ms`, {
        error: err.message,
      });
      if (attempt < retries) {
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Shorten a public key for display
// ---------------------------------------------------------------------------
export function shortenKey(pubkey, len = 4) {
  const s = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
  return `${s.slice(0, len)}…${s.slice(-len)}`;
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------
export function nowISO() {
  return new Date().toISOString();
}

export function nowUnix() {
  return Math.floor(Date.now() / 1000);
}
