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

    // Auto-enrich tokens that still have CA prefix as name
    for (const t of tokens) {
      const mint = t.mint || t.id;
      const nameIsMissing = !t.name || t.name === mint?.slice(0, 8);
      if (mint && nameIsMissing) {
        try {
          const pumpRes = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`);
          if (pumpRes.ok) {
            const pumpData = await pumpRes.json();
            if (pumpData?.name) {
              t.name = pumpData.name;
              t.symbol = pumpData.symbol || t.symbol;
              t.image = pumpData.image_uri || t.image;
              // Persist only the metadata fields
              await db.updateDoc('tokens', mint, { name: t.name, symbol: t.symbol, image: t.image });
            }
          }
        } catch {
          // Non-critical, continue with existing data
        }
      }
    }

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

export async function refreshTokenMetadata(req, res) {
  try {
    const { mint } = req.params;
    const token = await db.getToken(mint);
    if (!token) return res.status(404).json({ error: 'Token not found' });

    const pumpRes = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`);
    if (!pumpRes.ok) {
      return res.status(502).json({ error: 'Pump.fun API failed', status: pumpRes.status });
    }

    const pumpData = await pumpRes.json();
    const updates = {
      name: pumpData.name || token.name,
      symbol: pumpData.symbol || token.symbol,
      image: pumpData.image_uri || token.image,
    };

    await db.setToken(mint, { ...token, ...updates });
    logger.info('Token metadata refreshed', { mint, ...updates });

    res.json({ token: { ...token, ...updates } });
  } catch (err) {
    logger.error('refreshTokenMetadata error', { error: err.message });
    res.status(500).json({ error: 'Failed to refresh metadata' });
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
    const { mint, underlying, side, leverage } = req.body;

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

    // Validate side if provided (long or short)
    const validSides = ['long', 'short'];
    const tokenSide = (side || 'long').toLowerCase().trim();
    if (!validSides.includes(tokenSide)) {
      return res.status(400).json({
        error: 'Invalid side',
        reason: 'side must be "long" or "short"',
      });
    }

    // Validate leverage (1–250, Jupiter Perps max is 250x)
    let tokenLeverage = Math.min(250, Math.max(1, parseInt(leverage) || config.RISK.leverage));
    if (isNaN(tokenLeverage) || tokenLeverage < 1 || tokenLeverage > 250) {
      return res.status(400).json({
        error: 'Invalid leverage',
        reason: 'leverage must be between 1 and 250',
      });
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

    // ── Resolve perps market from underlying (Jupiter + Flash Trade) ──
    const underlyingSymbol = underlying?.trim()?.toUpperCase() || null;
    const perpsMarket = underlyingSymbol && config.ALL_PERPS_MARKETS.includes(underlyingSymbol)
      ? underlyingSymbol
      : null;

    // Determine provider
    const provider = perpsMarket && config.JUPITER_MARKETS.includes(perpsMarket)
      ? 'jupiter'
      : perpsMarket && config.FLASH_MARKETS.includes(perpsMarket)
        ? 'flash'
        : null;

    // Cap leverage for Flash markets
    if (provider === 'flash' && tokenLeverage > config.FLASH_MAX_LEVERAGE) {
      tokenLeverage = config.FLASH_MAX_LEVERAGE;
    }

    // ── Fetch token metadata (name, symbol, image) ──
    let tokenName = trimmedMint.slice(0, 8);
    let tokenSymbol = trimmedMint.slice(0, 6);
    let tokenImage = null;

    // Try Pump.fun API first (all registered tokens come from Pump.fun)
    try {
      const pumpRes = await fetch(`https://frontend-api-v3.pump.fun/coins/${trimmedMint}`);
      if (pumpRes.ok) {
        const pumpData = await pumpRes.json();
        if (pumpData?.name) tokenName = pumpData.name;
        if (pumpData?.symbol) tokenSymbol = pumpData.symbol;
        if (pumpData?.image_uri) tokenImage = pumpData.image_uri;
      }
    } catch (pumpErr) {
      logger.warn('Pump.fun metadata fetch failed, trying DAS', { mint: trimmedMint, error: pumpErr.message });
    }

    // Fallback: DAS API (getAsset) if Pump.fun didn't return data
    if (tokenName === trimmedMint.slice(0, 8)) {
      try {
        const metaRes = await fetch(config.SOLANA_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAsset',
            params: { id: trimmedMint },
          }),
        });

        if (metaRes.ok) {
          const metaData = await metaRes.json();
          const content = metaData?.result?.content;
          if (content?.metadata?.name) tokenName = content.metadata.name;
          if (content?.metadata?.symbol) tokenSymbol = content.metadata.symbol;
          if (content?.links?.image) tokenImage = content.links.image;
        }
      } catch (metaErr) {
        logger.warn('DAS metadata fetch also failed', { mint: trimmedMint, error: metaErr.message });
      }
    }

    // ── Store token ──
    const tokenData = {
      mint: trimmedMint,
      name: tokenName,
      symbol: tokenSymbol,
      image: tokenImage,
      underlying: underlyingSymbol,
      perpsMarket,
      provider,
      side: tokenSide,
      leverage: tokenLeverage,
      sharingConfigPDA: verification.pda,
      createdAt: Date.now(),
      status: 'active',
    };

    await db.setToken(trimmedMint, tokenData);
    logger.info('Token registered', {
      mint: trimmedMint,
      name: tokenName,
      symbol: tokenSymbol,
      underlying: underlyingSymbol,
      perpsMarket,
      side: tokenSide,
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

    // Enrich with live on-chain PnL data
    const perps = await import('../services/perps-router.js');
    const enriched = await Promise.all(positions.map(async (pos) => {
      try {
        if (!pos.market) return pos;
        const pnlInfo = await perps.getPositionPnl(pos.market, pos.side || 'long');
        if (pnlInfo.exists) {
          return {
            ...pos,
            entry: pnlInfo.entry || pos.entry,
            sizeUsd: pnlInfo.size || pos.sizeUsd,
            collateralUsd: pnlInfo.collateralUsd || pos.collateralUsd,
            pnl: pnlInfo.pnl || 0,
            side: pnlInfo.side || pos.side,
            positionExists: true,
          };
        }
        return { ...pos, positionExists: false };
      } catch {
        return pos;
      }
    }));

    res.json({ positions: enriched });
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
    const totalPnl         = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);

    res.json({
      stats: {
        totalTokens: tokens.length,
        activeTokens: tokens.filter((t) => t.status === 'active').length,
        openPositions: positions.length,
        totalRuns: runs.length,
        totalFeesClaimed,
        totalPnl,
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
// Markets — list all available perps markets (Jupiter + Flash Trade)
// ---------------------------------------------------------------------------
export async function listMarkets(_req, res) {
  const jupiterMarkets = config.JUPITER_MARKETS.map((symbol) => ({
    symbol,
    provider: 'jupiter',
    maxLeverage: 250,
  }));
  const flashMarkets = config.FLASH_MARKETS.map((symbol) => ({
    symbol,
    provider: 'flash',
    maxLeverage: config.FLASH_MAX_LEVERAGE,
  }));
  res.json({ markets: [...jupiterMarkets, ...flashMarkets] });
}

// ---------------------------------------------------------------------------
// Admin: manually trigger a worker cycle
// ---------------------------------------------------------------------------
export async function triggerWorker(req, res) {
  const { worker } = req.params;

  const validWorkers = ['fee-claimer', 'position-manager', 'buyback-engine', 'risk-manager'];
  if (!validWorkers.includes(worker)) {
    return res.status(400).json({ error: `Invalid worker. Must be one of: ${validWorkers.join(', ')}` });
  }

  try {
    let result;

    if (worker === 'fee-claimer') {
      const { claimAllFees } = await import('../workers/fee-claimer.js');
      result = await claimAllFees();
    } else if (worker === 'position-manager') {
      const { manageAllPositions } = await import('../workers/position-manager.js');
      result = await manageAllPositions();
    } else if (worker === 'buyback-engine') {
      const { buybackAllTokens } = await import('../workers/buyback-engine.js');
      result = await buybackAllTokens();
    } else if (worker === 'risk-manager') {
      const { runRiskCheck } = await import('../workers/risk-manager.js');
      result = await runRiskCheck();
    }

    res.json({ triggered: worker, result });
  } catch (err) {
    logger.error('Manual trigger failed', { worker, error: err.message });
    res.status(500).json({ error: err.message });
  }
}
