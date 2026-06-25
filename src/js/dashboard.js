/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Live Dashboard
   Fetches from /api/v1/tokens with fallback to mock data.
   Supports search, sort, loading skeleton, empty state,
   and simulated live updates.
   ═══════════════════════════════════════════════════════════ */

import { MOCK_DASHBOARD_DATA, formatNumber, formatCurrency, jitterValue } from './data.js';

let currentData = [];
let sortField = 'volume24h';
let sortDir = 'desc';
let searchQuery = '';
let updateInterval;
let isUsingMockData = false;

export function initDashboard() {
  const tbody = document.getElementById('dashboard-body');
  const searchInput = document.getElementById('dashboard-search');
  const sortSelect = document.getElementById('dashboard-sort');

  if (!tbody) return;

  // Show loading skeleton
  renderSkeleton();

  // Fetch data
  fetchData().then(data => {
    currentData = data;
    renderTable();
    startLiveUpdates();
  });

  // Search
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      renderTable();
    });
  }

  // Sort via select
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      sortField = e.target.value;
      renderTable();
    });
  }

  // Sort via column headers
  document.querySelectorAll('[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.getAttribute('data-sort');
      if (sortField === field) {
        sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        sortField = field;
        sortDir = 'desc';
      }

      // Update UI
      document.querySelectorAll('[data-sort]').forEach(el => {
        el.classList.remove('sort-active', 'sort-desc');
      });
      th.classList.add('sort-active');
      if (sortDir === 'desc') th.classList.add('sort-desc');

      renderTable();
    });
  });
}

async function fetchData() {
  try {
    const response = await fetch('/api/v1/tokens');
    if (!response.ok) throw new Error('API unavailable');
    const json = await response.json();

    // API returns { tokens: [...] }, transform to dashboard format
    if (json.tokens && json.tokens.length > 0) {
      isUsingMockData = false;
      return json.tokens.map(t => ({
        token: t.token || t.mint || t.id || 'UNKNOWN',
        linkedTo: t.linkedTo || t.underlying || '—',
        volume24h: t.volume24h || 0,
        fees24h: t.fees24h || t.feesClaimed || 0,
        positionSize: t.positionSize || 0,
        pnl: t.pnl || 0,
        pnlPercent: t.pnlPercent || 0,
        buybacks: t.buybacks || t.totalBuyback || 0,
        status: t.status || 'active',
      }));
    }

    // No tokens registered yet — show empty state
    isUsingMockData = true;
    return [];
  } catch {
    // API unavailable — show empty state
    isUsingMockData = true;
    return [];
  }
}

function renderSkeleton() {
  const tbody = document.getElementById('dashboard-body');
  if (!tbody) return;

  const widths = [90, 60, 80, 70, 80, 75, 70];
  const rows = Array.from({ length: 5 }, () => `
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
      d.linkedTo.toLowerCase().includes(searchQuery)
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

  // Empty state
  if (data.length === 0 && searchQuery) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="dashboard-empty">
            <div class="dashboard-empty-icon">--</div>
            <div class="dashboard-empty-title">No tokens found</div>
            <div class="dashboard-empty-desc">
              No tokens match "${searchQuery}". Try a different search term.
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
        <td colspan="7">
          <div class="dashboard-empty">
            <div class="dashboard-empty-icon">0</div>
            <div class="dashboard-empty-title">No derivatives yet</div>
            <div class="dashboard-empty-desc">
              Be the first to launch a Fission derivative. Creator fees fuel the engine.
            </div>
            <a href="#launch" class="btn btn-primary btn-sm">LAUNCH</a>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = data.map(row => `
    <tr class="dashboard-row" data-token="${row.token}">
      <td>
        <span class="dashboard-live-dot"></span>
        <span class="token-name">${row.token}</span>
      </td>
      <td class="token-linked">${row.linkedTo}</td>
      <td>${formatCurrency(row.volume24h)}</td>
      <td>${formatCurrency(row.fees24h)}</td>
      <td>${formatCurrency(row.positionSize)}</td>
      <td class="${row.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">
        ${row.pnl >= 0 ? '+' : ''}${formatCurrency(row.pnl)}
        <span style="opacity:0.6; font-size:0.7rem; margin-left:4px">
          (${row.pnlPercent >= 0 ? '+' : ''}${row.pnlPercent.toFixed(1)}%)
        </span>
      </td>
      <td class="text-accent">${formatCurrency(row.buybacks)}</td>
    </tr>
  `).join('');

  // Attach click handlers to rows
  tbody.querySelectorAll('.dashboard-row').forEach(row => {
    row.addEventListener('click', () => {
      const tokenName = row.getAttribute('data-token');
      const tokenData = currentData.find(d => d.token === tokenName);
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

  document.getElementById('modal-title').textContent = token.token;
  document.getElementById('modal-underlying').textContent = token.linkedTo;
  document.getElementById('modal-volume').textContent = formatCurrency(token.volume24h);
  document.getElementById('modal-fees').textContent = formatCurrency(token.fees24h);
  document.getElementById('modal-position').textContent = formatCurrency(token.positionSize);
  document.getElementById('modal-buybacks').textContent = formatCurrency(token.buybacks);

  const pnlEl = document.getElementById('modal-pnl');
  pnlEl.textContent = `${token.pnl >= 0 ? '+' : ''}${formatCurrency(token.pnl)} (${token.pnlPercent >= 0 ? '+' : ''}${token.pnlPercent.toFixed(1)}%)`;
  pnlEl.style.color = token.pnl >= 0 ? 'var(--green)' : 'var(--red)';

  // Show modal
  modal.removeAttribute('hidden');
  requestAnimationFrame(() => {
    modal.classList.add('active');
  });

  // Fetch engine status
  fetchEngineStatus();
}

function closeTokenModal() {
  const modal = document.getElementById('token-modal');
  if (!modal) return;

  modal.classList.remove('active');
  setTimeout(() => {
    modal.setAttribute('hidden', '');
  }, 250);
}

async function fetchEngineStatus() {
  const el = document.getElementById('modal-engine-text');
  if (!el) return;

  try {
    const res = await fetch('/api/v1/status');
    if (!res.ok) throw new Error('API unavailable');
    const data = await res.json();

    const workers = data.engine?.workers || {};
    const names = Object.keys(workers);
    const running = names.filter(n => workers[n].status === 'idle' || workers[n].status === 'running');
    const errored = names.filter(n => workers[n].status === 'error');

    if (errored.length > 0) {
      el.textContent = `${running.length}/${names.length} workers active, ${errored.length} with errors`;
    } else {
      el.textContent = `${running.length}/${names.length} workers running autonomously`;
    }
  } catch {
    el.textContent = 'Engine status unavailable';
  }
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
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  // Only jitter mock data for demo effect
  if (!isUsingMockData) {
    // For real data, poll the API periodically
    updateInterval = setInterval(async () => {
      try {
        const newData = await fetchData();
        currentData = newData;
        renderTable();
      } catch {
        // Silently continue with existing data
      }
    }, 30_000); // Poll every 30s for real data
    return;
  }

  // Mock data: jitter for visual effect
  updateInterval = setInterval(() => {
    currentData = currentData.map(row => ({
      ...row,
      volume24h: jitterValue(row.volume24h, 0.005),
      fees24h: jitterValue(row.fees24h, 0.005),
      positionSize: jitterValue(row.positionSize, 0.003),
      pnl: jitterValue(row.pnl, 0.01),
      pnlPercent: jitterValue(row.pnlPercent, 0.01),
      buybacks: jitterValue(row.buybacks, 0.004),
    }));
    renderTable();
  }, 3000);
}

