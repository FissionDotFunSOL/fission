/* ═══════════════════════════════════════════════════════════
   FILL PROTOCOL — Hero live watchlist
   Fills the terminal window's watchlist with real quotes from
   the backend ticker proxy. No data → rows stay as dashes.
   Never invents prices.
   ═══════════════════════════════════════════════════════════ */

const WATCH_SYMBOLS = ['AAPL', 'TSLA', 'NVDA', 'HOOD'];

export function initHeroWatchlist() {
  initEngineStatus();
  const host = document.getElementById('hero-watchlist');
  if (!host) return;

  const refresh = async () => {
    const prices = await fetchPrices();
    if (!prices) return; // keep skeleton rows
    host.innerHTML = WATCH_SYMBOLS.map(sym => {
      const d = prices[sym];
      if (!d) {
        return `<div class="watch-row skeleton"><span class="sym">${sym}</span><span class="px">—</span><span class="chg">—</span></div>`;
      }
      const up = d.change >= 0;
      const chg = `${up ? '▲' : '▼'} ${Math.abs(d.change).toFixed(2)}%`;
      return `<div class="watch-row">
        <span class="sym">${sym}</span>
        <span class="px">$${fmt(d.price)}</span>
        <span class="chg ${up ? 'up' : 'down'}">${chg}</span>
      </div>`;
    }).join('');
  };

  refresh();
  setInterval(refresh, 60_000);
}

function fmt(p) {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(2);
  return p.toFixed(4);
}

// The terminal window's LIVE badge and engine line are driven by the real
// backend status — never claim LIVE when the engine is unreachable.
function initEngineStatus() {
  const live = document.querySelector('.term-live');
  const engineLine = document.getElementById('hero-engine-line');

  const refresh = async () => {
    try {
      const res = await fetch('/api/v1/status');
      if (!res.ok) throw new Error('down');
      const d = await res.json();

      if (live) live.innerHTML = '<span class="pulse-dot"></span> LIVE';
      if (engineLine) {
        const armed = d.wallet?.signerLoaded;
        const tokens = d.engine?.totalTokens ?? 0;
        const mkt = d.stockMarket?.open ? 'market open' : 'market closed';
        engineLine.innerHTML =
          `<span class="k">engine</span><span class="ok">${armed ? '▲ armed' : '○ read-only'}</span>` +
          `<span class="k">·</span><span>${tokens} token${tokens === 1 ? '' : 's'}</span>` +
          `<span class="k">·</span><span>${mkt}</span>`;
      }
    } catch {
      if (live) live.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:var(--text-tertiary);display:inline-block;"></span> OFFLINE';
      if (engineLine) {
        engineLine.innerHTML = '<span class="k">engine</span><span class="k">○ unreachable</span>';
      }
    }
  };

  refresh();
  setInterval(refresh, 60_000);
}

async function fetchPrices() {
  try {
    const res = await fetch('/api/v1/ticker');
    if (!res.ok) return null;
    const data = await res.json();
    const out = {};
    for (const e of (data.ticker || [])) {
      out[e.symbol] = { price: e.price || 0, change: e.change || 0 };
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}
