/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Typewriter Effect
   Cycles through taglines with typing animation.
   ═══════════════════════════════════════════════════════════ */

const TAGLINES = [
  'Launch a token that moves harder than the asset it tracks',
  'Creator fees fuel perpetual positions automatically',
  'Derivatives backed by real Drift perps on Solana',
  'No vaults. No deposits. Fully autonomous.',
];

export function initTypewriter() {
  const el = document.getElementById('hero-tagline');
  if (!el) return;

  const speed = 35;
  const startDelay = 600;
  const holdDelay = 3000;
  const eraseSpeed = 18;

  el.textContent = '';
  const cursor = document.createElement('span');
  cursor.className = 'cursor cursor-blink';
  cursor.textContent = '';
  el.appendChild(cursor);

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReducedMotion) {
    el.insertBefore(document.createTextNode(TAGLINES[0]), cursor);
    return;
  }

  let lineIndex = 0;

  function typeNextLine() {
    const text = TAGLINES[lineIndex % TAGLINES.length];
    let charIndex = 0;

    function type() {
      if (charIndex < text.length) {
        const char = text.charAt(charIndex);
        const textNode = document.createTextNode(char);
        el.insertBefore(textNode, cursor);
        charIndex++;

        let nextDelay = speed;
        if (char === ' ') nextDelay = speed * 0.4;
        if (char === '.' || char === ',') nextDelay = speed * 3;

        setTimeout(type, nextDelay);
      } else {
        setTimeout(erase, holdDelay);
      }
    }

    function erase() {
      const textNodes = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
      if (textNodes.length > 0) {
        const lastNode = textNodes[textNodes.length - 1];
        if (lastNode.textContent.length > 1) {
          lastNode.textContent = lastNode.textContent.slice(0, -1);
        } else {
          lastNode.remove();
        }
        setTimeout(erase, eraseSpeed);
      } else {
        lineIndex++;
        setTimeout(typeNextLine, 400);
      }
    }

    type();
  }

  setTimeout(typeNextLine, startDelay);
}
