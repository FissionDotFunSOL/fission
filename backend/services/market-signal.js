import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Market Signal Engine
//
// Analyzes SOL price action to determine optimal entry timing.
// Uses multiple signals:
//   1. Momentum (short-term price direction from recent candles)
//   2. Volatility (ATR-based -- high vol = bigger moves = bigger wins)
//   3. Session timing (US/Asia/Europe session awareness)
//   4. RSI (avoid buying at extreme overbought levels)
//   5. Support/resistance (basic pivot point detection)
//
// Returns a score from -100 (strong short) to +100 (strong long)
// and a recommendation: 'long', 'short', or 'wait'
// ---------------------------------------------------------------------------

const BINANCE_KLINES = 'https://api.binance.com/api/v3/klines';

// Cache candle data so we don't spam the API
let candleCache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Fetch recent 1-minute candles from Binance.
 */
async function getCandles(symbol = 'SOLUSDT', interval = '1m', limit = 100) {
  if (candleCache.data && Date.now() - candleCache.fetchedAt < CACHE_TTL_MS) {
    return candleCache.data;
  }

  try {
    const url = `${BINANCE_KLINES}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API ${res.status}`);
    const raw = await res.json();

    const candles = raw.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }));

    candleCache = { data: candles, fetchedAt: Date.now() };
    return candles;
  } catch (err) {
    logger.warn('Failed to fetch candles', { error: err.message });
    return candleCache.data || [];
  }
}

/**
 * Fetch 15-minute candles for higher timeframe context.
 */
