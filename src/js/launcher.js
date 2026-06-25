/* ═══════════════════════════════════════════════════════════
   FISSION PROTOCOL — Launch Wizard
   Multi-step flow: Pick Token > Name > Setup > Verify & Register
   ═══════════════════════════════════════════════════════════ */

import { POPULAR_TOKENS, PROTOCOL_WALLET } from './data.js';
import { showToast } from './toast.js';

let currentStep = 0;
let selectedToken = null;
let derivativeName = '';
let selectedDirection = 'long';

export function initLauncher() {
  const wizard = document.querySelector('.launch-wizard');
  if (!wizard) return;

  renderPopularTokens();
  setupNavigation();
  setupCopyButtons();
  setupTokenSearch();
  setupNameInput();
  setupProtocolWallet();
  setupDirectionSelector();
  updateStepUI();
}

function setupProtocolWallet() {
  const walletEl = document.getElementById('protocol-wallet-address');
  if (walletEl) walletEl.textContent = PROTOCOL_WALLET;
  const footerWallet = document.getElementById('footer-wallet-copy');
  if (footerWallet) {
    footerWallet.textContent = `${PROTOCOL_WALLET.slice(0, 8)}...${PROTOCOL_WALLET.slice(-8)}`;
    footerWallet.addEventListener('click', () => {
      navigator.clipboard.writeText(PROTOCOL_WALLET).then(() => {
        showToast('Wallet address copied', 'success', 2000);
      });
    });
  }
}

function renderPopularTokens() {
  const grid = document.getElementById('popular-tokens-grid');
  if (!grid) return;

  grid.innerHTML = POPULAR_TOKENS.map(t => `
    <div class="popular-token-card glass-card" data-symbol="${t.symbol}">
      <div class="token-symbol">${t.symbol}</div>
      <div class="token-label">${t.name}</div>
    </div>
  `).join('');

  grid.querySelectorAll('.popular-token-card').forEach(card => {
    card.addEventListener('click', () => {
      grid.querySelectorAll('.popular-token-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedToken = card.getAttribute('data-symbol');

      const nameInput = document.getElementById('derivative-name');
      if (nameInput && !nameInput.value) {
        const prefixes = ['MEGA', 'ULTRA', 'TURBO', 'NITRO', 'FLUX', 'FISSION'];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        nameInput.value = `${prefix}_${selectedToken}`;
        derivativeName = nameInput.value;
      }
    });
  });
}

function setupTokenSearch() {
  const searchInput = document.getElementById('token-search');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    document.querySelectorAll('.popular-token-card').forEach(card => {
      const symbol = card.getAttribute('data-symbol').toLowerCase();
      const name = card.querySelector('.token-label').textContent.toLowerCase();
      card.style.display = (symbol.includes(query) || name.includes(query)) ? '' : 'none';
    });
  });
}

function setupNameInput() {
  const nameInput = document.getElementById('derivative-name');
  if (!nameInput) return;

  nameInput.addEventListener('input', (e) => {
    derivativeName = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    e.target.value = derivativeName;
  });
}

function setupNavigation() {
  document.querySelectorAll('[data-wizard-next]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentStep === 0 && !selectedToken) {
        showToast('Select a token to track', 'warning');
        return;
      }
      if (currentStep === 1) {
        const nameInput = document.getElementById('derivative-name');
        if (!nameInput?.value?.trim()) {
          showToast('Enter a derivative name', 'warning');
          return;
        }
        derivativeName = nameInput.value.trim();
      }

      if (currentStep < 3) {
        currentStep++;
        updateStepUI();
      }
    });
  });

  document.querySelectorAll('[data-wizard-prev]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentStep > 0) {
        currentStep--;
        updateStepUI();
      }
    });
  });

  const mintBtn = document.getElementById('mint-verify-btn');
  if (mintBtn) {
    mintBtn.addEventListener('click', () => {
      handleVerifyAndRegister();
    });
  }
}

async function handleVerifyAndRegister() {
  const mintInput = document.getElementById('mint-address-input');
  const terminal = document.getElementById('verify-terminal');
  const mintBtn = document.getElementById('mint-verify-btn');
  const address = mintInput?.value?.trim();

  if (!address || address.length < 32 || address.length > 50) {
    terminalWrite(terminal, '> error: enter a valid Solana mint address (32-44 chars)', 'var(--red)');
    return;
  }

  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
    terminalWrite(terminal, '> error: invalid base58 characters', 'var(--red)');
    return;
  }

  mintBtn.textContent = 'VERIFYING...';
  mintBtn.disabled = true;
  mintInput.disabled = true;

  if (terminal) terminal.innerHTML = '';

  terminalAppend(terminal, `> verifying ${address.slice(0, 8)}...${address.slice(-8)}`, 'var(--text)');

  try {
    terminalAppend(terminal, '  calling /api/v1/tokens/register', 'var(--text-muted)');

    const response = await fetch('/api/v1/tokens/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mint: address,
        underlying: selectedToken || null,
        side: selectedDirection,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 409) {
        terminalAppend(terminal, '  token already registered', 'var(--yellow)');
        showToast('Token is already registered', 'info');
        resetMintButton(mintBtn, mintInput, 'REGISTERED', 'var(--yellow)');
        return;
      }

      if (response.status === 400) {
        const reason = data.reason || data.error || 'Verification failed';
        terminalAppend(terminal, `  verification failed: ${reason}`, 'var(--red)');
        showToast(`Verification failed: ${reason}`, 'error');
        resetMintButton(mintBtn, mintInput, 'VERIFY', null, true);
        return;
      }

      throw new Error(data.error || `HTTP ${response.status}`);
    }

    const token = data.token;
    terminalAppend(terminal, '  sharing config verified', 'var(--green)');
    if (token.sharingConfigPDA) {
      terminalAppend(terminal, `  PDA: ${token.sharingConfigPDA.slice(0, 16)}...`, 'var(--green)');
    }
    terminalAppend(terminal, '  100% allocated to protocol', 'var(--green)');
    terminalAppend(terminal, '  admin revoked (locked)', 'var(--green)');
    terminalAppend(terminal, '', '');
    terminalAppend(terminal, '  registered — fee distribution will begin automatically', 'var(--accent)');

    showToast('Token registered. Fee distribution begins next cycle.', 'success');

    mintBtn.textContent = 'REGISTERED';
    mintBtn.disabled = true;
    mintBtn.style.borderColor = 'var(--green)';
    mintBtn.style.color = 'var(--green)';

  } catch (err) {
    terminalAppend(terminal, `  error: ${err.message}`, 'var(--red)');

    if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
      terminalAppend(terminal, '  backend offline — running demo', 'var(--text-muted)');
      await simulatedVerification(terminal, address);
      showToast('Demo mode: backend not connected', 'info', 6000);

      mintBtn.textContent = 'REGISTERED (DEMO)';
      mintBtn.disabled = true;
      mintBtn.style.borderColor = 'var(--accent)';
      mintBtn.style.color = 'var(--accent)';
    } else {
      showToast(`Registration failed: ${err.message}`, 'error');
      resetMintButton(mintBtn, mintInput, 'VERIFY', null, true);
    }
  }
}

