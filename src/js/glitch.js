/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Glitch Effect
   Injects data-text attribute for CSS glitch ::before/::after
   and periodically triggers a stronger glitch burst.
   ═══════════════════════════════════════════════════════════ */

export function initGlitch() {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  const glitchElements = document.querySelectorAll('.glitch');

  glitchElements.forEach(el => {
    // Set data-text from inner text for CSS pseudo-elements
    el.setAttribute('data-text', el.textContent);

    // Occasional burst glitch
    scheduleGlitchBurst(el);
  });
}

function scheduleGlitchBurst(el) {
  const delay = 3000 + Math.random() * 8000;

  setTimeout(() => {
    triggerBurst(el);
    scheduleGlitchBurst(el);
  }, delay);
}

function triggerBurst(el) {
  el.classList.add('glitch-burst');

  // Random inline offset
  const offsetX = (Math.random() - 0.5) * 6;
  el.style.transform = `translate(${offsetX}px, 0)`;

  // Brief skew
  setTimeout(() => {
    el.style.transform = `skewX(${(Math.random() - 0.5) * 4}deg)`;
  }, 50);

  // Reset
  setTimeout(() => {
    el.classList.remove('glitch-burst');
    el.style.transform = '';
  }, 200);
}
