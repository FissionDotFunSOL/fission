import { isAddress, getAddress } from 'ethers';
import * as db from '../db/firebase.js';
import { verifyCreatorConfig, getTokenMetadata, isBrandImpersonation } from '../services/pons.js';
import { STRATEGY_MODES, DEFAULT_STRATEGY, isValidStrategy } from '../services/strategies.js';
import * as ostium from '../services/venue.js';
import * as gecko from '../services/geckoterminal.js';
import * as birdeye from '../services/birdeye.js';
import * as recoverySvc from '../services/recovery.js';
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
    const all = await db.getAllTokens();
    // Only approved tokens appear publicly — pending (awaiting approval)
    // and retired (relaunched/abandoned) stay hidden
    const tokens = all.filter((t) => t.status === 'active');
    res.json({ tokens });
  } catch (err) {
    logger.error('listTokens error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to fetch tokens', detail: err.message });
  }
}

export async function getToken(req, res) {
  try {
    const { address } = req.params;
    const token = await db.getToken(address);
    if (!token) return res.status(404).json({ error: 'Token not found' });
    res.json({ token });
  } catch (err) {
    logger.error('getToken error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch token' });
  }
}

export async function refreshTokenMetadata(req, res) {
  try {
    const { address } = req.params;
    const token = await db.getToken(address);
    if (!token) return res.status(404).json({ error: 'Token not found' });

    const meta = await getTokenMetadata(address);
    if (!meta) {
      return res.status(502).json({ error: 'Metadata lookup failed' });
    }

    const updates = {
      name: meta.name || token.name,
      symbol: meta.symbol || token.symbol,
      image: meta.image || token.image,
    };

    await db.setToken(address, { ...token, ...updates });
    logger.info('Token metadata refreshed', { address, ...updates });

    res.json({ token: { ...token, ...updates } });
  } catch (err) {
    logger.error('refreshTokenMetadata error', { error: err.message });
    res.status(500).json({ error: 'Failed to refresh metadata' });
  }
}

/**
 * POST /api/v1/tokens/register
 * Body: { address, underlying?, side?, leverage? }
 *
 * On-chain verification:
 *   1. Confirm the token exists on Robinhood Chain
 *   2. Confirm it was launched via the Pons factory
 *   3. Confirm the creator wallet is the protocol wallet
 *
 * TODO: Add rate-limiting middleware (e.g. express-rate-limit) to prevent
 * abuse of this endpoint. Suggested: 5 requests per minute per IP.
 */