function simulatedVerification(terminal) {
  return new Promise(resolve => {
    const steps = [
      { text: '  deriving fee sharing config PDA...', delay: 600 },
      { text: '  PDA derived', delay: 1200, color: 'var(--green)' },
      { text: '  checking fee allocation...', delay: 1800 },
      { text: '  100% allocated to protocol', delay: 2400, color: 'var(--green)' },
      { text: '  checking admin status...', delay: 3000 },
      { text: '  adminRevoked = true', delay: 3600, color: 'var(--green)' },
      { text: '', delay: 4000 },
      { text: '  registered (demo mode)', delay: 4200, color: 'var(--accent)' },
    ];

    steps.forEach(step => {
      setTimeout(() => {
        terminalAppend(terminal, step.text, step.color || 'var(--text-muted)');
        if (step === steps[steps.length - 1]) resolve();
      }, step.delay);
    });
  });
}

function terminalWrite(terminal, text, color = 'var(--text)') {
  if (!terminal) return;
  terminal.innerHTML = '';
  terminalAppend(terminal, text, color);
}

function terminalAppend(terminal, text, color = 'var(--text-muted)') {
  if (!terminal) return;
  const line = document.createElement('div');
  line.style.color = color;
  line.style.fontFamily = 'var(--font-mono)';
  line.style.fontSize = '0.78rem';
  line.style.lineHeight = '1.6';
  line.textContent = text;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function resetMintButton(btn, input, text, color, reEnable = false) {
  btn.textContent = text;
  if (color) {
    btn.style.borderColor = color;
    btn.style.color = color;
  } else {
    btn.style.borderColor = '';
    btn.style.color = '';
  }
  if (reEnable) {
    btn.disabled = false;
    if (input) input.disabled = false;
  }
}

function setupCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const address = btn.getAttribute('data-copy') || PROTOCOL_WALLET;
      const row = btn.closest('.copy-row');
      const addressEl = row?.querySelector('.copy-address');
      const toCopy = addressEl?.textContent || address;

      navigator.clipboard.writeText(toCopy).then(() => {
        const originalText = btn.textContent;
        btn.textContent = 'COPIED';
        btn.classList.add('copied');
        showToast('Address copied', 'success', 2000);
        setTimeout(() => {
          btn.textContent = originalText;
          btn.classList.remove('copied');
        }, 2000);
      }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = toCopy;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);

        const originalText = btn.textContent;
        btn.textContent = 'COPIED';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = originalText;
          btn.classList.remove('copied');
        }, 2000);
      });
    });
  });
}

function updateStepUI() {
  document.querySelectorAll('.wizard-step-indicator').forEach((ind, i) => {
    ind.classList.remove('active', 'completed');
    if (i === currentStep) ind.classList.add('active');
    if (i < currentStep) ind.classList.add('completed');
  });

  document.querySelectorAll('.wizard-panel').forEach((panel, i) => {
    panel.classList.toggle('active', i === currentStep);
  });
}

function setupDirectionSelector() {
  const longBtn = document.getElementById('dir-long');
  const shortBtn = document.getElementById('dir-short');
  const dirLabel = document.getElementById('selected-direction');

  if (!longBtn || !shortBtn) return;

  longBtn.addEventListener('click', () => {
    selectedDirection = 'long';
    longBtn.classList.add('active');
    longBtn.classList.remove('btn-outline');
    longBtn.classList.add('btn-primary');
    shortBtn.classList.remove('active');
    shortBtn.classList.remove('btn-primary');
    shortBtn.classList.add('btn-outline');
    if (dirLabel) {
      dirLabel.textContent = 'LONG';
      dirLabel.style.color = 'var(--green, #00ff88)';
    }
  });

  shortBtn.addEventListener('click', () => {
    selectedDirection = 'short';
    shortBtn.classList.add('active');
    shortBtn.classList.remove('btn-outline');
    shortBtn.classList.add('btn-primary');
    longBtn.classList.remove('active');
    longBtn.classList.remove('btn-primary');
    longBtn.classList.add('btn-outline');
    if (dirLabel) {
      dirLabel.textContent = 'SHORT';
      dirLabel.style.color = 'var(--red, #ff3366)';
    }
  });
}
