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
    const response = await fetch('/api/v1/stats');
    if (!response.ok) throw new Error('API unavailable');
    const json = await response.json();

    if (json.stats) {
      // Map API stats to our counter format (no prefix — HTML handles it)
      return [
        { key: 'derivatives', value: json.stats.activeTokens || json.stats.totalTokens || 0 },
        { key: 'fees',        value: json.stats.totalFeesClaimed || 0 },
        { key: 'pnl',         value: Math.abs(json.stats.totalPnl || 0) },
        { key: 'buybacks',    value: json.stats.totalBuybackSol || 0 },
      ];
    }

    // API returned but no stats — use fallback zeros
    return [...STATS_DATA];
  } catch {
    // API unavailable — use fallback zeros
    return [...STATS_DATA];
  }
}

function applyStatsToCounters(counters, stats) {
  counters.forEach(el => {
    const key = el.getAttribute('data-counter');
    const stat = stats.find(s => s.key === key);
    if (stat) {
      el.textContent = formatNumber(stat.value);
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
    const currentValue = Math.round(easedProgress * target);

    el.textContent = formatNumber(currentValue);

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      // Final value with pop
      el.textContent = formatNumber(target);
      el.classList.add('number-pop');
      setTimeout(() => el.classList.remove('number-pop'), 300);
    }
  }

  requestAnimationFrame(update);
}
