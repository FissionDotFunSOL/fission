/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Trade History
   Fetches on-chain perp trade history and renders it.
   ═══════════════════════════════════════════════════════════ */

export function initTradeHistory() {
  const tbody = document.getElementById('trade-history-body');
  const posGrid = document.getElementById('open-positions-grid');

  if (tbody) {
    loadTrades(tbody);
    setInterval(() => loadTrades(tbody), 30_000);
  }

  if (posGrid) {
    loadPositions(posGrid);
    setInterval(() => loadPositions(posGrid), 10_000);
  }
}

async function loadPositions(grid) {
  try {
    const resp = await fetch('/api/v1/positions/live');
    if (!resp.ok) throw new Error('API error');
    const { positions } = await resp.json();

    if (!positions || positions.length === 0) {
      grid.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.8rem;border:1px solid rgba(255,255,255,0.06);border-radius:12px;">No open positions</div>';
      return;
    }

    grid.innerHTML = positions.map(p => {
      const pnl = p.unrealisedPnl || 0;
      const pnlBefore = p.pnlBeforeFees || 0;
      const pnlColor = pnl >= 0 ? '#4ade80' : '#f87171';
      const pnlSign = pnl >= 0 ? '+' : '';
      const pnlPct = p.collateralUsd > 0 ? (pnl / p.collateralUsd * 100).toFixed(2) : '0.00';
      const pnlPctColor = parseFloat(pnlPct) >= 0 ? '#4ade80' : '#f87171';
      const borderGlow = pnl >= 0 ? 'rgba(0,255,170,0.2)' : 'rgba(255,80,80,0.2)';

      return `<div style="
        background:rgba(255,255,255,0.02);
        border:1px solid ${borderGlow};
        border-radius:12px;
        padding:20px;
        font-family:var(--font-mono);
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div>
            <span style="font-size:1rem;font-weight:700;color:var(--text-primary);">${p.market}</span>
            <span style="font-size:0.65rem;color:${p.side === 'long' ? '#4ade80' : '#f87171'};text-transform:uppercase;margin-left:6px;padding:2px 6px;border-radius:4px;background:${p.side === 'long' ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)'};">${p.side} ${p.leverage}x</span>
          </div>
          <div style="text-align:right;">
            <div style="font-size:1.1rem;font-weight:700;color:${pnlColor};">${pnlSign}$${Math.abs(pnl).toFixed(2)}</div>
            <div style="font-size:0.65rem;color:${pnlPctColor};">${pnlPct}%</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:0.7rem;">
          <div>
            <div style="color:var(--text-muted);font-size:0.6rem;margin-bottom:2px;">SIZE</div>
            <div style="color:var(--text-primary);">$${p.sizeUsd.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
          </div>
          <div>
            <div style="color:var(--text-muted);font-size:0.6rem;margin-bottom:2px;">COLLATERAL</div>
            <div style="color:var(--text-primary);">$${p.collateralUsd.toFixed(2)}</div>
          </div>
          <div>
            <div style="color:var(--text-muted);font-size:0.6rem;margin-bottom:2px;">VALUE</div>
            <div style="color:var(--text-primary);">$${(p.value || p.collateralUsd).toFixed(2)}</div>
          </div>
          <div>
            <div style="color:var(--text-muted);font-size:0.6rem;margin-bottom:2px;">ENTRY</div>
            <div style="color:var(--text-primary);">$${p.entryPrice.toFixed(2)}</div>
          </div>
          <div>
            <div style="color:var(--text-muted);font-size:0.6rem;margin-bottom:2px;">MARK</div>
            <div style="color:var(--text-primary);">$${p.currentPrice.toFixed(2)}</div>
          </div>
          <div>
            <div style="color:var(--text-muted);font-size:0.6rem;margin-bottom:2px;">LIQ. PRICE</div>
            <div style="color:#f87171;">$${(p.liquidationPrice || 0).toFixed(2)}</div>
          </div>
        </div>
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04);display:flex;justify-content:space-between;font-size:0.6rem;color:var(--text-muted);">
          <span>PnL before fees: <span style="color:${pnlBefore >= 0 ? '#4ade80' : '#f87171'};">${pnlBefore >= 0 ? '+' : ''}$${pnlBefore.toFixed(2)}</span></span>
          <span>Fees: $${(p.totalFees || 0).toFixed(2)}</span>
        </div>
      </div>`;
    }).join('');

  } catch (err) {
    grid.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.8rem;">Failed to load positions</div>';
  }
}

async function loadTrades(tbody) {
  try {
    const resp = await fetch('/api/v1/trades');
    if (!resp.ok) throw new Error('API error');
    const { trades } = await resp.json();

    if (!trades || trades.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--text-muted);">No trades yet</td></tr>';
      return;
    }

    tbody.innerHTML = trades.map(t => {
      const isIncrease = t.action.includes('Increase');
      const actionColor = isIncrease ? '#4ade80' : '#f87171';
      const actionIcon = isIncrease ? '+' : '-';

      const deposit = t.depositWithdraw || 0;
      const depositStr = (deposit >= 0 ? '+' : '') + deposit.toFixed(2);
      const depositColor = deposit >= 0 ? '#4ade80' : '#f87171';

      const pnlStr = t.pnl != null ? (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) : '-';
      const pnlColor = t.pnl > 0 ? '#4ade80' : t.pnl < 0 ? '#f87171' : 'var(--text-muted)';

      const feeStr = t.fee ? t.fee.toFixed(4) : '-';

      // Time formatting
      let timeStr = '-';
      if (t.time) {
        const d = new Date(t.time);
        const now = Date.now();
        const diffMin = Math.round((now - d.getTime()) / 60000);
        if (diffMin < 1) timeStr = 'just now';
        else if (diffMin < 60) timeStr = diffMin + 'm ago';
        else if (diffMin < 1440) timeStr = Math.round(diffMin / 60) + 'h ago';
        else timeStr = Math.round(diffMin / 1440) + 'd ago';
      }

      const txLink = t.signature
        ? `<a href="https://solscan.io/tx/${t.signature}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:0.65rem;">view</a>`
        : '-';

      return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);transition:background 0.2s;" onmouseover="this.style.background='rgba(0,255,170,0.03)'" onmouseout="this.style.background='transparent'">
        <td style="padding:10px 8px;color:var(--text-primary);">SOL</td>
        <td style="padding:10px 8px;color:${actionColor};">${t.action}</td>
        <td style="padding:10px 8px;text-align:right;color:${depositColor};">${depositStr} SOL</td>
        <td style="padding:10px 8px;text-align:right;color:${pnlColor};">${pnlStr !== '-' ? pnlStr + ' SOL' : '-'}</td>
        <td style="padding:10px 8px;text-align:right;color:var(--text-muted);">${feeStr}</td>
        <td style="padding:10px 8px;text-align:right;color:var(--text-muted);">${timeStr}</td>
        <td style="padding:10px 8px;text-align:center;">${txLink}</td>
      </tr>`;
    }).join('');

  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--text-muted);">Failed to load trades</td></tr>';
  }
}
