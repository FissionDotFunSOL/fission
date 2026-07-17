/* ═══════════════════════════════════════════════════════════
   FILL PROTOCOL — Launch Wizard
   Multi-step flow: Pick Stock > Name > Setup on Pons > Verify & Register
   ═══════════════════════════════════════════════════════════ */

import { POPULAR_TOKENS, PROTOCOL_WALLET, LAUNCHPADS, STRATEGIES } from './data.js';
import { showToast } from './toast.js';

let currentStep = 0;
let selectedLaunchpad = 'pons';
let selectedToken = null;
let derivativeName = '';
let selectedDirection = 'long';
let selectedLeverage = 50;
let selectedStrategy = 'degen';

const LAST_STEP = 4; // launchpad → stock → name → setup → verify

export function initLauncher() {
  const wizard = document.getElementById('launch-wizard');
  if (!wizard) return;

  renderLaunchpadPicker();
  renderLaunchpadStrip();
  renderSetupInstructions();
  renderPopularTokens();
  setupNavigation();
  setupCopyButtons();
  setupTokenSearch();
  setupNameInput();
  setupProtocolWallet();
  setupDirectionSelector();
  setupLeverageSelector();
  renderStrategySelector();
  updateStepUI();
}

function setupProtocolWallet() {
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

function renderLaunchpadPicker() {
  const grid = document.getElementById('launchpad-grid');
  if (!grid) return;

  grid.innerHTML = LAUNCHPADS.map(lp => {
    const disabled = lp.support === 'coming-soon';
    const badge = lp.support === 'full' ? 'FULL SUPPORT'
      : lp.support === 'partial' ? 'SUPPORTED'
      : 'COMING SOON';
    const badgeClass = lp.support === 'full' ? 'lp-badge-full'
      : lp.support === 'partial' ? 'lp-badge-partial'
      : 'lp-badge-soon';
    return `
      <div class="launchpad-card ${disabled ? 'disabled' : ''} ${lp.id === selectedLaunchpad ? 'selected' : ''}" data-launchpad="${lp.id}">
        <div class="launchpad-card-head">
          <span class="launchpad-card-name">${lp.name}</span>
          <span class="lp-badge ${badgeClass}">${badge}</span>
        </div>
        <div class="launchpad-card-url">${lp.url.replace('https://', '')}</div>
        <div class="launchpad-card-note">${lp.tagline}</div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.launchpad-card:not(.disabled)').forEach(card => {
    card.addEventListener('click', () => {
      grid.querySelectorAll('.launchpad-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedLaunchpad = card.getAttribute('data-launchpad');
      renderSetupInstructions();
    });
  });
}

export function renderLaunchpadStrip() {
  const strip = document.getElementById('launchpad-strip');
  if (!strip) return;
  strip.innerHTML = LAUNCHPADS.map(lp => {
    const soon = lp.support === 'coming-soon';
    return `
      <a href="${lp.url}" target="_blank" rel="noopener" class="launchpad-tile ${soon ? 'soon' : ''}">
        <span class="launchpad-tile-name">${lp.name}</span>
        <span class="launchpad-tile-status">${lp.support === 'full' ? '● full support' : lp.support === 'partial' ? '● supported' : '○ coming soon'}</span>
      </a>`;
  }).join('');
}

function renderSetupInstructions() {
  const lp = LAUNCHPADS.find(l => l.id === selectedLaunchpad) || LAUNCHPADS[0];
  const title = document.getElementById('setup-title');
  const desc = document.getElementById('setup-desc');
  const box = document.getElementById('setup-instructions');
  if (title) title.textContent = `Setup on ${lp.name}`;
  if (desc) desc.textContent = `Create your token on ${lp.url.replace('https://', '')} with these exact settings.`;
  if (!box) return;

  const walletRow = `
    <div class="copy-row">
      <span class="copy-address" id="protocol-wallet-address">${PROTOCOL_WALLET}</span>
      <button class="copy-btn" data-copy>COPY</button>
    </div>`;

  // Real screenshots of the launchpad UI, framed as terminal windows.
  // Click opens the full-size capture in a new tab.
  const fig = (src, site, caption) => `
    <figure class="guide-fig">
      <div class="guide-fig-bar">
        <span class="term-dots"><i></i><i></i><i></i></span>
        <span class="guide-fig-title">${site}</span>
        <span class="guide-fig-zoom">click to enlarge ⤢</span>
      </div>
      <a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${caption}" loading="lazy" /></a>
      <figcaption>${caption}</figcaption>
    </figure>`;

  const STEP_SETS = {
    pons: [
      `Go to <strong>pons.family → Create</strong> and fill in your token's name, ticker, description and image.
       ${fig('/guide/pons-form.png', 'pons.family/launchpad/create', 'The Pons launch form — fill the basics here. The 0.0005 ETH launch fee is shown on the right.')}`,
      `Open the <strong>Advanced</strong> section and paste the protocol wallet into the <strong>Creator wallet</strong> field:${walletRow}
       ${fig('/guide/pons-advanced.png', 'pons.family — Advanced section', 'Exactly like this — the address shown IS the protocol wallet. Pons’ own hint confirms it: “receives the creator share of trading fees (70%)”.')}`,
      `Complete the launch (0.0005 ETH fee). At <strong>4.2 ETH raised</strong> your token graduates to a locked Uniswap pool — creator fees flow to the engine forever.`,
      `Copy your new <strong>token address</strong> (0x…) and paste it in the next step to verify &amp; register.`,
    ],
    launchhood: [
      `Go to <strong>launchhood.com → Create coin</strong> and fill in your coin's name, ticker and image.
       ${fig('/guide/launchhood-form.png', 'launchhood.com/create', 'The LaunchHood create form — fill the basics here.')}`,
      `Open <strong>Advanced</strong> and paste the protocol wallet into the <strong>Reward recipient</strong> field:${walletRow}
       ${fig('/guide/launchhood-wallet.png', 'launchhood.com — Advanced section', 'Exactly like this — LaunchHood’s own hint confirms it: “address that earns the creator share of the locked-LP trading fees”.')}`,
      `Hit <strong>Launch coin</strong>. From then on the creator share of trading fees flows to the engine automatically.`,
      `Copy your new <strong>token address</strong> (0x…) and paste it in the next step to verify &amp; register.`,
    ],
    robinlaunch: [
      `Robinlaunch has no fee-routing field — creator fees follow the wallet that <em>launches</em> the token. So the token must be launched <strong>from the protocol wallet</strong>:${walletRow}
       ${fig('/guide/robinlaunch-home.png', 'robinlaunch.fun', 'Robinlaunch — token creation opens after connecting a wallet. The connected wallet becomes the fee recipient, so it must be the protocol wallet.')}`,
      `If you already launched from your own wallet, transfer the token's fee rights to the protocol wallet instead (or relaunch).`,
      `Copy the <strong>token address</strong> (0x…) of your newly created token and verify it in the next step.`,
    ],
  };

  const steps = STEP_SETS[lp.id] || [
    `Go to <strong>${lp.url.replace('https://', '')}</strong> and launch your token <strong>from the protocol wallet</strong> (or transfer its fee rights to it):${walletRow}`,
    `${lp.name} routes creator fees to the launching wallet — that's how the engine collects them.`,
    `Copy the <strong>token address</strong> (0x…) of your newly created token.`,
  ];

  box.innerHTML = steps.map((s, i) => `
    <div class="instruction-step">
      <span class="instruction-num">${i + 1}</span>
      <div class="instruction-content"><p>${s}</p></div>
    </div>`).join('');

  setupCopyButtons();
}

function renderPopularTokens() {
  const grid = document.getElementById('popular-tokens-grid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="token-section-label" style="grid-column:1/-1;font-family:var(--font-mono);font-size:0.6rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--accent);margin-bottom:4px;">OSTIUM STOCK PERPS — UP TO 50X</div>
    ${POPULAR_TOKENS.map(t => `
      <div class="popular-token-card glass-card perps-available" data-symbol="${t.symbol}" data-provider="${t.provider}" data-maxlev="${t.maxLev}">
        <div class="token-perps-badge">OSTIUM</div>
        <div class="token-symbol">${t.symbol}</div>
        <div class="token-label">${t.name}</div>
      </div>
    `).join('')}
  `;

  grid.querySelectorAll('.popular-token-card').forEach(card => {
    card.addEventListener('click', () => {
      grid.querySelectorAll('.popular-token-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');

      selectedToken = card.getAttribute('data-symbol');

      // Update leverage caps based on provider
      const maxLev = parseInt(card.getAttribute('data-maxlev')) || 50;
      updateLeverageCaps(maxLev);

      const nameInput = document.getElementById('derivative-name');
      if (nameInput && !nameInput.value) {
        const prefixes = ['MEGA', 'ULTRA', 'TURBO', 'NITRO', 'FLUX', 'FILL'];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        nameInput.value = `${prefix}_${selectedToken}`;
        derivativeName = nameInput.value;
      }
    });
  });
}

function updateLeverageCaps(maxLev) {
  const container = document.getElementById('leverage-options');
  const levLabel = document.getElementById('selected-leverage');
  if (!container) return;

  // Define all possible leverage tiers (Ostium max is 50x)
  const allTiers = [5, 10, 20, 30, 40, 50];
  const validTiers = allTiers.filter(t => t <= maxLev);

  // Regenerate buttons with only valid tiers
  container.innerHTML = validTiers.map(lev => {
    const isActive = lev === Math.min(selectedLeverage, maxLev);
    const cls = isActive ? 'btn btn-primary btn-sm leverage-btn active' : 'btn btn-outline btn-sm leverage-btn';
    return `<button class="${cls}" data-lev="${lev}" style="font-family:var(--font-mono);min-width:52px;">${lev}x</button>`;
  }).join('');

  // If current leverage exceeds max, clamp it
  if (selectedLeverage > maxLev) {
    selectedLeverage = maxLev;
    if (levLabel) levLabel.textContent = `${maxLev}x`;
  }

  // Re-bind click events
  container.querySelectorAll('.leverage-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lev = parseInt(btn.getAttribute('data-lev'));
      if (isNaN(lev)) return;
      selectedLeverage = lev;
      container.querySelectorAll('.leverage-btn').forEach(b => {
        b.classList.remove('active', 'btn-primary');
        b.classList.add('btn-outline');
      });
      btn.classList.add('active', 'btn-primary');
      btn.classList.remove('btn-outline');
      if (levLabel) levLabel.textContent = `${lev}x`;
    });
  });
}

function renderStrategySelector() {
  const box = document.getElementById('strategy-options');
  const label = document.getElementById('selected-strategy');
  if (!box) return;

  box.innerHTML = STRATEGIES.map(s => `
    <button type="button" class="strategy-btn ${s.id === selectedStrategy ? 'active' : ''}" data-strategy="${s.id}">
      <span class="strategy-btn-label">${s.label}</span>
      <span class="strategy-btn-desc">${s.desc}</span>
    </button>`).join('');

  box.querySelectorAll('.strategy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedStrategy = btn.getAttribute('data-strategy');
      box.querySelectorAll('.strategy-btn').forEach(b => b.classList.toggle('active', b === btn));
      if (label) label.textContent = selectedStrategy.toUpperCase();
      applyStrategyConstraints();
    });
  });

  applyStrategyConstraints();
}

/**
 * Keep the wizard coherent with the chosen strategy:
 * - leverage tiers are limited to the mode's ceiling (a 10x-max mode
 *   can't be given a 50x cap)
 * - "Off" means the engine never trades, so leverage and direction are
 *   disabled instead of pretending to matter
 */
function applyStrategyConstraints() {
  const mode = STRATEGIES.find(s => s.id === selectedStrategy) || STRATEGIES[2];
  const levBlock = document.querySelector('.leverage-selector');
  const dirBlock = document.querySelector('.direction-selector');
  const summary = document.getElementById('wizard-trade-summary');

  const disabled = !mode.trade;
  for (const block of [levBlock, dirBlock]) {
    if (!block) continue;
    block.style.opacity = disabled ? '0.35' : '';
    block.style.pointerEvents = disabled ? 'none' : '';
  }

  if (!disabled) {
    updateLeverageCaps(mode.maxLev);
  }

  if (summary) {
    summary.innerHTML = disabled
      ? `Selected: <span style="color:var(--yellow, #ffcc00);">OFF</span> — the engine won't trade; fees go to buybacks only`
      : `Selected: <span id="selected-direction" style="color:var(--accent);">${selectedDirection.toUpperCase()}</span> @ up to <span id="selected-leverage" style="color:var(--accent);">${selectedLeverage}x</span> · <span id="selected-strategy" style="color:var(--accent);">${selectedStrategy.toUpperCase()}</span>`;
  }
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
      if (currentStep === 0 && !selectedLaunchpad) {
        showToast('Pick a launchpad', 'warning');
        return;
      }
      if (currentStep === 1 && !selectedToken) {
        showToast('Select a stock to track', 'warning');
        return;
      }
      if (currentStep === 2) {
        const nameInput = document.getElementById('derivative-name');
        if (!nameInput?.value?.trim()) {
          showToast('Enter a derivative name', 'warning');
          return;
        }
        derivativeName = nameInput.value.trim();
      }

      if (currentStep < LAST_STEP) {
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
  const addressInput = document.getElementById('mint-address-input');
  const terminal = document.getElementById('verify-terminal');
  const mintBtn = document.getElementById('mint-verify-btn');
  const address = addressInput?.value?.trim();

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    terminalWrite(terminal, '> error: enter a valid Robinhood Chain token address (0x + 40 hex chars)', 'var(--red)');
    return;
  }

  mintBtn.textContent = 'VERIFYING...';
  mintBtn.disabled = true;
  addressInput.disabled = true;

  if (terminal) terminal.innerHTML = '';

  terminalAppend(terminal, `> verifying ${address.slice(0, 8)}...${address.slice(-6)}`, 'var(--text)');

  try {
    terminalAppend(terminal, '  calling /api/v1/tokens/register', 'var(--text-muted)');

    const response = await fetch('/api/v1/tokens/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address,
        launchpad: selectedLaunchpad,
        underlying: selectedToken || null,
        side: selectedDirection,
        strategy: selectedStrategy,
        leverage: selectedLeverage,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 409) {
        terminalAppend(terminal, '  token already registered', 'var(--yellow)');
        showToast('Token is already registered', 'info');
        resetMintButton(mintBtn, addressInput, 'REGISTERED', 'var(--yellow)');
        return;
      }

      if (response.status === 400) {
        const reason = data.reason || data.error || 'Verification failed';
        terminalAppend(terminal, `  verification failed: ${reason}`, 'var(--red)');
        showToast(`Verification failed: ${reason}`, 'error');
        resetMintButton(mintBtn, addressInput, 'VERIFY', null, true);
        return;
      }

      throw new Error(data.error || `HTTP ${response.status}`);
    }

    const token = data.token;
    terminalAppend(terminal, '  Pons launch verified', 'var(--green)');
    if (token.creatorWallet) {
      terminalAppend(terminal, `  creator wallet: ${token.creatorWallet.slice(0, 10)}...`, 'var(--green)');
    }
    terminalAppend(terminal, '  creator fees route to protocol', 'var(--green)');
    terminalAppend(terminal, `  pegged to ${token.underlying || 'AAPL'} perps on Ostium`, 'var(--green)');
    terminalAppend(terminal, '', '');
    terminalAppend(terminal, '  registered — fee claiming will begin automatically', 'var(--accent)');

    showToast('Token registered. Fee claiming begins next cycle.', 'success');

    mintBtn.textContent = 'REGISTERED';
    mintBtn.disabled = true;
    mintBtn.style.borderColor = 'var(--green)';
    mintBtn.style.color = 'var(--green)';

  } catch (err) {
    terminalAppend(terminal, `  error: ${err.message}`, 'var(--red)');

    if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
      terminalAppend(terminal, '  backend unreachable — nothing was registered', 'var(--red)');
      terminalAppend(terminal, '  try again in a minute', 'var(--text-muted)');
      showToast('Backend unreachable — registration not submitted', 'error', 6000);
    } else {
      showToast(`Registration failed: ${err.message}`, 'error');
    }
    resetMintButton(mintBtn, addressInput, 'VERIFY', null, true);
  }
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
  document.querySelectorAll('.wizard-step-dot').forEach((ind, i) => {
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

  if (!longBtn || !shortBtn) return;

  longBtn.addEventListener('click', () => {
    const dirLabel = document.getElementById('selected-direction');
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
    const dirLabel = document.getElementById('selected-direction');
    // SHORT is disabled (coming soon) — prevent any state change
    if (shortBtn.disabled) return;
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

function setupLeverageSelector() {
  const container = document.getElementById('leverage-options');
  const levLabel = document.getElementById('selected-leverage');
  if (!container) return;

  container.querySelectorAll('.leverage-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lev = parseInt(btn.getAttribute('data-lev'));
      if (isNaN(lev)) return;

      selectedLeverage = lev;

      // Update active states
      container.querySelectorAll('.leverage-btn').forEach(b => {
        b.classList.remove('active', 'btn-primary');
        b.classList.add('btn-outline');
      });
      btn.classList.add('active', 'btn-primary');
      btn.classList.remove('btn-outline');

      if (levLabel) levLabel.textContent = `${lev}x`;
    });
  });
}
