/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Scroll Effects
   IntersectionObserver-based reveal animations, smooth
   scroll for anchor links, active nav tracking, and
   mobile hamburger menu.
   ═══════════════════════════════════════════════════════════ */

export function initScroll() {
  // ── Reveal on scroll ──
  const revealClasses = ['.reveal', '.reveal-left', '.reveal-right', '.reveal-scale'];
  const revealElements = document.querySelectorAll(revealClasses.join(','));

  if (revealElements.length > 0) {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            revealObserver.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.12,
        rootMargin: '0px 0px -40px 0px',
      }
    );

    revealElements.forEach(el => revealObserver.observe(el));
  }

  // ── Smooth scroll for anchor links (offset for fixed header) ──
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', (e) => {
      const targetId = link.getAttribute('href');
      if (targetId === '#') return;

      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();

        // Close mobile menu if open
        closeMobileMenu();

        const headerHeight = document.querySelector('.header')?.offsetHeight || 64;
        const targetPos = target.getBoundingClientRect().top + window.scrollY - headerHeight;

        window.scrollTo({ top: targetPos, behavior: 'smooth' });
      }
    });
  });

  // ── Header scroll effect ──
  const header = document.querySelector('.header');
  if (header) {
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          if (window.scrollY > 60) {
            header.classList.add('scrolled');
          } else {
            header.classList.remove('scrolled');
          }
          ticking = false;
        });
        ticking = true;
      }
    });
  }

  // ── Active nav link tracking ──
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-link');

  if (sections.length > 0 && navLinks.length > 0) {
    const sectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('id');
            navLinks.forEach(link => {
              link.classList.remove('active');
              if (link.getAttribute('href') === `#${id}`) {
                link.classList.add('active');
              }
            });
          }
        });
      },
      {
        threshold: 0.15,
        rootMargin: '-80px 0px -50% 0px',
      }
    );

    sections.forEach(section => sectionObserver.observe(section));
  }

  // ── Mobile hamburger menu ──
  const hamburger = document.getElementById('hamburger');
  const headerNav = document.getElementById('header-nav');

  if (hamburger && headerNav) {
    hamburger.addEventListener('click', () => {
      const isOpen = hamburger.classList.toggle('open');
      headerNav.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', isOpen);
      document.body.style.overflow = isOpen ? 'hidden' : '';
    });

    // Close on nav link click (handled above in smooth scroll)
    // Close on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMobileMenu();
      }
    });
  }
}

function closeMobileMenu() {
  const hamburger = document.getElementById('hamburger');
  const headerNav = document.getElementById('header-nav');
  if (hamburger && headerNav) {
    hamburger.classList.remove('open');
    headerNav.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }
}
