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
    logger.error('listTokens error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to fetch tokens', detail: err.message });
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

    // Get correction offsets for manual operations done outside workers
    let feesOffset = 0, pnlOffset = 0, buybackSolOffset = 0, buybackCountOffset = 0;
    try {
      const statsConfig = await db.getDoc('config', 'stats');
      feesOffset = statsConfig?.feesClaimedOffset || 0;
      pnlOffset = statsConfig?.perpPnlOffset || 0;
      buybackSolOffset = statsConfig?.buybackSolOffset || 0;
      buybackCountOffset = statsConfig?.buybackCountOffset || 0;
    } catch {}

    const totalFeesClaimed = runs.reduce((sum, r) => sum + (r.feesClaimed || 0), 0) + feesOffset;
    const totalBuybackSol  = buybacks.reduce((sum, b) => sum + (b.amountSol || 0), 0) + buybackSolOffset;
    const totalBurned      = buybacks.reduce((sum, b) => sum + (b.tokensBurned || 0), 0);
    const totalPnl         = positions.reduce((sum, p) => sum + (p.pnl || 0), 0) + pnlOffset;
    const totalBuybacks    = buybacks.length + buybackCountOffset;

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
        totalBuybacks,
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

// ---------------------------------------------------------------------------
// Trade History — on-chain perp trades
// ---------------------------------------------------------------------------
let _tradeCache = { data: null, expiresAt: 0 };

export async function getTradeHistory(_req, res) {
  try {
    // Cache for 30s to avoid hammering RPC
    if (_tradeCache.data && Date.now() < _tradeCache.expiresAt) {
      return res.json({ trades: _tradeCache.data });
    }

    const { Connection } = await import('@solana/web3.js');
    const conn = new Connection(config.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
    const wallet = config.PROTOCOL_PUBKEY;
    const walletStr = wallet.toBase58();

    const sigs = await conn.getSignaturesForAddress(wallet, { limit: 60 });
    const trades = [];

    for (const sig of sigs) {
      try {
        const tx = await conn.getTransaction(sig.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (!tx || !tx.meta || tx.meta.err) continue;

        const logs = tx.meta.logMessages?.join(' ') || '';
        // Only Jupiter Perps txs
        if (!logs.includes('PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu')) continue;

        // Find wallet SOL delta
        const accounts = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
        let walletIdx = -1;
        for (let i = 0; i < accounts.length; i++) {
          const pk = typeof accounts[i] === 'string' ? accounts[i] : accounts[i].toBase58();
          if (pk === walletStr) { walletIdx = i; break; }
        }
        if (walletIdx < 0) continue;

        const pre = tx.meta.preBalances[walletIdx] || 0;
        const post = tx.meta.postBalances[walletIdx] || 0;
        const deltaSol = (post - pre) / 1e9;

        // Determine action from logs
        let action = 'Unknown';
        let pnl = null;
        if (logs.includes('IncreasePosition') || logs.includes('increase_position') || logs.includes('OpenPosition') || logs.includes('open_position')) {
          action = 'Increase Long';
        } else if (logs.includes('DecreasePosition') || logs.includes('decrease_position') || logs.includes('ClosePosition') || logs.includes('close_position')) {
          action = 'Decrease Long';
          if (deltaSol > 0.01) {
            pnl = deltaSol;
          }
        }

        // Try to extract size from log messages
        let sizeUsd = null;
        const sizeMatch = logs.match(/size[_: ]*(\d+)/i);
        if (sizeMatch) {
          const rawSize = parseInt(sizeMatch[1]);
          if (rawSize > 100) sizeUsd = rawSize / 1e6; // might be in micro-USD
        }

        // Get fee from tx fee
        const fee = (tx.meta.fee || 5000) / 1e9;

        trades.push({
          signature: sig.signature,
          time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
          position: 'SOL',
          action,
          orderType: 'Market',
          depositWithdraw: deltaSol,
          sizeUsd: sizeUsd || Math.abs(deltaSol * 72), // rough estimate if no size found
          pnl,
          fee,
        });
      } catch (e) {
        // Skip unparseable txs
      }
    }

    _tradeCache = { data: trades, expiresAt: Date.now() + 30_000 };
    res.json({ trades });
  } catch (err) {
    logger.error('getTradeHistory error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch trade history' });
  }
}

// ---------------------------------------------------------------------------
// Live Positions — on-chain unrealised PnL
// ---------------------------------------------------------------------------
let _livePositionCache = { data: null, expiresAt: 0 };

export async function getLivePositions(_req, res) {
  try {
    // Cache 10s
    if (_livePositionCache.data && Date.now() < _livePositionCache.expiresAt) {
      return res.json({ positions: _livePositionCache.data });
    }

    const walletAddress = config.PROTOCOL_PUBKEY.toBase58();

    // Use Jupiter's own Perps API — exact same data as the Jupiter UI
    const jupResp = await fetch(`https://perps-api.jup.ag/v1/positions?walletAddress=${walletAddress}`);
    if (!jupResp.ok) {
      logger.warn('Jupiter Perps API failed', { status: jupResp.status });
      return res.json({ positions: [] });
    }

    const jupData = await jupResp.json();
    const positions = (jupData.dataList || []).map(p => ({
      market: p.marketMint === 'So11111111111111111111111111111111111111112' ? 'SOL'
        : p.marketMint === '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' ? 'BTC'
        : p.marketMint === '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' ? 'ETH'
        : p.marketMint?.slice(0, 8),
      side: p.side || 'long',
      sizeUsd: parseFloat(p.size) || 0,
      collateralUsd: parseFloat(p.collateral) || 0,
      entryPrice: parseFloat(p.entryPrice) || 0,
      currentPrice: parseFloat(p.markPrice) || 0,
      unrealisedPnl: parseFloat(p.pnlAfterFeesUsd) || 0,
      pnlBeforeFees: parseFloat(p.pnlBeforeFeesUsd) || 0,
      totalFees: parseFloat(p.totalFeesUsd) || 0,
      leverage: p.leverage || '-',
      liquidationPrice: parseFloat(p.liquidationPrice) || 0,
      value: parseFloat(p.value) || 0,
    }));

    _livePositionCache = { data: positions, expiresAt: Date.now() + 10_000 };
    res.json({ positions });
  } catch (err) {
    logger.error('getLivePositions error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch live positions' });
  }
}
