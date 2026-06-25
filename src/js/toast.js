/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Toast Notifications
   ═══════════════════════════════════════════════════════════ */

let _container = null;

const DURATIONS = {
  success: 4000,
  error: 6000,
  info: 4000,
  warning: 5000,
};

function ensureContainer() {
  if (_container) return _container;
  _container = document.createElement('div');
  _container.className = 'toast-container';
  _container.id = 'toast-container';
  document.body.appendChild(_container);
  return _container;
}

export function showToast(message, type = 'info', duration) {
  const container = ensureContainer();
  const ms = duration ?? DURATIONS[type] ?? 4000;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-message">${message}</span>
    <button class="toast-close" aria-label="Dismiss">x</button>
  `;

  toast.querySelector('.toast-close').addEventListener('click', () => {
    dismissToast(toast);
  });

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('toast-enter');
  });

  if (ms > 0) {
    setTimeout(() => dismissToast(toast), ms);
  }

  return toast;
}

function dismissToast(toast) {
  if (toast._dismissed) return;
  toast._dismissed = true;
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => {
    toast.remove();
  });
}

export function initToast() {
  ensureContainer();
}
