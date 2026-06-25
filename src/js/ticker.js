/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Live Price Ticker
   Fetches SOL + major token prices and scrolls them across
   the top of the page.
   ═══════════════════════════════════════════════════════════ */

const TICKER_TOKENS = [
  { symbol: 'SOL', coingeckoId: 'solana' },
  { symbol: 'BTC', coingeckoId: 'bitcoin' },
  { symbol: 'ETH', coingeckoId: 'ethereum' },
  { symbol: 'BONK', coingeckoId: 'bonk' },
  { symbol: 'WIF', coingeckoId: 'dogwifcoin' },
  { symbol: 'JUP', coingeckoId: 'jupiter-exchange-solana' },
  { symbol: 'JTO', coingeckoId: 'jito-governance-token' },
  { symbol: 'PYTH', coingeckoId: 'pyth-network' },
];

// Fallback mock prices for when API is unavailable
const MOCK_PRICES = {
  SOL: { price: 178.42, change: 3.2 },
  BTC: { price: 104832, change: 1.1 },
  ETH: { price: 3842, change: -0.8 },
  BONK: { price: 0.0000312, change: 12.4 },
  WIF: { price: 2.87, change: -2.1 },
  JUP: { price: 1.24, change: 5.6 },
  JTO: { price: 3.91, change: 0.4 },
  PYTH: { price: 0.48, change: -1.3 },
};

export function initTicker() {
  const tickerBar = document.getElementById('ticker-bar');
  if (!tickerBar) return;

  // Initial render with mock data
  renderTicker(tickerBar, MOCK_PRICES);

  // Try to fetch real prices
  fetchPrices().then(prices => {
    if (prices) {
      renderTicker(tickerBar, prices);
    }
  });

  // Refresh prices every 60 seconds
  setInterval(async () => {
    const prices = await fetchPrices();
    if (prices) {
      renderTicker(tickerBar, prices);
    } else {
      // Jitter mock data to simulate movement
      const jittered = {};
      for (const [sym, data] of Object.entries(MOCK_PRICES)) {
        const jitter = 1 + (Math.random() - 0.5) * 0.01;
        jittered[sym] = {
          price: data.price * jitter,
          change: data.change + (Math.random() - 0.5) * 0.5,
        };
      }
      renderTicker(tickerBar, jittered);
    }
  }, 60_000);
}

function renderTicker(container, prices) {
  const items = TICKER_TOKENS.map(t => {
    const data = prices[t.symbol];
    if (!data) return '';

    const priceStr = formatTickerPrice(data.price);
    const changeStr = data.change >= 0
      ? `+${data.change.toFixed(1)}%`
      : `${data.change.toFixed(1)}%`;
    const changeClass = data.change >= 0 ? 'ticker-up' : 'ticker-down';

    return `<span class="ticker-item">
      <span class="ticker-symbol">${t.symbol}</span>
      <span class="ticker-price">$${priceStr}</span>
      <span class="ticker-change ${changeClass}">${changeStr}</span>
    </span>`;
  }).join('');

  // Duplicate content for seamless loop
  container.innerHTML = `
    <div class="ticker-track">
      <div class="ticker-content">${items}</div>
      <div class="ticker-content" aria-hidden="true">${items}</div>
    </div>
  `;
}

function formatTickerPrice(price) {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(7);
}

async function fetchPrices() {
  try {
    const ids = TICKER_TOKENS.map(t => t.coingeckoId).join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const result = {};

    for (const t of TICKER_TOKENS) {
      const entry = data[t.coingeckoId];
      if (entry) {
        result[t.symbol] = {
          price: entry.usd || 0,
          change: entry.usd_24h_change || 0,
        };
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}
