import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Market Signal Engine v2
//
// Analyzes SOL price action + derivatives data for entry/exit timing.
//
// Signals:
//   1. Momentum (EMA crossovers on 1m candles)
//   2. RSI (context-aware: overbought only bearish if HTF trend is weak)
//   3. MACD (trend confirmation)
//   4. Higher timeframe trend (15m + 1H EMA)
//   5. Volatility (ATR-based)
//   6. Session timing (US/Europe/Asia)
//   7. Volume confirmation (high volume validates moves)
//   8. Funding rate (avoid overcrowded longs)
//   9. Recent price action
//
// Returns a score from -100 to +100 and recommended leverage.
// ---------------------------------------------------------------------------

const BINANCE_API = 'https://api.binance.com/api/v3';
const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';

// Caches
let cache1m = { data: null, at: 0 };
let cache15m = { data: null, at: 0 };
let cache1h = { data: null, at: 0 };
let cacheFunding = { data: null, at: 0 };
let cacheOI = { data: null, at: 0 };
const CACHE_TTL = 30_000;

// ---------------------------------------------------------------------------
// Data Fetchers
// ---------------------------------------------------------------------------

async function fetchKlines(symbol, interval, limit, cache) {
  if (cache.data && Date.now() - cache.at < CACHE_TTL) return cache.data;
  try {
    const r = await fetch(`${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!r.ok) throw new Error(`${r.status}`);
    const raw = await r.json();
    const candles = raw.map(k => ({
      openTime: k[0], open: +k[1], high: +k[2], low: +k[3],
      close: +k[4], volume: +k[5], closeTime: k[6],
    }));
    cache.data = candles;
    cache.at = Date.now();
    return candles;
  } catch (e) {
    logger.warn('Kline fetch failed', { interval, error: e.message });
    return cache.data || [];
  }
}

async function getCandles1m() { return fetchKlines('SOLUSDT', '1m', 100, cache1m); }
async function getCandles15m() { return fetchKlines('SOLUSDT', '15m', 50, cache15m); }
async function getCandles1h() { return fetchKlines('SOLUSDT', '1h', 210, cache1h); }

async function getFundingRate() {
  if (cacheFunding.data !== null && Date.now() - cacheFunding.at < 60_000) return cacheFunding.data;
  try {
    const r = await fetch(`${BINANCE_FAPI}/fundingRate?symbol=SOLUSDT&limit=1`);
    if (!r.ok) return cacheFunding.data || 0;
    const d = await r.json();
    const rate = parseFloat(d[0]?.fundingRate) || 0;
    cacheFunding = { data: rate, at: Date.now() };
    return rate;
  } catch {
    return cacheFunding.data || 0;
  }
}

async function getOpenInterest() {
  if (cacheOI.data !== null && Date.now() - cacheOI.at < 60_000) return cacheOI.data;
  try {
    const r = await fetch(`${BINANCE_FAPI}/openInterest?symbol=SOLUSDT`);
    if (!r.ok) return cacheOI.data || 0;
    const d = await r.json();
    const oi = parseFloat(d.openInterest) || 0;
    cacheOI = { data: oi, at: Date.now() };
    return oi;
  } catch {
    return cacheOI.data || 0;
  }
}

// ---------------------------------------------------------------------------
// Technical Indicators
// ---------------------------------------------------------------------------

function sma(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function ema(values, period) {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  return sma(trs, Math.min(period, trs.length));
}

function macd(closes) {
  return ema(closes, 12) - ema(closes, 26);
}

// ---------------------------------------------------------------------------
// Session & Volume Helpers
// ---------------------------------------------------------------------------

function getSession() {
  const h = new Date().getUTCHours();
  if (h >= 13 && h < 16) return 'us-europe-overlap';
  if (h >= 13 && h < 22) return 'us';
  if (h >= 7 && h < 13) return 'europe';
  if (h >= 0 && h < 8) return 'asia';
  return 'off-hours';
}

function sessionScore() {
  switch (getSession()) {
    case 'us-europe-overlap': return 25;
    case 'us': return 20;
    case 'europe': return 10;
    case 'asia': return 5;
    default: return 0;
  }
}

/**
 * Volume score: compare recent volume to average.
 * High volume on a move confirms it's real.
 */
function volumeScore(candles) {
  if (candles.length < 30) return 0;
  const volumes = candles.map(c => c.volume);
  const avgVol = sma(volumes, 20);
  const recentVol = sma(volumes.slice(-5), 5);
  const ratio = avgVol > 0 ? recentVol / avgVol : 1;

  // Recent candle direction (are volume candles bullish or bearish?)
  const last5 = candles.slice(-5);
  const bullishVol = last5.filter(c => c.close > c.open).reduce((s, c) => s + c.volume, 0);
  const bearishVol = last5.filter(c => c.close <= c.open).reduce((s, c) => s + c.volume, 0);
  const volBias = bullishVol > bearishVol ? 1 : -1;

  if (ratio > 2.0) return 15 * volBias;   // very high volume
  if (ratio > 1.5) return 10 * volBias;   // above average
  if (ratio > 1.0) return 5 * volBias;    // slightly above
  return 0;                                 // below average = no confirmation
}

// ---------------------------------------------------------------------------
// Main Signal Generation
// ---------------------------------------------------------------------------

/**
 * Generate a comprehensive market signal for SOL.
 *
 * @returns {{ score, direction, confidence, leverage, details }}
 */
export async function getMarketSignal() {
  try {
    const [c1m, c15m, c1h, funding] = await Promise.all([
      getCandles1m(),
      getCandles15m(),
      getCandles1h(),
      getFundingRate(),
    ]);

    if (c1m.length < 30) {
      return { score: 0, direction: 'wait', confidence: 0, leverage: 30, details: { error: 'insufficient data' } };
    }

    const closes1m = c1m.map(c => c.close);
    const closes15m = c15m.map(c => c.close);
    const closes1h = c1h.map(c => c.close);
    const price = closes1m[closes1m.length - 1];

    // === 1. Momentum (EMA crossovers on 1m) ===
    const ema5 = ema(closes1m, 5);
    const ema20 = ema(closes1m, 20);
    const ema50 = ema(closes1m, 50);

    let momentumScore = 0;
    if (ema5 > ema20) momentumScore += 15; else momentumScore -= 15;
    if (ema20 > ema50) momentumScore += 10; else momentumScore -= 10;
    if (price > ema20) momentumScore += 5; else momentumScore -= 5;

    // === 2. RSI (context-aware) ===
    const rsiVal = rsi(closes1m, 14);
    let rsiScore = 0;

    // Check if we're in a strong HTF uptrend
    const htfBullish = closes1h.length >= 50 && ema(closes1h, 10) > ema(closes1h, 50);

    if (rsiVal < 30) rsiScore = 20;          // oversold = strong buy
    else if (rsiVal < 40) rsiScore = 10;
    else if (rsiVal > 70 && !htfBullish) rsiScore = -20;  // overbought + weak trend = bearish
    else if (rsiVal > 70 && htfBullish) rsiScore = 5;     // overbought but strong trend = still ok
    else if (rsiVal > 60) rsiScore = -5;

    // === 3. MACD ===
    const macdVal = macd(closes1m);
    const macdScore = macdVal > 0 ? 10 : -10;

    // === 4. Higher Timeframe Trend ===
    // 15m trend
    let htfScore = 0;
    if (closes15m.length >= 20) {
      if (ema(closes15m, 10) > ema(closes15m, 20)) htfScore += 10;
      else htfScore -= 10;
    }

    // 1H EMA200 -- the big trend filter
    if (closes1h.length >= 200) {
      const ema200_1h = ema(closes1h, 200);
      if (price > ema200_1h) htfScore += 10;  // above 1H EMA200 = bullish
      else htfScore -= 10;                     // below = bearish
    } else if (closes1h.length >= 50) {
      // Fallback to 1H EMA50
      const ema50_1h = ema(closes1h, 50);
      if (price > ema50_1h) htfScore += 5;
      else htfScore -= 5;
    }

    // === 5. Volatility ===
    const atrVal = atr(c1m, 14);
    const atrPct = price > 0 ? (atrVal / price) * 100 : 0;
    let volScore = 0;
    if (atrPct > 0.05 && atrPct < 0.3) volScore = 10;
    else if (atrPct >= 0.3) volScore = -5;
    else volScore = -10;

    // === 6. Session ===
    const sessScore = sessionScore();

    // === 7. Volume Confirmation ===
    const volConfirm = volumeScore(c1m);

    // === 8. Funding Rate ===
    // High positive funding = overcrowded longs = bearish signal
    // Negative funding = shorts paying longs = bullish
    let fundingScore = 0;
    if (funding > 0.0005) fundingScore = -15;       // very crowded longs
    else if (funding > 0.0003) fundingScore = -10;   // moderately crowded
    else if (funding > 0.0001) fundingScore = -5;    // slightly crowded
    else if (funding < -0.0001) fundingScore = 10;   // shorts paying = bullish
    else if (funding < -0.0003) fundingScore = 15;   // very bearish consensus = contrarian buy
    else fundingScore = 0;

    // === 9. Recent Price Action ===
    const last5 = closes1m.slice(-5);
    const recentMove = (last5[last5.length - 1] - last5[0]) / last5[0] * 100;
    let recentScore = 0;
    if (recentMove > 0.1) recentScore = 10;
    else if (recentMove > 0.05) recentScore = 5;
    else if (recentMove < -0.1) recentScore = -10;
    else if (recentMove < -0.05) recentScore = -5;

    // === Combine ===
    const raw = momentumScore + rsiScore + macdScore + htfScore +
                volScore + sessScore + volConfirm + fundingScore + recentScore;
    const score = Math.max(-100, Math.min(100, raw));

    // Direction
    let direction = 'wait';
    if (score >= 25) direction = 'long';
    else if (score <= -25) direction = 'short';

    const confidence = Math.abs(score);

    // === Leverage scaling based on score ===
    let leverage;
    if (confidence >= 80) leverage = 100;
    else if (confidence >= 60) leverage = 80;
    else if (confidence >= 40) leverage = 60;
    else leverage = 50;  // minimum 50x -- no point going lower in degen mode

    const session = getSession();

    const details = {
      currentPrice: price.toFixed(2),
      momentum: momentumScore,
      rsi: { value: rsiVal.toFixed(1), score: rsiScore, htfBullish },
      macd: { value: macdVal.toFixed(4), score: macdScore },
      htf: htfScore,
      volatility: { atrPct: atrPct.toFixed(4), score: volScore },
      session: { name: session, score: sessScore },
      volume: volConfirm,
      funding: { rate: (funding * 100).toFixed(4) + '%', score: fundingScore },
      recentMove: { pct: recentMove.toFixed(3) + '%', score: recentScore },
      ema: { ema5: ema5.toFixed(2), ema20: ema20.toFixed(2), ema50: ema50.toFixed(2) },
    };

    logger.info('Market signal v2', {
      score, direction, confidence, leverage,
      price: price.toFixed(2), rsi: rsiVal.toFixed(1),
      funding: (funding * 100).toFixed(4) + '%', session,
    });

    return { score, direction, confidence, leverage, details };
  } catch (err) {
    logger.error('Market signal error', { error: err.message });
    return { score: 0, direction: 'wait', confidence: 0, leverage: 30, details: { error: err.message } };
  }
}

/**
 * Check if we should enter a position right now.
 * Returns entry decision + recommended leverage.
 */
export async function shouldEnterNow() {
  const signal = await getMarketSignal();

  // Only enter on strong conviction (score >= 25)
  if (signal.direction === 'long' && signal.score >= 25) {
    return { enter: true, signal };
  }

  return { enter: false, signal };
}

/**
 * Check if we should EXIT an existing position.
 * Called while a position is open to detect momentum reversal.
 *
 * @param {'long'|'short'} positionSide - current position direction
 * @returns {{ shouldExit: boolean, reason: string, signal: object }}
 */
export async function shouldExitNow(positionSide = 'long') {
  const signal = await getMarketSignal();

  // For longs: exit if signal goes strongly negative (momentum reversal)
  if (positionSide === 'long') {
    if (signal.score <= -30) {
      return { shouldExit: true, reason: 'momentum-reversal', signal };
    }
    // Funding rate extremely high = flush incoming
    if (signal.details?.funding?.score <= -15) {
      return { shouldExit: true, reason: 'overcrowded-funding', signal };
    }
  }

  // For shorts: exit if signal goes strongly positive
  if (positionSide === 'short') {
    if (signal.score >= 30) {
      return { shouldExit: true, reason: 'momentum-reversal', signal };
    }
  }

  return { shouldExit: false, reason: 'hold', signal };
}
