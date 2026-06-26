/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Live Dashboard
   Fetches tokens + positions from /api/v1/ endpoints.
   Shows direction (LONG/SHORT), leverage, entry price,
   PnL, position size for every registered token.
   ═══════════════════════════════════════════════════════════ */

import { formatNumber, formatCurrency } from './data.js';

let currentData = [];
let sortField = 'pnl';
let sortDir = 'desc';
let searchQuery = '';
let updateInterval;

export function initDashboard() {
  const tbody = document.getElementById('dashboard-body');
  const searchInput = document.getElementById('dashboard-search');
  const sortSelect = document.getElementById('dashboard-sort');

  if (!tbody) return;

  renderSkeleton();

  fetchData().then(data => {
    currentData = data;
    renderTable();
    startLiveUpdates();
  });

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      renderTable();
    });
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      sortField = e.target.value;
      renderTable();
    });
  }
}

async function fetchData() {
  try {
    // Fetch tokens and positions in parallel
    const [tokensRes, positionsRes] = await Promise.all([
      fetch('/api/v1/tokens').catch(() => null),
      fetch('/api/v1/positions').catch(() => null),
    ]);

    let tokens = [];
    let positions = [];

    if (tokensRes && tokensRes.ok) {
      const json = await tokensRes.json();
      tokens = json.tokens || [];
    }

    if (positionsRes && positionsRes.ok) {
      const json = await positionsRes.json();
      positions = json.positions || [];
    }

    if (tokens.length === 0) return [];

    // Merge tokens with their position data
    return tokens.map(t => {
      const mint = t.mint || t.id;
      const pos = positions.find(p => p.tokenMint === mint || p.id === mint) || {};

      return {
        mint,
        token: t.token || mint?.slice(0, 8) || 'UNKNOWN',
        underlying: t.underlying || t.linkedTo || '—',
        side: (t.side || pos.side || 'long').toLowerCase(),
        leverage: t.leverage || pos.leverage || 100,
        entry: pos.entry || 0,
        sizeUsd: pos.sizeUsd || 0,
        collateralUsd: pos.collateralUsd || 0,
        deployedSol: pos.deployedSol || 0,
        pnl: pos.pnl || 0,
        market: t.perpsMarket || pos.market || t.underlying || '—',
        status: t.status || 'active',
        lastAction: pos.lastAction || '—',
        lastActionAt: pos.lastActionAt || 0,
      };
    });
  } catch {
    return [];
  }
}

function renderSkeleton() {
  const tbody = document.getElementById('dashboard-body');
  if (!tbody) return;

  const widths = [90, 60, 70, 55, 70, 70, 65];
  const rows = Array.from({ length: 4 }, () => `
    <tr class="skeleton-row">
      ${widths.map(w => `
        <td><span class="skeleton-bar" style="width:${w}px"></span></td>
      `).join('')}
    </tr>
  `).join('');

  tbody.innerHTML = rows;
}

function filterAndSort(data) {
  let filtered = data;

  if (searchQuery) {
    filtered = filtered.filter(d =>
      d.token.toLowerCase().includes(searchQuery) ||
      d.underlying.toLowerCase().includes(searchQuery) ||
      d.mint.toLowerCase().includes(searchQuery)
    );
  }

  filtered.sort((a, b) => {
    const aVal = a[sortField] ?? 0;
    const bVal = b[sortField] ?? 0;
    return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
  });

  return filtered;
}

