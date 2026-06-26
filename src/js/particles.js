/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Particle Canvas
   Ambient particles with mouse repulsion and
   connected lines between nearby particles.
   ═══════════════════════════════════════════════════════════ */

export function initParticles() {
  const canvas = document.getElementById('particle-canvas');
  if (canvas) canvas.style.display = 'none';
  return;
}

  const ctx = canvas.getContext('2d');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let width, height;
  let particles = [];
  let mouse = { x: -9999, y: -9999 };
  let animationId;

  const CONFIG = {
    count: prefersReducedMotion ? 20 : 60,
    maxSpeed: prefersReducedMotion ? 0.1 : 0.25,
    connectionDistance: 120,
    mouseRepulsionRadius: 100,
    mouseRepulsionForce: 0.06,
    colors: [
      'rgba(212, 162, 78, ',    // accent gold
      'rgba(160, 122, 56, ',    // accent dim
      'rgba(232, 196, 104, ',   // accent bright
    ],
    colorWeights: [0.6, 0.25, 0.15],
  };

  function pickColor() {
    const r = Math.random();
    if (r < CONFIG.colorWeights[0]) return CONFIG.colors[0];
    if (r < CONFIG.colorWeights[0] + CONFIG.colorWeights[1]) return CONFIG.colors[1];
    return CONFIG.colors[2];
  }

  class Particle {
    constructor() {
      this.reset();
    }

    reset() {
      this.x = Math.random() * width;
      this.y = Math.random() * height;
      this.vx = (Math.random() - 0.5) * CONFIG.maxSpeed;
      this.vy = (Math.random() - 0.5) * CONFIG.maxSpeed;
      this.radius = Math.random() * 1.8 + 0.5;
      this.baseAlpha = Math.random() * 0.5 + 0.2;
      this.alpha = this.baseAlpha;
      this.colorBase = pickColor();
      this.pulseOffset = Math.random() * Math.PI * 2;
      this.pulseSpeed = Math.random() * 0.01 + 0.005;
    }

    update(time) {
      // Mouse repulsion
      const dx = this.x - mouse.x;
      const dy = this.y - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < CONFIG.mouseRepulsionRadius && dist > 0) {
        const force = (CONFIG.mouseRepulsionRadius - dist) / CONFIG.mouseRepulsionRadius;
        this.vx += (dx / dist) * force * CONFIG.mouseRepulsionForce;
        this.vy += (dy / dist) * force * CONFIG.mouseRepulsionForce;
      }

      // Dampen
      this.vx *= 0.99;
      this.vy *= 0.99;

      // Move
      this.x += this.vx;
      this.y += this.vy;

      // Wrap
      if (this.x < -10) this.x = width + 10;
      if (this.x > width + 10) this.x = -10;
      if (this.y < -10) this.y = height + 10;
      if (this.y > height + 10) this.y = -10;

      // Pulse alpha
      this.alpha = this.baseAlpha + Math.sin(time * this.pulseSpeed + this.pulseOffset) * 0.15;
    }

    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = this.colorBase + this.alpha + ')';
      ctx.fill();
    }
  }

  function resize() {
    width = canvas.width = canvas.offsetWidth;
    height = canvas.height = canvas.offsetHeight;
  }

  function createParticles() {
    particles = [];
    for (let i = 0; i < CONFIG.count; i++) {
      particles.push(new Particle());
    }
  }

  function drawConnections() {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < CONFIG.connectionDistance) {
          const alpha = (1 - dist / CONFIG.connectionDistance) * 0.15;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(212, 162, 78, ${alpha})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
  }

  function animate(time) {
    ctx.clearRect(0, 0, width, height);

    particles.forEach(p => {
      p.update(time);
      p.draw();
    });

    drawConnections();

    animationId = requestAnimationFrame(animate);
  }

  // Events
  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    mouse.x = e.clientX - rect.left;
    mouse.y = e.clientY - rect.top;
  }

  function onMouseLeave() {
    mouse.x = -9999;
    mouse.y = -9999;
  }

  function onTouchMove(e) {
    if (e.touches.length > 0) {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.touches[0].clientX - rect.left;
      mouse.y = e.touches[0].clientY - rect.top;
    }
  }

  // Init
  resize();
  createParticles();

  // Make canvas respond to pointer events for particle interaction
  // but keep it visually behind content
  canvas.style.pointerEvents = 'none';
  const heroSection = canvas.closest('.hero');
  if (heroSection) {
    heroSection.addEventListener('mousemove', onMouseMove);
    heroSection.addEventListener('mouseleave', onMouseLeave);
    heroSection.addEventListener('touchmove', onTouchMove, { passive: true });
  }

  window.addEventListener('resize', () => {
    resize();
    createParticles();
  });

  if (!prefersReducedMotion) {
    animate(0);
  } else {
    // Draw once for static view
    particles.forEach(p => p.draw());
    drawConnections();
  }

  return () => {
    if (animationId) cancelAnimationFrame(animationId);
  };
}
