/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL
   Main entry point
   ═══════════════════════════════════════════════════════════ */

// Styles are loaded via <link> tags in index.html

// Modules
import { initParticles } from './js/particles.js';
import { initTypewriter } from './js/typewriter.js';
import { initScroll } from './js/scroll.js';
import { initDashboard, initModal, initActivityFeed } from './js/dashboard.js';
import { initLauncher } from './js/launcher.js';
import { initStats } from './js/stats.js';
import { initToast } from './js/toast.js';
import { initTicker } from './js/ticker.js';
import { initTradeHistory } from './js/trades.js';

// Boot
document.addEventListener('DOMContentLoaded', () => {
  initTicker();
  initParticles();
  initTypewriter();
  initScroll();
  initDashboard();
  initModal();
  initLauncher();
  initStats();
  initActivityFeed();
  initToast();
  initTradeHistory();
});
