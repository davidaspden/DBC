/**
 * U2 — Dimmable Overlay Controller for `index.html` (flag: `overlayDim`, default OFF).
 *
 * Cycles Normal -> Dim -> Min (persisted in `localStorage['dbc.overlay']`), injects a
 * compact `Dim` toggle button into `.status-right`, supports tap-on-video to toggle,
 * and auto-fades to Min-like opacity after 2 s of untouched scanning (restoring on
 * tap, decode lock, or error). Uses CSS transitions only — zero per-frame JS overhead.
 */

const OVERLAY_STORAGE_KEY = 'dbc.overlay';
const LEVELS = ['normal', 'dim', 'min'];

const STYLE_TEXT = `
  #app.overlay-dim-enabled .hud-top,
  #app.overlay-dim-enabled .hud-bottom {
    transition: opacity 220ms ease;
    will-change: opacity;
  }
  #app[data-overlay="dim"] .hud-top,
  #app[data-overlay="dim"] .hud-bottom {
    opacity: 0.30;
  }
  #app[data-overlay="dim"] #payload-card {
    opacity: 1;
  }
  #app[data-overlay="dim"] #history-panel #history-list {
    display: none;
  }
  #app[data-overlay="min"] .hud-top .metrics-grid,
  #app[data-overlay="min"] #history-panel,
  #app[data-overlay="min"] .controls {
    display: none;
  }
  #app[data-overlay="min"] .hud-top,
  #app[data-overlay="min"] .hud-bottom {
    background: transparent;
  }
  #app[data-overlay="min"] #payload-card {
    padding: 6px 10px;
    opacity: 0.85;
  }
  #app[data-overlay="min"] #payload-meta,
  #app[data-overlay="min"] #payload-hex {
    display: none;
  }
  #app.overlay-autofade .hud-top,
  #app.overlay-autofade .hud-bottom {
    opacity: 0.22;
  }
  .dim-toggle-btn {
    pointer-events: auto;
    color: #e2e8f0;
    background: rgba(15, 23, 42, 0.78);
    border: 1px solid rgba(148, 163, 184, 0.4);
    border-radius: 5px;
    padding: 2px 7px;
    font-size: 10px;
    font-weight: 700;
    min-height: 22px;
    flex: 0 0 auto;
    cursor: pointer;
  }
`;

export function initOverlayDim(appRoot, opts = {}) {
  if (!appRoot || typeof document === 'undefined') {
    return { notifyScanActive() {}, notifyLock() {}, notifyError() {}, getLevel: () => 'normal' };
  }

  const style = document.createElement('style');
  style.textContent = STYLE_TEXT;
  document.head.appendChild(style);
  appRoot.classList.add('overlay-dim-enabled');

  let level = 'normal';
  try {
    const saved = localStorage.getItem(OVERLAY_STORAGE_KEY);
    if (LEVELS.includes(saved)) level = saved;
  } catch {}

  let scanning = false;
  let fadeTimer = 0;

  const statusRight = appRoot.querySelector('.status-right');
  const btn = document.createElement('button');
  btn.id = 'btn-dim';
  btn.type = 'button';
  btn.className = 'dim-toggle-btn';
  if (statusRight) statusRight.prepend(btn);

  function applyLevel(next) {
    level = next;
    appRoot.dataset.overlay = level;
    appRoot.classList.remove('overlay-autofade');
    btn.textContent = level === 'normal' ? 'Dim' : (level === 'dim' ? 'Min' : 'Full');
    try { localStorage.setItem(OVERLAY_STORAGE_KEY, level); } catch {}
    scheduleAutoFade();
  }

  function scheduleAutoFade() {
    clearTimeout(fadeTimer);
    if (!scanning || level === 'min') return;
    fadeTimer = setTimeout(() => {
      if (scanning) appRoot.classList.add('overlay-autofade');
    }, 2000);
  }

  function wakeOverlay() {
    appRoot.classList.remove('overlay-autofade');
    scheduleAutoFade();
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = (LEVELS.indexOf(level) + 1) % LEVELS.length;
    applyLevel(LEVELS[idx]);
  });

  // Tap anywhere on the camera video area outside buttons/links to toggle Dim/Min
  appRoot.addEventListener('pointerdown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || e.target.closest('button, a, #debug-drawer, #history-panel')) {
      wakeOverlay();
      return;
    }
    if (appRoot.classList.contains('overlay-autofade')) {
      wakeOverlay();
    } else {
      const idx = (LEVELS.indexOf(level) + 1) % LEVELS.length;
      applyLevel(LEVELS[idx]);
    }
  });

  applyLevel(level);

  return {
    notifyScanActive(isScanning) {
      scanning = Boolean(isScanning);
      if (scanning) scheduleAutoFade();
      else {
        clearTimeout(fadeTimer);
        appRoot.classList.remove('overlay-autofade');
      }
    },
    notifyLock: wakeOverlay,
    notifyError: wakeOverlay,
    getLevel: () => level,
  };
}
