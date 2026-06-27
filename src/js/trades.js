/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Trade History
   Fetches on-chain perp trade history and renders it.
   ═══════════════════════════════════════════════════════════ */

export function initTradeHistory() {
  const tbody = document.getElementById('trade-history-body');
  if (!tbody) return;

  loadTrades(tbody);
  // Refresh every 30s
  setInterval(() => loadTrades(tbody), 30_000);
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