function renderTable() {
  const tbody = document.getElementById('dashboard-body');
  if (!tbody) return;

  const data = filterAndSort(currentData);

  if (data.length === 0 && searchQuery) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="dashboard-empty">
            <div class="dashboard-empty-icon">--</div>
            <div class="dashboard-empty-title">No tokens found</div>
            <div class="dashboard-empty-desc">
              No tokens match "${searchQuery}".
            </div>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  if (data.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center;padding:60px 20px;">
          <div style="font-family:var(--font-mono);font-size:0.85rem;color:var(--text-tertiary);margin-bottom:8px;">No derivatives yet</div>
          <div style="font-size:0.8rem;color:var(--text-tertiary);margin-bottom:20px;">Be the first to launch a Fission derivative.</div>
          <a href="#launch" class="btn btn-primary btn-sm">LAUNCH</a>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = data.map(row => {
    const isLong = row.side === 'long';
    const dirArrow = isLong ? '▲' : '▼';
    const dirColor = isLong ? 'var(--green, #00ff88)' : 'var(--red, #ff3366)';
    const dirText = isLong ? 'LONG' : 'SHORT';
    const pnlColor = row.pnl >= 0 ? 'var(--green, #00ff88)' : 'var(--red, #ff3366)';
    const pnlSign = row.pnl >= 0 ? '+' : '';

    return `
    <tr class="dashboard-row" data-token="${row.mint}" style="cursor:pointer;">
      <td>
        <span class="dashboard-live-dot"></span>
        <span class="token-name">${row.token}</span>
      </td>
      <td class="token-linked">${row.underlying}</td>
      <td style="color:${dirColor};font-family:var(--font-mono);font-weight:700;">
        ${dirArrow} ${dirText}
      </td>
      <td style="font-family:var(--font-mono);color:var(--accent);">${row.leverage}x</td>
      <td style="font-family:var(--font-mono);">${row.entry > 0 ? '$' + formatNumber(row.entry) : '—'}</td>
      <td style="color:${pnlColor};font-family:var(--font-mono);">
        ${row.pnl !== 0 ? pnlSign + formatCurrency(row.pnl) : '—'}
      </td>
      <td style="font-family:var(--font-mono);">${row.sizeUsd > 0 ? formatCurrency(row.sizeUsd) : '—'}</td>
    </tr>`;
  }).join('');

  // Attach click handlers
  tbody.querySelectorAll('.dashboard-row').forEach(row => {
    row.addEventListener('click', () => {
      const mint = row.getAttribute('data-token');
      const tokenData = currentData.find(d => d.mint === mint);
      if (tokenData) openTokenModal(tokenData);
    });
  });
}

// ---------------------------------------------------------------------------
// Token Detail Modal
// ---------------------------------------------------------------------------
function openTokenModal(token) {
  const modal = document.getElementById('token-modal');
  if (!modal) return;

  const isLong = token.side === 'long';

  // Title
  document.getElementById('modal-title').textContent = token.token;

  // Direction banner
  const banner = document.getElementById('modal-direction-banner');
  if (banner) {
    banner.style.borderColor = isLong ? 'var(--green, #00ff88)' : 'var(--red, #ff3366)';
  }

  const dirArrow = document.getElementById('modal-direction-arrow');
  if (dirArrow) {
    dirArrow.textContent = isLong ? '▲' : '▼';
    dirArrow.style.color = isLong ? 'var(--green, #00ff88)' : 'var(--red, #ff3366)';
  }

  const dirText = document.getElementById('modal-direction-text');
  if (dirText) {
    dirText.textContent = isLong ? 'LONG' : 'SHORT';
    dirText.style.color = isLong ? 'var(--green, #00ff88)' : 'var(--red, #ff3366)';
  }

  const marketText = document.getElementById('modal-market-text');
  if (marketText) marketText.textContent = `${token.market}-PERP`;

  const leverageText = document.getElementById('modal-leverage-text');
  if (leverageText) leverageText.textContent = `${token.leverage}x`;

  // Stats
  const entryEl = document.getElementById('modal-entry');
  if (entryEl) entryEl.textContent = token.entry > 0 ? `$${formatNumber(token.entry)}` : 'Awaiting fill';

  const sizeEl = document.getElementById('modal-size');
  if (sizeEl) sizeEl.textContent = token.sizeUsd > 0 ? formatCurrency(token.sizeUsd) : 'No position';

  const collateralEl = document.getElementById('modal-collateral');
  if (collateralEl) collateralEl.textContent = token.collateralUsd > 0 ? formatCurrency(token.collateralUsd) : '—';

  const pnlEl = document.getElementById('modal-pnl');
  if (pnlEl) {
    const sign = token.pnl >= 0 ? '+' : '';
    pnlEl.textContent = token.pnl !== 0 ? `${sign}${formatCurrency(token.pnl)}` : '—';
    pnlEl.style.color = token.pnl >= 0 ? 'var(--green, #00ff88)' : 'var(--red, #ff3366)';
  }

  const deployedEl = document.getElementById('modal-deployed');
  if (deployedEl) deployedEl.textContent = token.deployedSol > 0 ? `${token.deployedSol.toFixed(4)} SOL` : '—';

  const statusEl = document.getElementById('modal-engine-text');
  if (statusEl) {
    statusEl.textContent = token.status === 'active' ? 'Active' : token.status;
    statusEl.style.color = token.status === 'active' ? 'var(--green, #00ff88)' : 'var(--red, #ff3366)';
  }

  // Mint address
  const mintEl = document.getElementById('modal-mint');
  if (mintEl) mintEl.textContent = token.mint;

  // Highlight active market
  const marketsEl = document.getElementById('modal-markets');
  if (marketsEl) {
    marketsEl.querySelectorAll('span').forEach(span => {
      const isActive = span.textContent.startsWith(token.market);
      span.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
      span.style.color = isActive ? 'var(--accent)' : 'var(--text-muted)';
    });
  }

  // Show modal
  modal.removeAttribute('hidden');
  requestAnimationFrame(() => {
    modal.classList.add('active');
  });
}

function closeTokenModal() {
  const modal = document.getElementById('token-modal');
  if (!modal) return;

  modal.classList.remove('active');
  setTimeout(() => {
    modal.setAttribute('hidden', '');
  }, 250);
}

// Init modal event listeners
export function initModal() {
  const modal = document.getElementById('token-modal');
  const closeBtn = document.getElementById('modal-close');

  if (closeBtn) {
    closeBtn.addEventListener('click', closeTokenModal);
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeTokenModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTokenModal();
  });
}

function startLiveUpdates() {
  // Poll API every 30s for fresh position data
  updateInterval = setInterval(async () => {
    try {
      const newData = await fetchData();
      if (newData.length > 0) {
        currentData = newData;
        renderTable();
      }
    } catch {
      // Silently continue
    }
  }, 30_000);
}