export async function registerToken(req, res) {
  try {
    const { address, mint, underlying, side, leverage, launchpad, strategy } = req.body;
    const rawAddress = address || mint; // `mint` accepted for backwards compat

    // Validate launchpad if provided
    if (launchpad !== undefined && launchpad !== null && !config.LAUNCHPADS[launchpad]) {
      return res.status(400).json({
        error: 'Unknown launchpad',
        reason: `launchpad must be one of: ${Object.keys(config.LAUNCHPADS).join(', ')}`,
      });
    }

    // Validate strategy mode if provided
    if (strategy !== undefined && strategy !== null && !isValidStrategy(strategy)) {
      return res.status(400).json({
        error: 'Unknown strategy',
        reason: `strategy must be one of: ${Object.keys(STRATEGY_MODES).join(', ')}`,
      });
    }

    // ── Input validation ──
    if (!rawAddress || typeof rawAddress !== 'string') {
      return res.status(400).json({ error: 'address is required and must be a string' });
    }

    const trimmed = rawAddress.trim();

    if (!isAddress(trimmed)) {
      return res.status(400).json({
        error: 'Invalid token address',
        reason: 'Expected a 0x-prefixed EVM address (Robinhood Chain)',
      });
    }

    const tokenAddress = getAddress(trimmed);

    // Validate underlying if provided
    if (underlying !== undefined && underlying !== null) {
      if (typeof underlying !== 'string' || underlying.length > 20) {
        return res.status(400).json({
          error: 'Invalid underlying value',
          reason: 'underlying must be a short stock ticker string',
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

    // Validate leverage (1–50, Ostium equities max is 50x) and clamp it to
    // the chosen strategy mode's ceiling so the stored cap always makes sense
    const modeCap = STRATEGY_MODES[strategy || DEFAULT_STRATEGY]?.maxLev || config.OSTIUM.MAX_LEVERAGE;
    const maxLev = Math.min(config.OSTIUM.MAX_LEVERAGE, modeCap);
    let tokenLeverage = Math.min(maxLev, Math.max(1, parseInt(leverage) || config.RISK.leverage));
    if (isNaN(tokenLeverage) || tokenLeverage < 1) {
      return res.status(400).json({
        error: 'Invalid leverage',
        reason: `leverage must be between 1 and ${maxLev} for the ${strategy || DEFAULT_STRATEGY} strategy`,
      });
    }

    // ── Check if already registered ──
    const existing = await db.getToken(tokenAddress);
    if (existing) {
      return res.status(409).json({ error: 'Token already registered', token: existing });
    }

    // ── On-chain verification ──
    logger.info('Verifying launchpad creator config on-chain', { address: tokenAddress, launchpad });
    const verification = await verifyCreatorConfig(tokenAddress, launchpad || null);

    if (!verification.valid) {
      return res.status(400).json({
        error: 'On-chain verification failed',
        reason: verification.reason,
      });
    }

    // ── Resolve stock perp market from underlying ──
    const underlyingSymbol = underlying?.trim()?.toUpperCase() || null;
    const perpsMarket = underlyingSymbol && config.STOCK_MARKETS.includes(underlyingSymbol)
      ? underlyingSymbol
      : null;

    // ── Fetch token metadata (name, symbol, image) via Blockscout ──
    let tokenName = tokenAddress.slice(0, 8);
    let tokenSymbol = tokenAddress.slice(2, 8).toUpperCase();
    let tokenImage = null;

    try {
      const meta = await getTokenMetadata(tokenAddress);
      if (meta?.name) tokenName = meta.name;
      if (meta?.symbol) tokenSymbol = meta.symbol;
      if (meta?.image) tokenImage = meta.image;
    } catch (metaErr) {
      logger.warn('Metadata fetch failed', { address: tokenAddress, error: metaErr.message });
    }

    // Refuse FILL copycats — only the official token carries the brand
    if (isBrandImpersonation(tokenSymbol, tokenName, tokenAddress)) {
      return res.status(400).json({
        error: 'Brand impersonation',
        reason: 'Tokens presenting as FILL / Fill Protocol cannot register. Only the official $FILL shown on fill.fun is recognized.',
      });
    }

    // ── Store token ──
    const tokenData = {
      address: tokenAddress,
      name: tokenName,
      symbol: tokenSymbol,
      image: tokenImage,
      launchpad: verification.launchpad || launchpad || 'pons',
      underlying: underlyingSymbol,
      perpsMarket,
      provider: 'ostium',
      side: tokenSide,
      strategy: strategy || DEFAULT_STRATEGY,
      leverage: tokenLeverage,
      creatorWallet: verification.creator || config.PROTOCOL_ADDRESS,
      createdAt: Date.now(),
      // Approval gate — verified but hidden until approved (anti-bait)
      status: 'pending',
    };

    await db.setToken(tokenAddress, tokenData);
    logger.info('Token registered', {
      address: tokenAddress,
      name: tokenName,
      symbol: tokenSymbol,
      underlying: underlyingSymbol,
      perpsMarket,
      side: tokenSide,
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
    const [positions, tokens, allRuns] = await Promise.all([
      db.getAllPositions(),
      db.getAllTokens(),
      db.getAllRuns(500),
    ]);

    // Calculate total fees claimed per token from runs
    const feesByToken = {};
    for (const run of allRuns) {
      const addr = run.tokenAddress;
      if (!addr) continue;
      feesByToken[addr] = (feesByToken[addr] || 0) + (run.feesClaimed || 0);
    }

    // Fetch live Ostium positions ONCE (not per-token)
    let livePositions = [];
    try {
      livePositions = await ostium.getAllPositions();
    } catch {}

    // Build enriched list per token
    const activeTokens = tokens.filter(t => t.status === 'active');
    const enriched = activeTokens.map(token => {
      const addr = token.id || token.address;
      const pos = positions.find(p => p.id === addr);
      const deployed = pos?.deployedUsd || 0;
      const totalFeesEth = feesByToken[addr] || 0;
      const market = token.underlying || config.DEFAULT_MARKET;
      const live = livePositions.find(p => p.market === market);

      const base = {
        id: addr,
        tokenName: token.name || token.symbol || addr.slice(0, 8),
        symbol: token.symbol || '?',
        market,
        side: token.side || 'long',
        leverage: token.leverage || config.RISK?.leverage || 25,
        deployedUsd: deployed,
        totalFeesEth,
      };

      // If this token has capital deployed and a live position exists,
      // PnL is the position's unrealised USD PnL (trading side).
      if (deployed > 0 && live) {
        return {
          ...base,
          entry: live.entryPrice,
          sizeUsd: live.sizeUsd,
          collateralUsd: live.collateralUsd,
          pnl: live.unrealisedPnl,
          pnlCurrency: 'USD',
          positionExists: true,
          status: 'active',
          statusText: 'Position active',
        };
      }

      // No deployed capital -- show accumulated creator fees (ETH) instead
      let statusText = 'Collecting fees';
      if (pos?.lastAction === 'external-close-detected' || pos?.riskAlert === 'position-missing') {
        statusText = 'Awaiting re-entry';
      }

      return {
        ...base,
        entry: null,
        sizeUsd: null,
        pnl: totalFeesEth > 0 ? totalFeesEth : null,
        pnlCurrency: 'ETH',
        positionExists: false,
        status: 'collecting',
        statusText,
      };
    });

    res.json({ positions: enriched });
  } catch (err) {
    logger.error('listPositions error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
}

export async function getPosition(req, res) {
  try {
    const { address } = req.params;
    const position = await db.getPosition(address);
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

export async function getBuybacksByToken(req, res) {
  try {
    const { address } = req.params;
    const buybacks = await db.getBuybacksForToken(address);
    res.json({ buybacks });
  } catch (err) {
    logger.error('getBuybacksByToken error', { error: err.message });
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
    const [tokens, positions, runs, buybacks, recoveryLedger] = await Promise.all([
      db.getAllTokens(),
      db.getAllPositions(),
      db.getAllRuns(),
      db.getAllBuybacks(),
      db.getConfig('recovery-ledger').catch(() => null),
    ]);

    // Fees: sum of recorded EVM claim runs (getAllRuns already drops any
    // legacy Solana-era runs). No historical offset — the pivot is a clean
    // slate, and the old offset was SOL-denominated.
    const totalFeesClaimed = runs.reduce((sum, r) => sum + (r.feesClaimed || 0), 0);

    // Realized PnL comes from the trade ledger the position manager writes
    // on every close — the single source of truth for closed-trade results.
    // Pre-pivot ledger docs (Solana era) have no `totalPnlUsd` field; treat
    // them as empty so the fresh EVM system starts from zero.
    let realizedPnlUsd = 0;
    let totalWins = 0, totalLosses = 0;
    try {
      const ledger = await db.getDoc('config', 'trade-history');
      if (ledger && ledger.totalPnlUsd !== undefined) {
        realizedPnlUsd = ledger.totalPnlUsd || 0;
        totalWins = ledger.totalWins || 0;
        totalLosses = ledger.totalLosses || 0;
      }
    } catch {}

    // Capital currently deployed in open positions (USDC)
    const currentlyDeployed = positions.reduce((sum, p) => sum + ((p.deployedUsd || 0) > 0 ? (p.deployedUsd || 0) : 0), 0);

    // Wallet balances: ETH on Robinhood Chain (fees/gas) + USDC on Arbitrum (trading)
    let walletBalance = 0;
    try {
      const { getEthBalance } = await import('../services/chain.js');
      walletBalance = await getEthBalance(config.PROTOCOL_ADDRESS);
    } catch {}

    let tradingBalanceUsd = 0;
    try {
      tradingBalanceUsd = await ostium.getFreeCollateral();
    } catch {}

    // Unrealized PnL from live Ostium positions (USD)
    let hasLivePosition = false;
    let livePositionPnlUsd = 0;
    try {
      const livePositions = await ostium.getAllPositions();
      if (livePositions.length > 0) {
        hasLivePosition = true;
        for (const p of livePositions) {
          livePositionPnlUsd += p.unrealisedPnl || 0;
        }
      }
    } catch {}

    // Total perp PnL (USD) = realized ledger + unrealized on open positions
    // Manual offset accounts for early losses settled off-chain before the
    // trade-history ledger was tracking (keeps the site honest).
    const MANUAL_PNL_OFFSET_USD = -703;
    const netPerpPnl = (realizedPnlUsd + livePositionPnlUsd) || MANUAL_PNL_OFFSET_USD;

    const totalBuybackEth = buybacks.reduce((sum, b) => sum + (b.amountEth || 0), 0);

    res.json({
      stats: {
        totalTokens: tokens.length,
        activeTokens: tokens.filter((t) => t.status === 'active').length,
        openPositions: positions.filter(p => (p.deployedUsd || 0) > 0).length,
        totalFeesClaimed: Math.round(totalFeesClaimed * 10000) / 10000,
        deployedUsd: Math.round(currentlyDeployed * 100) / 100,
        realizedPnlUsd: Math.round(realizedPnlUsd * 100) / 100,
        totalWins,
        totalLosses,
        netPerpPnlUsd: Math.round(netPerpPnl * 100) / 100,
        walletBalanceEth: Math.round(walletBalance * 10000) / 10000,
        tradingBalanceUsd: Math.round(tradingBalanceUsd * 100) / 100,
        hasLivePosition,
        livePositionPnlUsd: Math.round(livePositionPnlUsd * 100) / 100,
        totalBuybackEth: Math.round(totalBuybackEth * 10000) / 10000,
        totalBuybacks: buybacks.length,
        // Manual offset: some refunds were sent directly from the team wallet,
        // not through the on-chain recovery system.
        refundsEth: Math.round(((recoveryLedger?.paidEth || 0) + 0.304) * 10000) / 10000,
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
      chain: {
        name: 'Robinhood Chain',
        chainId: config.CHAIN_ID,
        explorer: config.EXPLORER_URL,
      },
      wallet: {
        address: config.PROTOCOL_ADDRESS,
        // true once PROTOCOL_PRIVATE_KEY is set — the engine can sign
        signerLoaded: !!config.protocolWallet,
      },
      stockMarket: {
        // live from the ACTIVE venue — stock perp entries only happen while true
        open: await ostium.isStockMarketOpen(),
        hours: 'US sessions · Mon–Fri 9:30am–4:00pm ET',
        // true when the active venue itself is halted
        venuePaused: await ostium.isVenuePaused(),
      },
      // Which perp venue the engine is trading on + each venue's state
      venue: await ostium.getVenueStatus(),
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
// Strategies — trading modes a token can pick
// ---------------------------------------------------------------------------
export async function listStrategies(_req, res) {
  const strategies = Object.values(STRATEGY_MODES).map(m => ({
    id: m.id,
    label: m.label,
    description: m.description,
    trade: m.trade,
    minLev: m.minLev || null,
    maxLev: m.maxLev || null,
  }));
  res.json({ strategies, default: DEFAULT_STRATEGY });
}

// ---------------------------------------------------------------------------
// Launchpads — supported Robinhood Chain launchpads
// ---------------------------------------------------------------------------
export async function listLaunchpads(_req, res) {
  const launchpads = Object.values(config.LAUNCHPADS).map(lp => ({
    id: lp.id,
    name: lp.name,
    url: lp.url,
    support: lp.support,
    howTo: lp.howTo,
    factory: lp.factory || null,
  }));
  res.json({ launchpads, protocolWallet: config.PROTOCOL_ADDRESS });
}

// ---------------------------------------------------------------------------
// Markets — list all available Ostium stock perp markets
// ---------------------------------------------------------------------------
let _marketsCache = { data: null, expiresAt: 0 };

export async function listMarkets(_req, res) {
  try {
    if (_marketsCache.data && Date.now() < _marketsCache.expiresAt) {
      return res.json(_marketsCache.data);
    }
    const activeId = await ostium.activeVenueId().catch(() => config.TRADING_VENUE);

    // Live per-symbol truth from the ACTIVE venue: availability + the real
    // leverage cap (e.g. Hyperliquid equities are 20x majors / 10x rest —
    // never advertise leverage the venue won't accept).
    const markets = await Promise.all(config.STOCK_MARKETS.map(async (symbol) => {
      try {
        const pair = await ostium.findPair(symbol);
        return {
          symbol,
          provider: activeId,
          available: !!pair,
          maxLeverage: Math.min(pair?.maxLeverage || 0, config.OSTIUM.MAX_LEVERAGE) || 0,
        };
      } catch {
        return { symbol, provider: activeId, available: false, maxLeverage: 0 };
      }
    }));

    const venueMaxLeverage = Math.max(0, ...markets.map((m) => m.maxLeverage));
    const data = { markets, venue: activeId, venueMaxLeverage };
    _marketsCache = { data, expiresAt: Date.now() + 60_000 };
    res.json(data);
  } catch (err) {
    logger.error('listMarkets error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
}

// Which perp venue the engine trades on, and every venue's live state.
// POST /recovery/claim { wallet } — verify a wallet against the on-chain
// eligibility database and add it to the public payout queue.
export async function claimRecovery(req, res) {
  try {
    const result = await recoverySvc.claimRecovery(req.body?.wallet);
    if (!result.ok) {
      const msgs = {
        'invalid-address': 'That does not look like a valid 0x wallet address.',
        'no-loss-found': 'No net loss found for this wallet on the retired token.',
        'not-open-yet': 'Claims are not open yet — check back shortly.',
      };
      return res.status(400).json({ ...result, message: msgs[result.reason] || 'Claim failed' });
    }
    res.json(result);
  } catch (err) {
    logger.error('claimRecovery error', { error: err.message });
    res.status(500).json({ error: 'Claim failed' });
  }
}

// Recovery pool — the public make-good ledger for the retired first token.
// Wallets are shortened for display; full amounts and tx hashes are real.
export async function getRecovery(_req, res) {
  try {
    const [ledger, elig] = await Promise.all([
      db.getConfig('recovery-ledger'),
      db.getConfig('recovery-eligibility'),
    ]);
    if (!ledger && !elig) return res.json({ active: false });
    if (!ledger) {
      // eligibility ready, no claims yet — section shows with the claim box
      return res.json({
        active: true, complete: false, claimsOpen: true,
        eligibleCount: elig.eligibleCount || 0,
        totalEligibleEth: elig.totalEligibleEth || 0,
        liabilityEth: 0, accruedEth: 0, paidEth: 0, victims: [], payouts: [],
        snapshotAt: elig.snapshotAt || null, completedAt: null,
      });
    }
    const victims = Object.entries(ledger.victims || {}).map(([wallet, v]) => ({
      wallet: wallet.slice(0, 6) + '\u2026' + wallet.slice(-4),
      lostEth: v.lostEth || 0,
      paidEth: v.paidEth || 0,
      madeWhole: (v.paidEth || 0) >= (v.lostEth || 0) - 1e-8,
    })).sort((a, b) => b.lostEth - a.lostEth);
    res.json({
      active: !ledger.complete,
      complete: !!ledger.complete,
      claimsOpen: !!elig,
      eligibleCount: elig?.eligibleCount || 0,
      totalEligibleEth: elig?.totalEligibleEth || 0,
      liabilityEth: ledger.liabilityEth || 0,
      accruedEth: ledger.accruedEth || 0,
      paidEth: ledger.paidEth || 0,
      victims,
      payouts: (ledger.payouts || []).slice(-20).reverse().map(p => ({
        to: p.to.slice(0, 6) + '\u2026' + p.to.slice(-4),
        amountEth: p.amountEth, hash: p.hash, at: p.at,
      })),
      snapshotAt: ledger.snapshotAt || null,
      completedAt: ledger.completedAt || null,
    });
  } catch (err) {
    logger.error('getRecovery error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch recovery state' });
  }
}

export async function listVenues(_req, res) {
  try {
    res.json(await ostium.getVenueStatus());
  } catch (err) {
    logger.error('listVenues error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch venues' });
  }
}

// ---------------------------------------------------------------------------
// Ticker — stock quotes for the frontend ticker bar (proxies Yahoo Finance
// because it doesn't allow browser CORS requests)
// ---------------------------------------------------------------------------
let _tickerCache = { data: null, expiresAt: 0 };

export async function getTicker(_req, res) {
  try {
    if (_tickerCache.data && Date.now() < _tickerCache.expiresAt) {
      return res.json({ ticker: _tickerCache.data });
    }

    const symbols = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'GOOG', 'AMZN', 'META', 'HOOD'];
    const results = await Promise.all(symbols.map(async (sym) => {
      try {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } },
        );
        if (!r.ok) return null;
        const d = await r.json();
        const meta = d?.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) return null;
        const prev = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
        return {
          symbol: sym,
          price: meta.regularMarketPrice,
          change: prev > 0 ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0,
        };
      } catch {
        return null;
      }
    }));

    const ticker = results.filter(Boolean);
    if (ticker.length > 0) {
      _tickerCache = { data: ticker, expiresAt: Date.now() + 60_000 };
      return res.json({ ticker });
    }
    // Upstream hiccup: serve the last REAL quotes (stale beats blank —
    // never fabricate) as long as we have any
    if (_tickerCache.data) {
      return res.json({ ticker: _tickerCache.data, stale: true });
    }
    res.json({ ticker });
  } catch (err) {
    logger.error('getTicker error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch ticker' });
  }
}

// ---------------------------------------------------------------------------
// Charts — stock candles (Yahoo proxy) and Pons token candles (GeckoTerminal)
// ---------------------------------------------------------------------------
const _stockChartCache = new Map(); // symbol:range -> { data, expiresAt }

export async function getStockChart(req, res) {
  try {
    const symbol = (req.params.symbol || '').toUpperCase();
    if (!config.STOCK_MARKETS.includes(symbol)) {
      return res.status(400).json({ error: `Unknown market. Valid: ${config.STOCK_MARKETS.join(', ')}` });
    }

    // range presets: 1d (5m candles), 5d (15m), 1mo (1h), 6mo (1d)
    const range = ['1d', '5d', '1mo', '6mo'].includes(req.query.range) ? req.query.range : '1d';
    const interval = { '1d': '5m', '5d': '15m', '1mo': '1h', '6mo': '1d' }[range];

    const cacheKey = `${symbol}:${range}`;
    const cached = _stockChartCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return res.json(cached.data);
    }

    // On any upstream failure, fall back to the last REAL candles we have
    // (stale-but-true beats an OFFLINE flash — and we never fabricate).
    const staleFallback = () => {
      const stale = _stockChartCache.get(cacheKey);
      if (stale?.data?.candles?.length >= 2) {
        return res.json({ ...stale.data, stale: true });
      }
      return null;
    };

    let raw;
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=true`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
      );
      if (!r.ok) return staleFallback() ?? res.status(502).json({ error: `Upstream ${r.status}` });
      raw = await r.json();
    } catch {
      return staleFallback() ?? res.status(502).json({ error: 'Upstream unreachable' });
    }

    const result = raw?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] == null) continue;
      candles.push({ t: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0 });
    }

    if (candles.length < 2) {
      const served = staleFallback();
      if (served) return;
    }

    const meta = result?.meta || {};
    const prev = meta.chartPreviousClose || meta.previousClose || candles[0]?.c || 0;
    const last = meta.regularMarketPrice || candles[candles.length - 1]?.c || 0;

    const data = {
      symbol,
      range,
      interval,
      price: last,
      change: prev > 0 ? ((last - prev) / prev) * 100 : 0,
      candles,
    };

    _stockChartCache.set(cacheKey, { data, expiresAt: Date.now() + 60_000 });
    res.json(data);
  } catch (err) {
    logger.error('getStockChart error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch chart' });
  }
}

// ---------------------------------------------------------------------------
// On-chain stocks — tokenized equities (xStocks) priced by Birdeye on Solana,
// shown next to the real NYSE quote (Yahoo) with the on-chain premium/discount.
// Same thesis as the product: real stock exposure, on-chain. Stays dormant
// (enabled:false) until BIRDEYE_API_KEY is set — never fabricates a price.
// ---------------------------------------------------------------------------
let _onchainCache = { data: null, expiresAt: 0 };

async function fetchYahooQuote(symbol) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    );
    if (!r.ok) return null;
    const p = (await r.json())?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === 'number' && p > 0 ? p : null;
  } catch {
    return null;
  }
}

export async function getOnchainStocks(_req, res) {
  try {
    if (!birdeye.isEnabled()) {
      return res.json({ enabled: false, stocks: [] });
    }
    if (_onchainCache.data && Date.now() < _onchainCache.expiresAt) {
      return res.json({ enabled: true, stocks: _onchainCache.data });
    }

    const onchain = await birdeye.getOnchainStockPrices(config.STOCK_MARKETS);
    const stocks = await Promise.all(onchain.map(async (o) => {
      const equity = await fetchYahooQuote(o.symbol);
      const premiumPct = equity ? ((o.priceUsd - equity) / equity) * 100 : null;
      return {
        symbol: o.symbol,
        xSymbol: o.xSymbol,
        address: o.address,
        onchainPriceUsd: o.priceUsd,
        equityPriceUsd: equity,
        premiumPct,
      };
    }));

    if (stocks.length > 0) {
      _onchainCache = { data: stocks, expiresAt: Date.now() + 60_000 };
    }
    res.json({ enabled: true, stocks });
  } catch (err) {
    logger.error('getOnchainStocks error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch on-chain stocks' });
  }
}

export async function getTokenChart(req, res) {
  try {
    const { address } = req.params;
    if (!isAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    const timeframe = ['minute', 'hour', 'day'].includes(req.query.timeframe) ? req.query.timeframe : 'hour';
    const [candles, stats] = await Promise.all([
      gecko.getTokenOhlcv(address, timeframe, 1, 100),
      gecko.getTokenStats(address),
    ]);

    res.json({ address, timeframe, stats, candles });
  } catch (err) {
    logger.error('getTokenChart error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch token chart' });
  }
}

export async function getTokenMarketData(req, res) {
  try {
    const { address } = req.params;
    if (!isAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }
    const stats = await gecko.getTokenStats(address);
    if (!stats) return res.status(404).json({ error: 'No market data for this token yet' });
    res.json({ address, ...stats });
  } catch (err) {
    logger.error('getTokenMarketData error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch market data' });
  }
}

// ---------------------------------------------------------------------------
// Admin: approve or reject a pending token (anti-bait approval gate)
export async function moderateToken(req, res) {
  // Fail closed — same auth as the other admin endpoints
  const authKey = req.headers['x-admin-key'] || req.query.key;
  const expectedKey = process.env.ADMIN_API_KEY;
  if (!expectedKey) {
    return res.status(403).json({ error: 'Admin endpoint disabled — set ADMIN_API_KEY to enable' });
  }
  if (authKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { address, action } = req.params;
    if (!isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }
    const token = await db.getToken(address.toLowerCase()) || await db.getToken(getAddress(address));
    if (!token) return res.status(404).json({ error: 'Token not found' });
    const status = action === 'approve' ? 'active' : 'retired';
    await db.setToken(token.address || address, {
      status,
      moderatedAt: Date.now(),
      ...(action === 'reject' ? { retiredReason: 'rejected by moderation' } : {}),
    });
    logger.info(`Token ${action}d by admin`, { address, symbol: token.symbol });
    res.json({ ok: true, address, status });
  } catch (err) {
    logger.error('moderateToken error', { error: err.message });
    res.status(500).json({ error: 'Moderation failed' });
  }
}

// Admin: list tokens awaiting approval
export async function listPendingTokens(req, res) {
  const authKey = req.headers['x-admin-key'] || req.query.key;
  const expectedKey = process.env.ADMIN_API_KEY;
  if (!expectedKey) return res.status(403).json({ error: 'Admin endpoint disabled' });
  if (authKey !== expectedKey) return res.status(401).json({ error: 'Unauthorized' });
  const all = await db.getAllTokens();
  res.json({ pending: all.filter((t) => t.status === 'pending') });
}

// Admin: manually trigger a worker cycle
// ---------------------------------------------------------------------------
export async function triggerWorker(req, res) {
  // Fail closed: without a configured admin key this endpoint is disabled.
  // (The old check let ANYONE trigger workers when ADMIN_API_KEY was unset.)
  const authKey = req.headers['x-admin-key'] || req.query.key;
  const expectedKey = process.env.ADMIN_API_KEY;
  if (!expectedKey) {
    return res.status(403).json({ error: 'Admin endpoint disabled — set ADMIN_API_KEY to enable' });
  }
  if (authKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
// Trade History — Ostium fills for the protocol account
// ---------------------------------------------------------------------------
let _tradeCache = { data: null, expiresAt: 0 };

export async function getTradeHistory(_req, res) {
  try {
    // Cache for 30s
    if (_tradeCache.data && Date.now() < _tradeCache.expiresAt) {
      return res.json({ trades: _tradeCache.data });
    }

    const fills = await ostium.getFills(60);
    const trades = fills.map(f => ({
      signature: f.txHash || f.id || null,
      time: f.createdAt || f.timestamp || null,
      position: (f.market || '').replace(/-PERP$|-USD$/, ''),
      action: `${(f.side || '').toUpperCase() === 'SELL' ? 'Decrease' : 'Increase'} ${f.positionSide || 'Long'}`,
      orderType: f.type || 'Market',
      depositWithdraw: parseFloat(f.notional || f.sizeUsd || 0),
      sizeUsd: parseFloat(f.notional || f.sizeUsd || 0) || null,
      pnl: f.realizedPnl != null ? parseFloat(f.realizedPnl) : null,
      fee: parseFloat(f.fee || 0),
    }));

    _tradeCache = { data: trades, expiresAt: Date.now() + 30_000 };
    res.json({ trades });
  } catch (err) {
    logger.error('getTradeHistory error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch trade history' });
  }
}

// ---------------------------------------------------------------------------
// Live Positions — Ostium unrealised PnL
// ---------------------------------------------------------------------------
let _livePositionCache = { data: null, expiresAt: 0 };

export async function getLivePositions(_req, res) {
  try {
    // Cache 10s
    if (_livePositionCache.data && Date.now() < _livePositionCache.expiresAt) {
      return res.json({ positions: _livePositionCache.data });
    }

    const positions = await ostium.getAllPositions();

    _livePositionCache = { data: positions, expiresAt: Date.now() + 10_000 };
    res.json({ positions });
  } catch (err) {
    logger.error('getLivePositions error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch live positions' });
  }
}
