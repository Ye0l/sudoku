/**
 * Nightly mode – experimental features isolated from the stable release.
 *
 * HOW TO USE
 * ----------
 * Activate via URL  : /sudoku/?nightly   (session only, no persistence)
 * Activate via UI   : Settings → Nightly 토글 (saved to localStorage)
 *
 * ADDING NEW FEATURES
 * -------------------
 * 1. Keep all experimental code in this file or under src/nightly/*.ts
 * 2. Guard each feature with `if (!isActive()) return;`
 * 3. When stable, move the code to the relevant stable file and remove
 *    the nightly guard.
 *
 * This file is intentionally separate so that bugs here cannot
 * affect the stable code path.
 */

let _active = false;
let frameResizeHandler: (() => void) | null = null;

/** Returns true while nightly mode is running. */
export function isActive(): boolean {
  return _active;
}

/**
 * Activate nightly mode.
 * Called from app.ts when the setting is on or ?nightly is in the URL.
 */
export function activate(): void {
  if (_active) return;
  _active = true;

  document.documentElement.setAttribute('data-nightly', '');
  showBadge();

  // ── Experimental features ────────────────────────────────────────────────
  // Each feature gets its own clearly-named block so it is easy to grep
  // and promote (or delete) once stable.

  // [NIGHTLY] placeholder – replace with real feature toggles
  console.info('[Nightly] mode active – experimental features enabled');
}

/**
 * Deactivate nightly mode.
 * Called when the user turns the toggle off.
 */
export function deactivate(): void {
  if (!_active) return;
  _active = false;

  document.documentElement.removeAttribute('data-nightly');
  document.getElementById('nightly-frame')?.remove();
  if (frameResizeHandler) {
    window.removeEventListener('resize', frameResizeHandler);
    frameResizeHandler = null;
  }

  // ── Tear down experimental features ─────────────────────────────────────
  console.info('[Nightly] mode deactivated');
}

// ── Internal helpers ───────────────────────────────────────────────────────

function showBadge(): void {
  if (document.getElementById('nightly-frame')) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'nightly-frame';
  canvas.className = 'nightly-frame';
  canvas.setAttribute('aria-hidden', 'true');
  document.getElementById('app')?.appendChild(canvas);

  const draw = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const color = isDark ? 'rgba(251,191,36,0.82)' : 'rgba(217,119,6,0.78)';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const r = 20;

    // Fill only the corner areas outside the rounded rect using evenodd clip
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.roundRect(0.75, 0.75, width - 1.5, height - 1.5, r);
    ctx.clip('evenodd');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // Border stroke
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(0.75, 0.75, width - 1.5, height - 1.5, r);
    ctx.stroke();
  };

  draw();
  frameResizeHandler = draw;
  window.addEventListener('resize', draw, { passive: true });
}
