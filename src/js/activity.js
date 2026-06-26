/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Live Activity Feed
   Polls the backend for protocol events and displays them
   in a scrolling terminal-style feed.
   ═══════════════════════════════════════════════════════════ */

const MAX_ITEMS = 30;
let feedItems = [];

export function initActivityFeed() {
  const body = document.getElementById('activity-feed-body');
  if (!body) return;

  // Initial fetch
  fetchActivity(body);

  // Poll every 30 seconds
  setInterval(() => fetchActivity(body), 30000);
}

async function fetchActivity(container) {
  try {
    // Fetch tokens and positions to generate activity events
    const [tokensRes, statsRes] = await Promise.all([
      fetch('/api/v1/tokens').catch(() => null),
      fetch('/api/v1/stats').catch(() => null),
    ]);

    const events = [];
    const now = Date.now();

    if (tokensRes?.ok) {
      const { tokens } = await tokensRes.json();
      if (tokens && tokens.length > 0) {
        tokens.forEach(t => {
          // Token registration event
          events.push({
            time: t.createdAt || now,
            type: 'register',
            detail: `${truncate(t.mint)} registered → ${t.underlying || '?'}-PERP ${(t.side || 'long').toUpperCase()} ${t.leverage || 100}x`,
          });

          // If token has position data, add position event
          if (t.deployedSol && t.deployedSol > 0) {
            events.push({
              time: (t.createdAt || now) + 1000,
              type: 'position',
              detail: `${t.underlying || '?'}-PERP ${(t.side || 'long').toUpperCase()} opened — ${t.sizeUsd ? '$' + fmt(t.sizeUsd) : t.deployedSol?.toFixed(4) + ' SOL'} collateral`,
            });
          }
        });
      }
    }

    if (statsRes?.ok) {
      const data = await statsRes.json();
      if (data.totalFees > 0) {
        events.push({
          time: now - 5000,
          type: 'fees',
          detail: `$${fmt(data.totalFees)} total fees claimed by protocol`,
        });
      }
      if (data.totalBuybacks > 0) {
        events.push({
          time: now - 3000,
          type: 'buyback',
          detail: `$${fmt(data.totalBuybacks)} bought back and burned`,
        });
      }
      if (data.totalPnl && data.totalPnl !== 0) {
        events.push({
          time: now - 1000,
          type: 'pnl',
          detail: `${data.totalPnl > 0 ? '+' : ''}$${fmt(data.totalPnl)} total perp PnL`,
        });
      }
    }

    // Sort by time descending
    events.sort((a, b) => b.time - a.time);

    // Only update if we have events
    if (events.length > 0) {
      feedItems = events.slice(0, MAX_ITEMS);
      renderFeed(container);
    }
  } catch (err) {
    // Silently fail — feed is non-critical
  }
}

function renderFeed(container) {
  if (feedItems.length === 0) return;

  container.innerHTML = feedItems.map(item => `
    <div class="activity-item">
      <span class="activity-time">${formatTime(item.time)}</span>
      <span class="activity-type">${item.type}</span>
      <span class="activity-detail">${item.detail}</span>
    </div>
  `).join('');
}

function formatTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function truncate(s) {
  if (!s || s.length < 12) return s || '—';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function fmt(n) {
  if (typeof n !== 'number') return '0';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toFixed(2);
}
