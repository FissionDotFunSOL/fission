import logger from '../utils/logger.js';
import { randomIntervalMs, sleep } from '../utils/helpers.js';
import { claimAllFees } from './fee-claimer.js';
import { manageAllPositions } from './position-manager.js';
import { checkProfitsAllTokens } from './position-manager.js';
import { buybackAllTokens } from './buyback-engine.js';
import { runRiskCheck } from './risk-manager.js';

// ---------------------------------------------------------------------------
// Scheduler — orchestrates all workers with jitter + exponential backoff
// ---------------------------------------------------------------------------

let _running = false;
let _abortController = null;

// Per-worker health state, exported for the status API
const _workerHealth = {};

function initHealth(name) {
  _workerHealth[name] = {
    name,
    status: 'idle',
    totalRuns: 0,
    totalErrors: 0,
    consecutiveErrors: 0,
    lastRunAt: null,
    lastErrorAt: null,
    lastError: null,
    lastDurationMs: null,
    nextRunAt: null,
  };
}

/**
 * Start all worker loops.
 */
export function startScheduler() {
  if (_running) {
    logger.warn('Scheduler already running');
    return;
  }
  _running = true;
  _abortController = new AbortController();
  logger.info('Scheduler started — all workers will run autonomously');

  // Standard workers (30-120 min intervals)
  const workers = [
    { name: 'fee-claimer', fn: claimAllFees },
    { name: 'position-manager', fn: manageAllPositions },
    { name: 'buyback-engine', fn: buybackAllTokens },
    { name: 'risk-manager', fn: runRiskCheck },
  ];

  for (const w of workers) {
    initHealth(w.name);
    workerLoop(w.name, w.fn, _abortController.signal);
  }

  // Fast profit-checker (60-90s intervals) — critical for high leverage
  initHealth('profit-checker');
  fastWorkerLoop('profit-checker', checkProfitsAllTokens, _abortController.signal);
}

/**
 * Stop all worker loops.
 */
export function stopScheduler() {
  _running = false;
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
  logger.info('Scheduler stopped');
}

/**
 * Get health data for all workers.
 */
export function getWorkerHealth() {
  return { ..._workerHealth };
}

/**
 * Internal: run a worker function in a loop with jitter + exponential backoff on failure.
 */
async function workerLoop(name, fn, signal) {
  // Stagger initial start (0-10s)
  const initialDelay = Math.random() * 10_000;
  await sleep(initialDelay);

  const health = _workerHealth[name];

  while (_running && !signal.aborted) {
    health.status = 'running';
    const start = Date.now();

    try {
      logger.info(`[${name}] Starting cycle`);
      await fn();

      const elapsed = Date.now() - start;
      health.totalRuns++;
      health.consecutiveErrors = 0;
      health.lastRunAt = new Date().toISOString();
      health.lastDurationMs = elapsed;
      health.status = 'idle';

      logger.info(`[${name}] Cycle complete in ${(elapsed / 1000).toFixed(1)}s`);
    } catch (err) {
      const elapsed = Date.now() - start;
      health.totalRuns++;
      health.totalErrors++;
      health.consecutiveErrors++;
      health.lastErrorAt = new Date().toISOString();
      health.lastError = err.message;
      health.lastDurationMs = elapsed;
      health.status = 'error';

      logger.error(`[${name}] Cycle failed (consecutive: ${health.consecutiveErrors})`, {
        error: err.message,
        stack: err.stack,
      });
    }

    if (!_running || signal.aborted) break;

    // Calculate next interval with exponential backoff on consecutive errors
    let intervalMs = randomIntervalMs();

    if (health.consecutiveErrors > 0) {
      // Exponential backoff: double for each consecutive error, cap at 30 minutes
      const backoffMultiplier = Math.min(Math.pow(2, health.consecutiveErrors - 1), 16);
      const backoffMs = Math.min(intervalMs * backoffMultiplier, 30 * 60_000);
      intervalMs = backoffMs;
      logger.warn(`[${name}] Backing off: next cycle in ${(intervalMs / 60_000).toFixed(1)} min (${health.consecutiveErrors} consecutive errors)`);
    } else {
      logger.info(`[${name}] Next cycle in ${(intervalMs / 60_000).toFixed(1)} minutes`);
    }

    health.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    await sleep(intervalMs);
  }

  health.status = 'stopped';
}

/**
 * Fast worker loop — runs every 60-90s for time-critical operations.
 * At 250x leverage, positions can profit or liquidate in seconds.
 */
async function fastWorkerLoop(name, fn, signal) {
  // Small initial delay
  await sleep(15_000);

  const health = _workerHealth[name];

  while (_running && !signal.aborted) {
    health.status = 'running';
    const start = Date.now();

    try {
      await fn();

      const elapsed = Date.now() - start;
      health.totalRuns++;
      health.consecutiveErrors = 0;
      health.lastRunAt = new Date().toISOString();
      health.lastDurationMs = elapsed;
      health.status = 'idle';
    } catch (err) {
      health.totalRuns++;
      health.totalErrors++;
      health.consecutiveErrors++;
      health.lastErrorAt = new Date().toISOString();
      health.lastError = err.message;
      health.status = 'error';

      logger.error(`[${name}] Fast check failed`, { error: err.message });
    }

    if (!_running || signal.aborted) break;

    // 60-90 second interval with jitter
    const intervalMs = 60_000 + Math.random() * 30_000;
    health.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    await sleep(intervalMs);
  }

  health.status = 'stopped';
}

export { _running as isRunning };
