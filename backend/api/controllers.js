import * as db from '../db/firebase.js';
import { verifySharingConfig } from '../services/pumpfun.js';
import { getWorkerHealth } from '../workers/scheduler.js';
import config from '../config.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
export async function healthCheck(_req, res) {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    dbMode: db._mockMode ? 'mock' : 'firestore',
  });
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
export async function listTokens(_req, res) {
  try {
    const tokens = await db.getAllTokens();
    res.json({ tokens });
  } catch (err) {
    logger.error('listTokens error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
}

export async function getToken(req, res) {
  try {
    const { mint } = req.params;
    const token = await db.getToken(mint);
    if (!token) return res.status(404).json({ error: 'Token not found' });
    res.json({ token });
  } catch (err) {
    logger.error('getToken error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch token' });
  }
}

/**
 * POST /api/v1/tokens/register
 * Body: { mint, underlying? }
 *
 * On-chain verification:
 *   1. Derive fee-sharing PDA
 *   2. Confirm 100% allocation to protocol wallet
 *   3. Confirm admin revoked
 *
 * TODO: Add rate-limiting middleware (e.g. express-rate-limit) to prevent
 * abuse of this endpoint. Suggested: 5 requests per minute per IP.
 */
export async function registerToken(req, res) {
  try {
    const { mint, underlying } = req.body;

    // ── Input validation ──
    if (!mint || typeof mint !== 'string') {
      return res.status(400).json({ error: 'mint is required and must be a string' });
    }

    const trimmedMint = mint.trim();

    // Solana addresses are 32-44 characters, base58 encoded
    if (trimmedMint.length < 32 || trimmedMint.length > 50) {
      return res.status(400).json({
        error: 'Invalid mint address length',
        reason: 'Solana mint addresses are 32-44 base58 characters',
      });
    }

    // Base58 character validation (Solana uses base58: 1-9, A-H, J-N, P-Z, a-k, m-z)
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmedMint)) {
      return res.status(400).json({
        error: 'Invalid mint address',
        reason: 'Mint address contains invalid base58 characters',
      });
    }

    // Validate underlying if provided
    if (underlying !== undefined && underlying !== null) {
      if (typeof underlying !== 'string' || underlying.length > 20) {
        return res.status(400).json({
          error: 'Invalid underlying value',
          reason: 'underlying must be a short token symbol string',
        });
      }
    }

    // ── Check if already registered ──
    const existing = await db.getToken(trimmedMint);
    if (existing) {
      return res.status(409).json({ error: 'Token already registered', token: existing });
    }

    // ── On-chain verification ──
    logger.info('Verifying sharing config on-chain', { mint: trimmedMint });
    const verification = await verifySharingConfig(trimmedMint);

    if (!verification.valid) {
      return res.status(400).json({
        error: 'On-chain verification failed',
        reason: verification.reason,
      });
    }

    // ── Resolve Jupiter Perps market from underlying ──
    const underlyingSymbol = underlying?.trim()?.toUpperCase() || null;
    const perpsMarket = underlyingSymbol && config.PERPS_MARKETS.includes(underlyingSymbol)
      ? underlyingSymbol
      : null;

    // ── Store token ──
    const tokenData = {
      mint: trimmedMint,
      underlying: underlyingSymbol,
      perpsMarket,
      sharingConfigPDA: verification.pda,
      createdAt: Date.now(),
      status: 'active',
    };

    await db.setToken(trimmedMint, tokenData);
    logger.info('Token registered', {
      mint: trimmedMint,
      underlying: underlyingSymbol,
      perpsMarket,
      pda: verification.pda,
    });

    res.status(201).json({ token: tokenData });
  } catch (err) {
    logger.error('registerToken error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Registration failed', message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------
export async function listPositions(_req, res) {
  try {
    const positions = await db.getAllPositions();
    res.json({ positions });
  } catch (err) {
    logger.error('listPositions error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
}

export async function getPosition(req, res) {
  try {
    const { mint } = req.params;
    const position = await db.getPosition(mint);
    if (!position) return res.status(404).json({ error: 'Position not found' });
    res.json({ position });
  } catch (err) {
    logger.error('getPosition error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch position' });
  }
}

// ---------------------------------------------------------------------------
// Buybacks
// ---------------------------------------------------------------------------
export async function listBuybacks(_req, res) {
  try {
    const buybacks = await db.getAllBuybacks();
    res.json({ buybacks });
  } catch (err) {
    logger.error('listBuybacks error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch buybacks' });
  }
}

export async function getBuybacksByMint(req, res) {
  try {
    const { mint } = req.params;
    const buybacks = await db.getBuybacksForToken(mint);
    res.json({ buybacks });
  } catch (err) {
    logger.error('getBuybacksByMint error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch buybacks' });
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
export async function listRuns(_req, res) {
  try {
    const runs = await db.getAllRuns();
    res.json({ runs });
  } catch (err) {
    logger.error('listRuns error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
export async function getStats(_req, res) {
  try {
    const [tokens, positions, runs, buybacks] = await Promise.all([
      db.getAllTokens(),
      db.getAllPositions(),
      db.getAllRuns(),
      db.getAllBuybacks(),
    ]);

    const totalFeesClaimed = runs.reduce((sum, r) => sum + (r.feesClaimed || 0), 0);
    const totalBuybackSol  = buybacks.reduce((sum, b) => sum + (b.amountSol || 0), 0);
    const totalBurned      = buybacks.reduce((sum, b) => sum + (b.tokensBurned || 0), 0);

    res.json({
      stats: {
        totalTokens: tokens.length,
        activeTokens: tokens.filter((t) => t.status === 'active').length,
        openPositions: positions.length,
        totalRuns: runs.length,
        totalFeesClaimed,
        totalBuybackSol,
        totalBurned,
        uptime: process.uptime(),
      },
    });
  } catch (err) {
    logger.error('getStats error', { error: err.message });
    res.status(500).json({ error: 'Failed to compute stats' });
  }
}

// ---------------------------------------------------------------------------
// System Status — full engine state
// ---------------------------------------------------------------------------
export async function getSystemStatus(_req, res) {
  try {
    const workers = getWorkerHealth();
    const tokens = await db.getAllTokens();
    const activeCount = tokens.filter((t) => t.status === 'active').length;

    res.json({
      status: 'operational',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      dbMode: db._mockMode ? 'mock' : 'firestore',
      engine: {
        activeTokens: activeCount,
        totalTokens: tokens.length,
        workers,
      },
    });
  } catch (err) {
    logger.error('getSystemStatus error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch system status' });
  }
}

// ---------------------------------------------------------------------------
// Markets — list available Jupiter Perps markets for the frontend
// ---------------------------------------------------------------------------
export async function listMarkets(_req, res) {
  const markets = config.PERPS_MARKETS.map((symbol) => ({
    symbol,
    platform: 'jupiter-perps',
  }));
  res.json({ markets });
}
