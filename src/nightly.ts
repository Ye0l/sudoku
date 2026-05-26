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
  document.getElementById('nightly-badge')?.remove();

  // ── Tear down experimental features ─────────────────────────────────────
  console.info('[Nightly] mode deactivated');
}

// ── Internal helpers ───────────────────────────────────────────────────────

function showBadge(): void {
  if (document.getElementById('nightly-badge')) return;

  const badge = document.createElement('div');
  badge.id = 'nightly-badge';
  badge.className = 'nightly-badge';
  badge.setAttribute('aria-hidden', 'true');

  const star = document.createElement('span');
  star.className = 'nightly-badge-star';
  star.textContent = '✦';

  const label = document.createElement('span');
  label.textContent = 'NIGHTLY';

  badge.appendChild(star);
  badge.appendChild(label);
  document.getElementById('app')?.appendChild(badge);
}