async function getCandles15m(symbol = 'SOLUSDT', limit = 50) {
  try {
    const url = `${BINANCE_KLINES}?symbol=${symbol}&interval=15m&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const raw = await res.json();
    return raw.map(k => ({
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Technical Indicators
// ---------------------------------------------------------------------------

/**
 * Simple Moving Average
 */
function sma(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/**
 * Exponential Moving Average
 */
function ema(values, period) {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

/**
 * RSI (Relative Strength Index)
 */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Average True Range (volatility)
 */
function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trs.push(tr);
  }
  return sma(trs, Math.min(period, trs.length));
}

/**
 * MACD (Moving Average Convergence Divergence)
 */
function macd(closes) {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  return fast - slow;
}

/**
 * Detect current trading session.
 * Returns 'asia', 'europe', 'us', or 'overlap'.
 */
function getSession() {
  const now = new Date();
  const utcHour = now.getUTCHours();

  // Asia: 00:00 - 08:00 UTC (Tokyo/Singapore)
  // Europe: 07:00 - 16:00 UTC (London)
  // US: 13:00 - 22:00 UTC (New York)
  // Overlaps are the most volatile

  if (utcHour >= 13 && utcHour < 16) return 'us-europe-overlap'; // highest volume
  if (utcHour >= 13 && utcHour < 22) return 'us';
  if (utcHour >= 7 && utcHour < 13) return 'europe';
  if (utcHour >= 0 && utcHour < 8) return 'asia';
  return 'off-hours';
}

/**
 * Session score: how favorable is the current session for trading.
 * US and overlap sessions have the most volume and cleanest moves.
 */
function sessionScore() {
  const session = getSession();
  switch (session) {
    case 'us-europe-overlap': return 25;  // best time to trade
    case 'us':                return 20;
    case 'europe':            return 10;
    case 'asia':              return 5;   // low vol, choppy
    default:                  return 0;
  }
}

// ---------------------------------------------------------------------------
// Main Signal Generation
// ---------------------------------------------------------------------------

/**
 * Generate a market signal for SOL.
 *
 * @returns {{ score: number, direction: 'long'|'short'|'wait', confidence: number, details: object }}
 *   score: -100 to +100 (negative = bearish, positive = bullish)
 *   direction: recommended trade direction
 *   confidence: 0 to 100
 *   details: breakdown of individual signals
 */
export async function getMarketSignal() {
  try {
    const [candles1m, candles15m] = await Promise.all([
      getCandles('SOLUSDT', '1m', 100),
      getCandles15m('SOLUSDT', 50),
    ]);

    if (candles1m.length < 30) {
      return { score: 0, direction: 'wait', confidence: 0, details: { error: 'insufficient data' } };
    }

    const closes1m = candles1m.map(c => c.close);
    const closes15m = candles15m.map(c => c.close);
    const currentPrice = closes1m[closes1m.length - 1];

    // --- 1. Momentum Signal (short-term direction) ---
    // Compare fast EMA vs slow EMA on 1m chart
    const ema5 = ema(closes1m, 5);
    const ema20 = ema(closes1m, 20);
    const ema50 = ema(closes1m, 50);

    // EMA crossover score: fast above slow = bullish
    let momentumScore = 0;
    if (ema5 > ema20) momentumScore += 15;
    else momentumScore -= 15;

    if (ema20 > ema50) momentumScore += 10;
    else momentumScore -= 10;

    // Price vs EMA20: above = uptrend
    if (currentPrice > ema20) momentumScore += 5;
    else momentumScore -= 5;

    // --- 2. RSI Signal ---
    const rsiVal = rsi(closes1m, 14);
    let rsiScore = 0;

    if (rsiVal < 30) rsiScore = 20;        // oversold = buy signal
    else if (rsiVal < 40) rsiScore = 10;    // approaching oversold
    else if (rsiVal > 70) rsiScore = -20;   // overbought = avoid longs
    else if (rsiVal > 60) rsiScore = -5;    // approaching overbought
    else rsiScore = 0;                       // neutral zone

    // --- 3. MACD Signal ---
    const macdVal = macd(closes1m);
    let macdScore = 0;
    if (macdVal > 0) macdScore = 10;
    else macdScore = -10;

    // --- 4. Higher timeframe trend (15m) ---
    let htfScore = 0;
    if (closes15m.length >= 20) {
      const ema10_15m = ema(closes15m, 10);
      const ema20_15m = ema(closes15m, 20);
      if (ema10_15m > ema20_15m) htfScore = 15;  // 15m uptrend
      else htfScore = -15;                        // 15m downtrend
    }

    // --- 5. Volatility check ---
    const atrVal = atr(candles1m, 14);
    const atrPct = currentPrice > 0 ? (atrVal / currentPrice) * 100 : 0;
    let volScore = 0;

    // We want SOME volatility (need movement to profit) but not extreme chop
    if (atrPct > 0.05 && atrPct < 0.3) volScore = 10;  // good volatility range
    else if (atrPct >= 0.3) volScore = -5;                // too choppy
    else volScore = -10;                                  // dead market

    // --- 6. Session timing ---
    const sessScore = sessionScore();

    // --- 7. Recent price action (last 5 candles momentum) ---
    const last5 = closes1m.slice(-5);
    const recentMove = (last5[last5.length - 1] - last5[0]) / last5[0] * 100;
    let recentScore = 0;
    if (recentMove > 0.1) recentScore = 10;       // strong recent up
    else if (recentMove > 0.05) recentScore = 5;
    else if (recentMove < -0.1) recentScore = -10; // strong recent down
    else if (recentMove < -0.05) recentScore = -5;

    // --- Combine all signals ---
    const totalScore = momentumScore + rsiScore + macdScore + htfScore + volScore + sessScore + recentScore;

    // Clamp to -100..100
    const clampedScore = Math.max(-100, Math.min(100, totalScore));

    // Determine direction and confidence
    let direction = 'wait';
    let confidence = Math.abs(clampedScore);

    if (clampedScore >= 25) direction = 'long';
    else if (clampedScore <= -25) direction = 'short';
    else direction = 'wait';

    const session = getSession();

    const details = {
      currentPrice: currentPrice.toFixed(2),
      momentum: momentumScore,
      rsi: { value: rsiVal.toFixed(1), score: rsiScore },
      macd: { value: macdVal.toFixed(4), score: macdScore },
      htf: htfScore,
      volatility: { atrPct: atrPct.toFixed(4), score: volScore },
      session: { name: session, score: sessScore },
      recentMove: { pct: recentMove.toFixed(3) + '%', score: recentScore },
      ema: { ema5: ema5.toFixed(2), ema20: ema20.toFixed(2), ema50: ema50.toFixed(2) },
    };

    logger.info('Market signal generated', {
      score: clampedScore, direction, confidence,
      price: currentPrice.toFixed(2), rsi: rsiVal.toFixed(1), session,
    });

    return { score: clampedScore, direction, confidence, details };
  } catch (err) {
    logger.error('Market signal error', { error: err.message });
    return { score: 0, direction: 'wait', confidence: 0, details: { error: err.message } };
  }
}

/**
 * Quick check: should we enter a position right now?
 * Returns true if conditions are favorable.
 */
export async function shouldEnterNow() {
  const signal = await getMarketSignal();

  // Require at least score >= 20 to enter long (our only direction for now)
  // This filters out about 40-50% of random entries
  if (signal.direction === 'long' && signal.score >= 20) {
    return { enter: true, signal };
  }

  // In degen mode, if score is between 0 and 20, enter with 50% probability
  // We don't want to sit out too long -- fees need to be deployed
  if (signal.score > 0 && signal.score < 20) {
    const roll = Math.random();
    if (roll < 0.4) {
      return { enter: true, signal: { ...signal, note: 'marginal-entry' } };
    }
  }

  return { enter: false, signal };
}
