/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Animated Stats Counters
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
    const [statsRes, buybacksRes] = await Promise.all([
      fetch('/api/v1/stats'),
      fetch('/api/v1/buybacks'),
    ]);

    const statsJson = statsRes.ok ? await statsRes.json() : {};
    const buybacksJson = buybacksRes.ok ? await buybacksRes.json() : {};

    const buybacks = buybacksJson.buybacks || [];
    let totalBurned = 0;
    let totalBurnedSol = 0;
    let buybackCount = 0;

    for (const b of buybacks) {
      totalBurned += b.tokensBurned || 0;
      totalBurnedSol += b.amountSol || 0;
      buybackCount++;
    }

    if (statsJson.stats) {
      return [
        { key: 'derivatives', value: statsJson.stats.activeTokens || statsJson.stats.totalTokens || 0, decimals: 0 },
        { key: 'fees',        value: statsJson.stats.totalFeesClaimed || 0, decimals: 2 },
        { key: 'pnl',         value: Math.abs(statsJson.stats.totalPnl || 0), decimals: 2 },
        { key: 'buybacks',    value: buybackCount || (statsJson.stats.totalBuybacks || 0), decimals: 0 },
        { key: 'totalBurned', value: totalBurned, decimals: 0 },
        { key: 'totalBurnedSol', value: Math.round(totalBurnedSol * 10000) / 10000, decimals: 4 },
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
      ? Math.round(easedProgress * target * Math.pow(10, stat.decimals)) / Math.pow(10, stat.decimals)
      : Math.round(easedProgress * target);

    el.textContent = formatNumber(currentValue, stat.decimals || 0);

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      // Final value with pop
      el.textContent = formatNumber(target, stat.decimals || 0);
      el.classList.add('number-pop');
      setTimeout(() => el.classList.remove('number-pop'), 300);
    }
  }

  requestAnimationFrame(update);
}
