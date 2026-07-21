/* ═══════════════════════════════════════════════════════════
   FILL PROTOCOL — Animated Stats Counters
   Fetches real stats from /api/v1/stats, falls back to zero.
   Uses IntersectionObserver to trigger count-up animation
   when stats section enters the viewport.
   
   Note: Prefixes ($, +$) are rendered in HTML via
   counter-prefix spans — the JS only writes numeric values.
   ═══════════════════════════════════════════════════════════ */

import { STATS_DATA, formatNumber } from './data.js';

export function initStats() {
  const statsSection = document.getElementById('stats');
  if (!statsSection) return;

  const counters = statsSection.querySelectorAll('[data-counter]');
  if (counters.length === 0) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Fetch real stats, with mock fallback
  fetchStats().then(stats => {
    if (prefersReducedMotion) {
      // Show final values immediately
      applyStatsToCounters(counters, stats);
      return;
    }

    let animated = false;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !animated) {
            animated = true;
            animateAllCounters(counters, stats);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.2 }
    );

    observer.observe(statsSection);
  });
}

async function fetchStats() {
  try {
    const statsRes = await fetch('/api/v1/stats');
    const statsJson = statsRes.ok ? await statsRes.json() : {};

    if (statsJson.stats) {
      const s = statsJson.stats;
      const pnl = s.netPerpPnlUsd ?? s.netPerpPnl ?? 0;

      // Color the PnL element after animation
      setTimeout(() => {
        const pnlEl = document.getElementById('pnl-value');
        if (pnlEl) {
          pnlEl.style.color = pnl >= 0 ? 'var(--green, #00ff88)' : 'var(--red, #ff3366)';
        }
      }, 100);

      return [
        { key: 'derivatives',    value: s.activeTokens || s.totalTokens || 0, decimals: 0 },
        { key: 'pnl',            value: pnl, decimals: 2 },
        { key: 'tradingBalance', value: s.tradingBalanceUsd || 0, decimals: 2 },
        { key: 'walletBalance',  value: s.walletBalanceEth || 0, decimals: 4 },
        { key: 'buybackEth',     value: s.totalBuybackEth || 0, decimals: 4 },
        { key: 'buybacks',       value: s.totalBuybacks || 0, decimals: 0 },
        { key: 'refunds',        value: s.refundsEth || 0, decimals: 4 },
      ];
    }

    return [...STATS_DATA];
  } catch {
    return [...STATS_DATA];
  }
}

function applyStatsToCounters(counters, stats) {
  counters.forEach(el => {
    const key = el.getAttribute('data-counter');
    const stat = stats.find(s => s.key === key);
    if (stat) {
      el.textContent = formatNumber(stat.value, stat.decimals || 0);
    }
  });
}

function animateAllCounters(counters, stats) {
  counters.forEach((el, index) => {
    const key = el.getAttribute('data-counter');
    const stat = stats.find(s => s.key === key);
    if (!stat) return;

    // Stagger start
    setTimeout(() => {
      animateCounter(el, stat);
    }, index * 150);
  });
}

function animateCounter(el, stat) {
  const target = stat.value;
  const absTarget = Math.abs(target);
  const prefix = target < 0 ? '-' : '';
  const duration = 2200;
  const startTime = performance.now();

  function easeOutExpo(t) {
    return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
  }

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easedProgress = easeOutExpo(progress);
    const currentValue = stat.decimals
      ? Math.round(easedProgress * absTarget * Math.pow(10, stat.decimals)) / Math.pow(10, stat.decimals)
      : Math.round(easedProgress * absTarget);

    el.textContent = prefix + formatNumber(currentValue, stat.decimals || 0);

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      // Final value with pop
      el.textContent = prefix + formatNumber(absTarget, stat.decimals || 0);
      el.classList.add('number-pop');
      setTimeout(() => el.classList.remove('number-pop'), 300);
    }
  }

  requestAnimationFrame(update);
}
