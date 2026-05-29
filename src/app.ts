// Main application controller

import type { AccentTheme, AppState, CageColorMode, GameState, GameType, Difficulty, Screen, Theme, NumpadLayout, CellState, CachedPuzzle, HistoryRecord } from './types.ts';
import {
  loadSavedGames, saveGame, removeSavedGame, loadHistory, loadSettings, saveSettings,
  clearHistory, removeHistoryRecord, takeCachedPuzzle, addCachedPuzzle, countCachedPuzzles, upsertHistory,
} from './storage.ts';
import {
  createGame, setCellValue, eraseCellValue, autoSave,
  startTimer, stopTimer, formatTime, getElapsed,
} from './game.ts';
import { getBoxIndex } from './engine/sudoku.ts';
import { createId } from './id.ts';

// Worker is loaded via Vite's ?worker suffix at runtime
const createPuzzleWorker = (): Worker =>
  new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' });

// ── State ─────────────────────────────────────────────────────────────────────

const state: AppState = {
  screen: 'menu',
  game: null,
  history: loadHistory(),
  settings: loadSettings(),
};

let selectedType: GameType = 'classic';
let selectedDiff: Difficulty = 'easy';
let selectedClassicDiff: Difficulty = 'easy';
let selectedKillerDiff: Difficulty = 'easy';
let pendingWorker: Worker | null = null;
const cacheFillInProgress = new Set<string>();
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let confirmResolver: ((ok: boolean) => void) | null = null;
let calcExpanded = false;
let calcAccumulator = 0;
let calcPendingOp: '+' | '-' | '*' | '/' | null = null;
let calcInputValue = '';
let calcEnteringNumber = true;
let dragSum: {
  pointerId: number;
  startCell: number;
  currentCell: number;
  active: boolean;
} | null = null;

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: '쉬움',
  medium: '보통',
  hard: '어려움',
  expert: '고수',
  master: '최고난도',
};

function difficultyLabel(difficulty: Difficulty): string {
  return DIFFICULTY_LABELS[difficulty] ?? DIFFICULTY_LABELS.easy;
}

function isKillerDifficulty(difficulty: Difficulty): boolean {
  return difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard';
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const screens = {
  menu:     document.getElementById('screen-menu')!,
  game:     document.getElementById('screen-game')!,
  history:  document.getElementById('screen-history')!,
  settings: document.getElementById('screen-settings')!,
};

const el = {
  // Menu
  typeClassic:   document.getElementById('type-classic')!,
  typeKiller:    document.getElementById('type-killer')!,
  difficultyGrid: document.querySelector<HTMLElement>('.difficulty-grid')!,
  diffBtns:      document.querySelectorAll<HTMLButtonElement>('.diff-btn'),
  startBtn:        document.getElementById('start-btn')!,
  resumeSection:   document.getElementById('resume-section')!,
  resumeList:      document.getElementById('resume-list')!,

  // Game
  timer:         document.getElementById('timer')!,
  gameInfo:      document.getElementById('game-info')!,
  boardGrid:     document.getElementById('board-grid')!,
  boardCanvas:   document.getElementById('board-canvas') as HTMLCanvasElement,
  sumCanvas:     document.getElementById('sum-canvas') as HTMLCanvasElement,
  boardContainer:document.getElementById('board-container')!,
  cageCanvas:    document.getElementById('cage-canvas') as HTMLCanvasElement,
  cageLineCanvas:document.getElementById('cage-line-canvas') as HTMLCanvasElement,
  loadingOverlay:document.getElementById('loading-overlay')!,
  completeOverlay:document.getElementById('complete-overlay')!,
  completeTime:  document.getElementById('complete-time')!,
  cells:         [] as HTMLElement[],

  // Side (landscape)
  sideTimer:     document.getElementById('side-timer'),

  // Numpad
  numBtns:        document.querySelectorAll<HTMLButtonElement>('.num-btn'),
  completeGameLabel: document.getElementById('complete-game-label')!,

  // Confirm dialog
  confirmBackdrop: document.getElementById('confirm-backdrop')!,
  confirmTitle:   document.getElementById('confirm-title')!,
  confirmMsg:     document.getElementById('confirm-msg')!,
  confirmOk:      document.getElementById('confirm-ok')!,
  confirmCancel:  document.getElementById('confirm-cancel')!,

  // Controls
  btnUndo:       document.getElementById('btn-undo')!,
  btnRedo:       document.getElementById('btn-redo')!,
  btnErase:      document.getElementById('btn-erase')!,
  btnMemo:       document.getElementById('btn-memo')!,
  btnHint:       document.getElementById('btn-hint')!,
  btnCalc:       document.getElementById('btn-calc') as HTMLButtonElement,
  hintCount:     document.getElementById('hint-count')!,
  calcInput:     document.getElementById('line-calc-input') as HTMLInputElement,
  calcRow:       document.getElementById('line-calc')!,
  calcPad:       document.getElementById('line-calc-pad')!,
  floatCalc:     document.getElementById('float-calc')!,
  floatCalcBody: document.getElementById('float-calc-body')!,
  mobileCalcWrap:document.getElementById('mobile-calc-wrap')!,

  // History
  historyList:   document.getElementById('history-list')!,
  appVersion:    document.getElementById('app-version')!,

  // Settings
  toggleErrors:    document.getElementById('toggle-errors') as HTMLInputElement,
  toggleHighlights:document.getElementById('toggle-highlights') as HTMLInputElement,
  toggleHintButton:document.getElementById('toggle-hint-button') as HTMLInputElement,
  toggleHaptics:   document.getElementById('toggle-haptics') as HTMLInputElement,
  accentThemeBtns:document.querySelectorAll<HTMLButtonElement>('.accent-theme-btn'),
  gridLineOpacity: document.getElementById('grid-line-opacity') as HTMLInputElement,
  boxLineOpacity:  document.getElementById('box-line-opacity') as HTMLInputElement,
  gridLinePreview: document.getElementById('grid-line-preview')!,
  numpadLayoutBtns:document.querySelectorAll<HTMLButtonElement>('.numpad-layout-btn'),
  cageColorModeBtns:document.querySelectorAll<HTMLButtonElement>('.cage-color-mode-btn'),
  themeBtns:       document.querySelectorAll<HTMLButtonElement>('.theme-btn'),
};

interface GameSnapshot {
  cells: CellState[];
  hintCount: number;
  memoMode: boolean;
  completed: boolean;
}

const undoStack: GameSnapshot[] = [];
const redoStack: GameSnapshot[] = [];
let settingsReturnScreen: Exclude<Screen, 'settings'> = 'menu';

// ── Navigation ────────────────────────────────────────────────────────────────

function navigate(to: Screen, direction: 'forward' | 'back' | 'fade' = 'forward'): void {
  const from = state.screen;
  if (from === to) return;

  const fromEl = screens[from];
  const toEl   = screens[to];

  const enterClass = direction === 'back'  ? 'slide-enter-from-left' :
                     direction === 'fade'  ? 'fade-enter' :
                                             'slide-enter-from-right';
  const exitClass  = direction === 'back'  ? 'slide-exit-to-right' :
                     direction === 'fade'  ? 'fade-exit' :
                                             'slide-exit-to-left';

  // Prep incoming
  toEl.classList.remove('hidden');
  toEl.classList.add(enterClass);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toEl.classList.remove(enterClass);
      fromEl.classList.add(exitClass);

      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        fromEl.classList.remove(exitClass);
        fromEl.classList.add('hidden');
        state.screen = to;
        onScreenEnter(to);
      };
      // transitionend may not fire if CSS transitions are disabled or very fast
      toEl.addEventListener('transitionend', cleanup, { once: true });
      setTimeout(cleanup, 400);
    });
  });
}

function onScreenEnter(screen: Screen): void {
  if (screen === 'menu') {
    renderMenuSavedGames();
  } else if (screen === 'game' && state.game) {
    renderBoard(state.game);
  } else if (screen === 'history') {
    renderHistory();
  } else if (screen === 'settings') {
    syncSettingsUI();
  }
}

function openSettings(): void {
  if (state.screen !== 'settings') {
    settingsReturnScreen = state.screen;
  }
  navigate('settings', 'fade');
}

function closeSettings(): void {
  navigate(settingsReturnScreen, settingsReturnScreen === 'game' ? 'fade' : 'back');
  if (settingsReturnScreen === 'game' && state.game) {
    renderBoard(state.game);
  }
}

// ── Custom confirm dialog ─────────────────────────────────────────────────────

function showConfirm(title: string, msg: string): Promise<boolean> {
  el.confirmTitle.textContent = title;
  el.confirmMsg.textContent   = msg;
  el.confirmBackdrop.classList.add('visible');
  return new Promise<boolean>(resolve => {
    confirmResolver = resolve;
  });
}

function resolveConfirm(ok: boolean): void {
  el.confirmBackdrop.classList.remove('visible');
  confirmResolver?.(ok);
  confirmResolver = null;
}

// ── Abandoned game helper ─────────────────────────────────────────────────────

function recordAbandonedGame(game: GameState): void {
  if (game.completed) return;
  const record: HistoryRecord = {
    id: game.id,
    type: game.type,
    difficulty: game.difficulty,
    completed: false,
    elapsed: getElapsed(game),
    date: Date.now(),
    moves: 0,
    hintCount: game.hintCount ?? 0,
  };
  upsertHistory(record);
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }
  applyGridLineSettings();
}

function applyAccentTheme(accentTheme: AccentTheme): void {
  document.documentElement.setAttribute('data-accent', accentTheme);
}

function applyNumpadLayout(layout: NumpadLayout): void {
  document.documentElement.setAttribute('data-numpad-layout', layout);
}

function applyGridLineSettings(): void {
  const root = document.documentElement;
  const gridLineOpacity = state.settings.gridLineOpacity;
  const boxLineOpacity = state.settings.boxLineOpacity;
  root.style.setProperty('--grid-line-alpha', String(gridLineOpacity));
  root.style.setProperty('--box-line-alpha', String(boxLineOpacity));
  if (el.gridLinePreview) {
    el.gridLinePreview.style.setProperty('--grid-line-alpha', String(gridLineOpacity));
    el.gridLinePreview.style.setProperty('--box-line-alpha', String(boxLineOpacity));
  }
}

function refreshMainFeatures(): void {
  applyNumpadLayout(state.settings.numpadLayout);
  applyGridLineSettings();
  if (state.screen === 'game' && state.game) {
    if (state.game.cages) setupCageCanvas(state.game, el.boardContainer.clientWidth);
    renderAllCells(state.game);
    updateKillerStats(state.game);
  }
}

// ── Menu ──────────────────────────────────────────────────────────────────────

function animateRemove(target: HTMLElement, callback: () => void): void {
  target.style.height = target.offsetHeight + 'px';
  target.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    target.style.transition = 'opacity 0.18s, height 0.26s 0.08s, margin 0.26s 0.08s, padding 0.26s 0.08s';
    target.style.opacity = '0';
    target.style.height = '0';
    target.style.marginTop = '0';
    target.style.marginBottom = '0';
    target.style.paddingTop = '0';
    target.style.paddingBottom = '0';
    setTimeout(callback, 320);
  });
}

function renderMenuSavedGames(): void {
  const games = loadSavedGames().filter(g => !g.completed);
  el.resumeSection.classList.toggle('hidden', games.length === 0);
  el.resumeList.innerHTML = '';

  games.forEach(game => {
    const typeLabel = game.type === 'classic' ? '스도쿠' : '킬러 스도쿠';
    const icon = game.type === 'classic' ? '🔢' : '🗡️';
    const diffLabel = difficultyLabel(game.difficulty);
    const d = new Date(game.startTime);
    const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

    const card = document.createElement('div');
    card.className = 'resume-card';
    card.innerHTML = `
      <div class="resume-icon">${icon}</div>
      <div class="resume-info">
        <h4>${typeLabel} · ${diffLabel}</h4>
        <p>${dateStr}</p>
      </div>
      <div class="resume-time">${formatTime(getElapsed(game))}</div>
      <button class="resume-delete-btn" aria-label="삭제">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>`;

    card.addEventListener('click', () => resumeGame(game));

    card.querySelector('.resume-delete-btn')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await showConfirm('이어하기 삭제', '이 게임을 삭제할까요? 저장된 진행 상황이 사라집니다.');
      if (!ok) return;
      animateRemove(card, () => {
        removeSavedGame(game.id);
        card.remove();
        if (el.resumeList.children.length === 0) {
          el.resumeSection.classList.add('hidden');
        }
      });
    });

    el.resumeList.appendChild(card);
  });
}

function selectType(type: GameType): void {
  selectedType = type;
  selectedDiff = type === 'classic' ? selectedClassicDiff : selectedKillerDiff;
  el.typeClassic.classList.toggle('active', type === 'classic');
  el.typeKiller.classList.toggle('active', type === 'killer');
  el.difficultyGrid.classList.toggle('killer-difficulty', type === 'killer');
  el.diffBtns.forEach(btn => {
    const diff = btn.dataset.diff as Difficulty;
    btn.classList.toggle('killer-hidden', type === 'killer' && !isKillerDifficulty(diff));
    btn.classList.toggle('active', diff === selectedDiff);
  });
  fillPuzzleCache(selectedType, selectedDiff);
}

function selectDiff(diff: Difficulty): void {
  if (selectedType === 'killer' && !isKillerDifficulty(diff)) return;
  selectedDiff = diff;
  if (selectedType === 'classic') {
    selectedClassicDiff = diff;
  } else {
    selectedKillerDiff = diff;
  }
  el.diffBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.diff === diff);
  });
  fillPuzzleCache(selectedType, selectedDiff);
}

// ── Puzzle worker ─────────────────────────────────────────────────────────────

function cacheKey(type: GameType, diff: Difficulty): string {
  return `${type}:${diff}`;
}

function createCachedPuzzle(type: GameType, diff: Difficulty, puzzle: { board: number[]; solution: number[]; cages?: CachedPuzzle['cages'] }): CachedPuzzle {
  return {
    type,
    difficulty: diff,
    board: puzzle.board,
    solution: puzzle.solution,
    cages: puzzle.cages,
    createdAt: Date.now(),
  };
}

function gameFromPuzzle(type: GameType, diff: Difficulty, puzzle: { board: number[]; solution: number[]; cages?: CachedPuzzle['cages'] }): GameState {
  return createGame(type, diff, puzzle.board, puzzle.solution, puzzle.cages);
}

function fillPuzzleCache(type: GameType, diff: Difficulty): void {
  if (type !== 'killer') return;
  if (countCachedPuzzles(type, diff) > 0) return;

  const key = cacheKey(type, diff);
  if (cacheFillInProgress.has(key)) return;
  cacheFillInProgress.add(key);

  const worker = createPuzzleWorker();
  const id = createId();

  worker.onmessage = (e: MessageEvent) => {
    if (e.data.id !== id) return;
    worker.terminate();
    cacheFillInProgress.delete(key);

    if (e.data.type !== 'error') {
      addCachedPuzzle(createCachedPuzzle(type, diff, e.data.puzzle));
    }
  };

  worker.onerror = () => {
    worker.terminate();
    cacheFillInProgress.delete(key);
  };

  worker.postMessage({ type, difficulty: diff, id });
}

function generatePuzzle(type: GameType, diff: Difficulty): Promise<GameState> {
  const cached = type === 'killer' ? takeCachedPuzzle(type, diff) : null;
  if (cached) {
    fillPuzzleCache(type, diff);
    return Promise.resolve(gameFromPuzzle(type, diff, cached));
  }

  return new Promise((resolve, reject) => {
    // Cancel pending worker
    if (pendingWorker) { pendingWorker.terminate(); pendingWorker = null; }

    const worker = createPuzzleWorker();
    pendingWorker = worker;
    const id = createId();

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      worker.terminate();
      pendingWorker = null;

      if (e.data.type === 'error') {
        reject(new Error(e.data.message as string));
        return;
      }

      const puzzle = e.data.puzzle;
      resolve(gameFromPuzzle(type, diff, puzzle));
      fillPuzzleCache(type, diff);
    };

    worker.onerror = (e: ErrorEvent) => {
      worker.terminate();
      pendingWorker = null;
      reject(e);
    };

    worker.postMessage({ type, difficulty: diff, id });
  });
}

// ── Game start / resume ───────────────────────────────────────────────────────

async function startNewGame(): Promise<void> {
  // If there is an unfinished game, record it as abandoned before replacing it
  if (state.game && !state.game.completed) {
    recordAbandonedGame(state.game);
  }

  undoStack.length = 0;
  redoStack.length = 0;

  // Set temporary header before puzzle is ready
  const typeLabel = selectedType === 'classic' ? '스도쿠' : '킬러 스도쿠';
  const diffLabel = difficultyLabel(selectedDiff);
  el.gameInfo.textContent = `${typeLabel} · ${diffLabel}`;
  el.timer.textContent = '00:00';

  // Navigate first so user sees transition, loading overlay visible on game screen
  navigate('game');

  // Small wait for transition to begin
  await new Promise(r => setTimeout(r, 80));
  showLoading(true);

  try {
    const game = await generatePuzzle(selectedType, selectedDiff);
    state.game = game;
    saveGame(game);
    renderBoard(game);
    showLoading(false);
    beginTimer();
  } catch (err) {
    showLoading(false);
    console.error('Puzzle generation failed:', err);
    navigate('menu', 'back');
  }
}

function resumeGame(saved: GameState): void {
  state.game = saved;
  undoStack.length = 0;
  redoStack.length = 0;
  updateGameHeader(saved);
  navigate('game');
  requestAnimationFrame(() => {
    renderBoard(saved);
    beginTimer();
  });
}

function updateGameHeader(game: GameState): void {
  const typeLabel = game.type === 'classic' ? '스도쿠' : '킬러 스도쿠';
  const diffLabel = difficultyLabel(game.difficulty);
  el.gameInfo.textContent = `${typeLabel} · ${diffLabel}`;
}

function showLoading(show: boolean): void {
  el.loadingOverlay.classList.toggle('hidden', !show);
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function beginTimer(): void {
  const game = state.game;
  if (!game) return;
  game.paused = false;
  game.startTime = Date.now();
  startTimer(game, (elapsed) => {
    const t = formatTime(elapsed);
    el.timer.textContent = t;
    if (el.sideTimer) el.sideTimer.textContent = t;
  });
}

// ── Board rendering ───────────────────────────────────────────────────────────

function isLandscape(): boolean {
  return window.innerWidth > window.innerHeight && window.innerWidth >= 600;
}

function isPC(): boolean {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function updateLayoutMode(): void {
  const landscape = isLandscape();
  const pc = isPC();
  const side = document.getElementById('game-side')!;
  const numpad = document.querySelector('.numpad') as HTMLElement;
  const controls = document.querySelector('.controls-bar') as HTMLElement;

  // Route calc elements to the right container for each mode
  if (pc) {
    el.floatCalcBody.appendChild(el.calcRow);
    el.floatCalcBody.appendChild(el.calcPad);
  } else if (landscape) {
    side.appendChild(el.calcRow);
    side.appendChild(el.calcPad);
  } else {
    const gameScreen = document.getElementById('screen-game')!;
    const numpad = document.querySelector('.numpad') as HTMLElement;
    if (el.mobileCalcWrap.parentElement !== gameScreen) gameScreen.appendChild(el.mobileCalcWrap);
    if (el.mobileCalcWrap.nextElementSibling !== numpad) gameScreen.insertBefore(el.mobileCalcWrap, numpad);
    el.mobileCalcWrap.appendChild(el.calcRow);
    el.mobileCalcWrap.appendChild(el.calcPad);
  }

  if (landscape) {
    side.style.display = 'flex';
    side.appendChild(numpad);
    side.appendChild(controls);
  } else {
    const gameScreen = document.getElementById('screen-game')!;
    side.style.display = 'none';
    if (numpad.parentElement !== gameScreen) gameScreen.appendChild(numpad);
    if (controls.parentElement !== gameScreen) {
      gameScreen.insertBefore(controls, numpad);
    }
  }

  updateCalculatorVisibility();
}

function renderBoard(game: GameState): void {
  const container = el.boardContainer;
  const grid      = el.boardGrid;

  updateLayoutMode();

  // Measure .board-area (grandparent of board-grid), not board-container.
  // board-container has no CSS dimensions so its clientWidth/Height is 0.
  const area     = el.boardGrid.parentElement!.parentElement!;
  const compactBoard = window.matchMedia('(max-width: 599px), (orientation: portrait)').matches;
  const horizontalPad = compactBoard ? 0 : 16;
  const verticalPad = compactBoard ? 12 : 16;
  const maxSize  = Math.min(area.clientWidth - horizontalPad, area.clientHeight - verticalPad);
  const size     = Math.max(200, maxSize);
  const boardPad = 0;
  const cellSize = size / 9;
  const boardPx  = size;
  const canvasPx = boardPx;

  container.style.width  = canvasPx + 'px';
  container.style.height = canvasPx + 'px';
  container.style.setProperty('--board-pad', boardPad + 'px');
  el.boardCanvas.style.width = canvasPx + 'px';
  el.boardCanvas.style.height = canvasPx + 'px';
  el.sumCanvas.style.width = canvasPx + 'px';
  el.sumCanvas.style.height = canvasPx + 'px';
  document.documentElement.style.setProperty('--cell-size', cellSize + 'px');

  // Build cells
  grid.innerHTML = '';
  el.cells = [];

  for (let i = 0; i < 81; i++) {
    const cellEl = document.createElement('div');
    cellEl.className = 'cell';
    cellEl.dataset.idx = String(i);

    // Box borders
    const row = (i / 9) | 0;
    const col = i % 9;
    if (col === 2 || col === 5) cellEl.classList.add('box-border-right');
    if (row === 2 || row === 5) cellEl.classList.add('box-border-bottom');

    grid.appendChild(cellEl);
    el.cells.push(cellEl);
  }

  // Killer: prepare cage overlay
  if (game.cages) {
    setupCageCanvas(game, boardPx);
  } else {
    el.cageCanvas.style.display = 'none';
    el.cageLineCanvas.style.display = 'none';
  }

  renderAllCells(game);
  updateNumpadCounts(game);
  updateMemoBtn(game);
  updateHintCount(game);
}

function setupCageCanvas(game: GameState, boardPx: number): void {
  const canvas = el.cageCanvas;
  const lineCanvas = el.cageLineCanvas;
  const canvasPad = parseFloat(el.boardContainer.style.getPropertyValue('--board-pad')) || 0;
  const canvasPx = boardPx + canvasPad * 2;
  const gridBorder = 0;
  const gridGap = 0;
  const cellTrack = boardPx / 9;
  const dpr = window.devicePixelRatio || 1;
  [canvas, lineCanvas].forEach(c => {
    c.style.display = 'block';
    c.width  = Math.round(canvasPx * dpr);
    c.height = Math.round(canvasPx * dpr);
    c.style.left = '0px';
    c.style.top = '0px';
    c.style.right = 'auto';
    c.style.bottom = 'auto';
    c.style.width  = canvasPx + 'px';
    c.style.height = canvasPx + 'px';
  });

  const ctx = canvas.getContext('2d')!;
  const lineCtx = lineCanvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lineCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvasPx, canvasPx);
  lineCtx.clearRect(0, 0, canvasPx, canvasPx);

  const cages   = game.cages!;
  const isDark  = document.documentElement.getAttribute('data-theme') === 'dark';

  const DISTINCT_CAGE_FILLS = isDark
    ? ['rgba(129,140,248,0.12)','rgba(244,114,182,0.12)','rgba(74,222,128,0.12)','rgba(251,191,36,0.12)','rgba(45,212,191,0.12)','rgba(192,132,252,0.12)']
    : ['rgba(99,102,241,0.16)','rgba(236,72,153,0.16)','rgba(34,197,94,0.16)','rgba(245,158,11,0.16)','rgba(20,184,166,0.16)','rgba(168,85,247,0.16)'];

  const DISTINCT_CAGE_BORDERS = isDark
    ? ['rgba(129,140,248,0.68)','rgba(244,114,182,0.68)','rgba(74,222,128,0.68)','rgba(251,191,36,0.68)','rgba(45,212,191,0.68)','rgba(192,132,252,0.68)']
    : ['rgba(99,102,241,0.62)','rgba(236,72,153,0.62)','rgba(34,197,94,0.62)','rgba(245,158,11,0.68)','rgba(20,184,166,0.62)','rgba(168,85,247,0.62)'];
  const DISTINCT_CAGE_BORDERS_SELECTED = isDark
    ? ['rgba(129,140,248,1)','rgba(244,114,182,1)','rgba(74,222,128,1)','rgba(251,191,36,1)','rgba(45,212,191,1)','rgba(192,132,252,1)']
    : ['rgba(79,82,221,1)','rgba(210,44,140,1)','rgba(22,163,74,1)','rgba(217,119,6,1)','rgba(13,148,136,1)','rgba(147,51,234,1)'];
  const DISTINCT_CAGE_FILLS_SELECTED = isDark
    ? ['rgba(129,140,248,0.28)','rgba(244,114,182,0.28)','rgba(74,222,128,0.28)','rgba(251,191,36,0.28)','rgba(45,212,191,0.28)','rgba(192,132,252,0.28)']
    : ['rgba(99,102,241,0.30)','rgba(236,72,153,0.30)','rgba(34,197,94,0.30)','rgba(245,158,11,0.30)','rgba(20,184,166,0.30)','rgba(168,85,247,0.30)'];
  const accentRgbByTheme: Record<AccentTheme, string> = {
    blue: isDark ? '129,140,248' : '99,102,241',
    yellow: isDark ? '251,191,36' : '217,119,6',
    red: isDark ? '248,113,113' : '220,38,38',
    violet: isDark ? '192,132,252' : '147,51,234',
    green: isDark ? '74,222,128' : '22,163,74',
  };
  const accentRgb = accentRgbByTheme[state.settings.accentTheme] ?? accentRgbByTheme.blue;
  const accentCageFills = Array.from({ length: 6 }, () => `rgba(${accentRgb},${isDark ? 0.12 : 0.16})`);
  const accentCageBorders = Array.from({ length: 6 }, () => `rgba(${accentRgb},${isDark ? 0.68 : 0.62})`);
  const accentCageBordersSelected = Array.from({ length: 6 }, () => `rgba(${accentRgb},1)`);
  const accentCageFillsSelected = Array.from({ length: 6 }, () => `rgba(${accentRgb},${isDark ? 0.28 : 0.30})`);
  const useAccentCages = state.settings.cageColorMode === 'accent';
  const CAGE_FILLS = useAccentCages ? accentCageFills : DISTINCT_CAGE_FILLS;
  const CAGE_BORDERS = useAccentCages ? accentCageBorders : DISTINCT_CAGE_BORDERS;
  const CAGE_BORDERS_SELECTED = useAccentCages ? accentCageBordersSelected : DISTINCT_CAGE_BORDERS_SELECTED;
  const CAGE_FILLS_SELECTED = useAccentCages ? accentCageFillsSelected : DISTINCT_CAGE_FILLS_SELECTED;
  const boxLineOpacity = state.settings.boxLineOpacity;
  const BOX_GRID = isDark
    ? `rgba(244,245,255,${boxLineOpacity})`
    : `rgba(26,27,46,${boxLineOpacity})`;

  // Pass 1: cage fills
  cages.forEach(cage => {
    ctx.fillStyle = CAGE_FILLS[cage.colorIndex];
    cage.cells.forEach(pos => {
      const r = (pos / 9) | 0;
      const c = pos % 9;
      ctx.fillRect(
        canvasPad + gridBorder + c * (cellTrack + gridGap),
        canvasPad + gridBorder + r * (cellTrack + gridGap),
        cellTrack,
        cellTrack,
      );
    });
  });

  // Boost selected cage fill on top of the base fill
  const selectedCageForFill = game.selectedCell === -1 ? undefined : cages.find(cage => cage.cells.includes(game.selectedCell));
  if (selectedCageForFill) {
    ctx.fillStyle = CAGE_FILLS_SELECTED[selectedCageForFill.colorIndex];
    selectedCageForFill.cells.forEach(pos => {
      const r = (pos / 9) | 0;
      const c = pos % 9;
      ctx.fillRect(
        canvasPad + gridBorder + c * (cellTrack + gridGap),
        canvasPad + gridBorder + r * (cellTrack + gridGap),
        cellTrack,
        cellTrack,
      );
    });
  }

  const cageInset = Math.max(4, Math.round(cellTrack * 0.1));
  const labelFontSize = Math.max(9, Math.round(cellTrack * 0.21));
  const labelFontFamily = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  const labelFont = `700 ${labelFontSize}px ${labelFontFamily}`;
  const labelClearPadX = Math.max(2, Math.round(cellTrack * 0.055));
  const labelClearPadY = Math.max(2, Math.round(cellTrack * 0.045));
  const labelRadius = Math.max(3, Math.round(cellTrack * 0.07));

  const getLabelCell = (cage: { cells: number[] }): number => {
    let labelCell = cage.cells[0];
    for (const pos of cage.cells) {
      const labelRow = (labelCell / 9) | 0;
      const row = (pos / 9) | 0;
      if (row < labelRow || (row === labelRow && pos % 9 < labelCell % 9)) labelCell = pos;
    }
    return labelCell;
  };

  type GridPoint = { row: number; col: number };
  type BoundaryEdge = { start: GridPoint; end: GridPoint; dir: number; key: string };

  const pointKey = (p: GridPoint): string => `${p.row},${p.col}`;
  const edgeKey = (start: GridPoint, end: GridPoint): string =>
    `${start.row},${start.col}->${end.row},${end.col}`;

  const makeEdge = (start: GridPoint, end: GridPoint): BoundaryEdge => {
    const dc = end.col - start.col;
    const dr = end.row - start.row;
    const dir = dc === 1 ? 0 : dr === 1 ? 1 : dc === -1 ? 2 : 3;
    return { start, end, dir, key: edgeKey(start, end) };
  };

  const traceBoundaryLoops = (cellSet: Set<number>): BoundaryEdge[][] => {
    const edges: BoundaryEdge[] = [];
    cellSet.forEach(pos => {
      const row = (pos / 9) | 0;
      const col = pos % 9;
      if (row === 0 || !cellSet.has(pos - 9)) edges.push(makeEdge({ row, col }, { row, col: col + 1 }));
      if (col === 8 || !cellSet.has(pos + 1)) edges.push(makeEdge({ row, col: col + 1 }, { row: row + 1, col: col + 1 }));
      if (row === 8 || !cellSet.has(pos + 9)) edges.push(makeEdge({ row: row + 1, col: col + 1 }, { row: row + 1, col }));
      if (col === 0 || !cellSet.has(pos - 1)) edges.push(makeEdge({ row: row + 1, col }, { row, col }));
    });

    const byStart = new Map<string, BoundaryEdge[]>();
    edges.forEach(edge => {
      const key = pointKey(edge.start);
      byStart.set(key, [...(byStart.get(key) ?? []), edge]);
    });

    const used = new Set<string>();
    const loops: BoundaryEdge[][] = [];
    const turnPreference = [1, 0, 3, 2];

    edges.forEach(first => {
      if (used.has(first.key)) return;

      const loop: BoundaryEdge[] = [];
      let current = first;
      while (!used.has(current.key)) {
        used.add(current.key);
        loop.push(current);

        const candidates = (byStart.get(pointKey(current.end)) ?? [])
          .filter(edge => !used.has(edge.key))
          .sort((a, b) => {
            const turnA = (a.dir - current.dir + 4) % 4;
            const turnB = (b.dir - current.dir + 4) % 4;
            return turnPreference.indexOf(turnA) - turnPreference.indexOf(turnB);
          });

        if (candidates.length === 0) break;
        current = candidates[0];
      }

      if (loop.length > 0) loops.push(loop);
    });

    return loops;
  };

  const gridLineCoord = (line: number): number => {
    if (line <= 0) return canvasPad + gridBorder;
    if (line >= 9) return canvasPad + boardPx - gridBorder;
    return canvasPad + gridBorder + line * cellTrack + (line - 0.5) * gridGap;
  };

  const cellStartCoord = (line: number): number => {
    return canvasPad + gridBorder + line * (cellTrack + gridGap);
  };

  const insetPoint = (prev: GridPoint, point: GridPoint, next: GridPoint): [number, number] => {
    const inDx = Math.sign(point.col - prev.col);
    const inDy = Math.sign(point.row - prev.row);
    const outDx = Math.sign(next.col - point.col);
    const outDy = Math.sign(next.row - point.row);
    const inNormal = { x: -inDy, y: inDx };
    const outNormal = { x: -outDy, y: outDx };
    const xOffset = (inNormal.x !== 0 ? inNormal.x : outNormal.x) * cageInset;
    const yOffset = (inNormal.y !== 0 ? inNormal.y : outNormal.y) * cageInset;
    return [
      gridLineCoord(point.col) + xOffset,
      gridLineCoord(point.row) + yOffset,
    ];
  };

  const simplifyLoopVertices = (vertices: GridPoint[]): GridPoint[] => {
    return vertices.filter((point, i) => {
      const prev = vertices[(i - 1 + vertices.length) % vertices.length];
      const next = vertices[(i + 1) % vertices.length];
      const sameRow = prev.row === point.row && point.row === next.row;
      const sameCol = prev.col === point.col && point.col === next.col;
      return !sameRow && !sameCol;
    });
  };

  const strokeDashedCageOutline = (cellSet: Set<number>, offset = 0): void => {
    const dashLen = Math.max(2, cellTrack * 0.045);
    const gapLen = Math.max(2.5, cellTrack * 0.055);
    const dashPattern = [dashLen, gapLen];
    const totalPattern = dashLen + gapLen;

    traceBoundaryLoops(cellSet).forEach(loop => {
      const vertices = simplifyLoopVertices(loop.map(edge => edge.start));
      if (vertices.length < 2) return;
      const points = vertices.map((pt, i): [number, number] => {
        const prev = vertices[(i - 1 + vertices.length) % vertices.length];
        const next = vertices[(i + 1) % vertices.length];
        return insetPoint(prev, pt, next);
      });

      const pts = [...points, points[0]];
      let dashIndex = 0;
      let dashPos = offset % totalPattern;
      while (dashPos >= dashPattern[dashIndex]) {
        dashPos -= dashPattern[dashIndex++];
        if (dashIndex >= dashPattern.length) dashIndex = 0;
      }
      let drawing = dashIndex % 2 === 0;

      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[i + 1];
        const segLen = Math.hypot(x2 - x1, y2 - y1);
        if (segLen === 0) continue;
        const dx = (x2 - x1) / segLen;
        const dy = (y2 - y1) / segLen;

        let segPos = 0;
        while (segPos < segLen) {
          const stepMax = dashPattern[dashIndex] - dashPos;
          const step = Math.min(stepMax, segLen - segPos);
          if (drawing) {
            lineCtx.beginPath();
            lineCtx.moveTo(x1 + dx * segPos, y1 + dy * segPos);
            lineCtx.lineTo(x1 + dx * (segPos + step), y1 + dy * (segPos + step));
            lineCtx.stroke();
          }
          segPos += step;
          dashPos += step;
          if (dashPos >= dashPattern[dashIndex]) {
            dashPos = 0;
            dashIndex = (dashIndex + 1) % dashPattern.length;
            drawing = !drawing;
          }
        }
      }
    });
  };

  const labelBounds = (sum: number, labelCell: number): { x: number; y: number; w: number; h: number } => {
    const row = (labelCell / 9) | 0;
    const col = labelCell % 9;
    const labelX = cellStartCoord(col) + cageInset + 1;
    const labelY = cellStartCoord(row) + cageInset - 4;
    lineCtx.font = labelFont;
    const textWidth = Math.ceil(lineCtx.measureText(String(sum)).width);
    return {
      x: labelX - labelClearPadX,
      y: labelY - labelClearPadY,
      w: textWidth + labelClearPadX * 2,
      h: labelFontSize + labelClearPadY * 2,
    };
  };

  const roundedRect = (x: number, y: number, w: number, h: number, r: number): void => {
    const radius = Math.min(r, w / 2, h / 2);
    lineCtx.moveTo(x + radius, y);
    lineCtx.lineTo(x + w - radius, y);
    lineCtx.quadraticCurveTo(x + w, y, x + w, y + radius);
    lineCtx.lineTo(x + w, y + h - radius);
    lineCtx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    lineCtx.lineTo(x + radius, y + h);
    lineCtx.quadraticCurveTo(x, y + h, x, y + h - radius);
    lineCtx.lineTo(x, y + radius);
    lineCtx.quadraticCurveTo(x, y, x + radius, y);
  };

  const strokeBoxGrid = (): void => {
    lineCtx.save();
    lineCtx.setLineDash([]);
    lineCtx.lineCap = 'butt';
    lineCtx.lineJoin = 'miter';
    lineCtx.lineWidth = Math.max(1, cellTrack * 0.018);
    lineCtx.strokeStyle = BOX_GRID;
    lineCtx.beginPath();
    [3, 6].forEach(n => {
      const p = gridLineCoord(n);
      lineCtx.moveTo(p, canvasPad + gridBorder);
      lineCtx.lineTo(p, canvasPad + boardPx - gridBorder);
      lineCtx.moveTo(canvasPad + gridBorder, p);
      lineCtx.lineTo(canvasPad + boardPx - gridBorder, p);
    });
    lineCtx.stroke();
    lineCtx.restore();
  };

  // Pass 2: dotted cage borders on a dedicated overlay above the base Sudoku grid.
  const selectedCage = game.selectedCell === -1 ? undefined : cages.find(cage => cage.cells.includes(game.selectedCell));

  const allLabelBounds = cages.map(cage => labelBounds(cage.sum, getLabelCell(cage)));

  const clearLabels = (): void => {
    lineCtx.save();
    lineCtx.globalCompositeOperation = 'destination-out';
    lineCtx.beginPath();
    allLabelBounds.forEach(({ x, y, w, h }) => roundedRect(x, y, w, h, labelRadius));
    lineCtx.fill();
    lineCtx.restore();
  };

  // Draw static content (box grid + all cages) once.
  lineCtx.clearRect(0, 0, canvasPx, canvasPx);
  lineCtx.lineCap = 'round';
  lineCtx.lineJoin = 'round';
  lineCtx.lineWidth = Math.max(1.5, cellTrack * 0.035);
  lineCtx.setLineDash([]);
  lineCtx.shadowBlur = 0;
  lineCtx.shadowColor = 'transparent';
  strokeBoxGrid();
  cages.forEach(cage => {
    const selected = cage === selectedCage;
    lineCtx.lineWidth = selected ? Math.max(2, cellTrack * 0.048) : Math.max(1.5, cellTrack * 0.035);
    lineCtx.strokeStyle = selected ? CAGE_BORDERS_SELECTED[cage.colorIndex] : CAGE_BORDERS[cage.colorIndex];
    lineCtx.fillStyle = selected ? CAGE_BORDERS_SELECTED[cage.colorIndex] : CAGE_BORDERS[cage.colorIndex];
    strokeDashedCageOutline(new Set(cage.cells), 0);
  });
  clearLabels();

  cages.forEach(cage => {
    const labelCell = getLabelCell(cage);
    const row = (labelCell / 9) | 0;
    const col = labelCell % 9;
    const labelX = cellStartCoord(col) + cageInset + 1;
    const labelY = cellStartCoord(row) + cageInset - 4;
    const text = String(cage.sum);

    lineCtx.save();
    lineCtx.textAlign = 'left';
    lineCtx.textBaseline = 'top';
    lineCtx.font = labelFont;
    lineCtx.fillStyle = isDark ? '#9a9bca' : '#5a5b6a';
    lineCtx.fillText(text, labelX, labelY);
    lineCtx.restore();
  });
}

function renderAllCells(game: GameState): void {
  for (let i = 0; i < 81; i++) {
    renderCell(game, i);
  }
  if (game.cages) setupCageCanvas(game, getInnerBoardPx());
  drawBoardCanvas(game);
}

function getInnerBoardPx(): number {
  const boardPad = parseFloat(el.boardContainer.style.getPropertyValue('--board-pad')) || 0;
  return el.boardContainer.clientWidth - boardPad * 2;
}

function cellFromPointerEvent(e: PointerEvent): number {
  const rect = el.boardGrid.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width - 0.01);
  const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height - 0.01);
  const col = Math.floor((x / rect.width) * 9);
  const row = Math.floor((y / rect.height) * 9);
  return row * 9 + col;
}

function dragBounds(): { minRow: number; maxRow: number; minCol: number; maxCol: number } | null {
  if (!dragSum?.active) return null;
  const startRow = (dragSum.startCell / 9) | 0;
  const startCol = dragSum.startCell % 9;
  const currentRow = (dragSum.currentCell / 9) | 0;
  const currentCol = dragSum.currentCell % 9;
  return {
    minRow: Math.min(startRow, currentRow),
    maxRow: Math.max(startRow, currentRow),
    minCol: Math.min(startCol, currentCol),
    maxCol: Math.max(startCol, currentCol),
  };
}

function drawBoardCanvas(game: GameState): void {
  const canvas = el.boardCanvas;
  const canvasPx = el.boardContainer.clientWidth;
  const boardPad = parseFloat(el.boardContainer.style.getPropertyValue('--board-pad')) || 0;
  const boardPx = canvasPx - boardPad * 2;
  if (canvasPx <= 0 || boardPx <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvasPx * dpr);
  canvas.height = Math.round(canvasPx * dpr);

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvasPx, canvasPx);

  const bodyStyle = getComputedStyle(document.body);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridLineOpacity = state.settings.gridLineOpacity;
  const boxLineOpacity = state.settings.boxLineOpacity;
  const palette = {
    cellBg: isDark ? '#1a1b2e' : '#ffffff',
    gridLine: isDark ? `rgba(244,245,255,${gridLineOpacity})` : `rgba(26,27,46,${gridLineOpacity})`,
    boxLine: isDark ? `rgba(244,245,255,${boxLineOpacity})` : `rgba(26,27,46,${boxLineOpacity})`,
    given: isDark ? '#e8e9f8' : '#1a1b2e',
    user: bodyStyle.getPropertyValue('--cell-user').trim() || (isDark ? '#818cf8' : '#6366f1'),
    error: isDark ? '#f87171' : '#dc2626',
    errorBg: isDark ? 'rgba(248,113,113,0.12)' : 'rgba(239,68,68,0.12)',
  };
  const gridBorder = 0;
  const gridGap = 0;
  const cellTrack = boardPx / 9;
  const cellStep = cellTrack + gridGap;
  const cellStart = (line: number): number => boardPad + gridBorder + line * cellStep;
  const cellSpan = (count: number): number => cellTrack * count + gridGap * (count - 1);

  ctx.fillStyle = palette.gridLine;
  ctx.fillRect(boardPad, boardPad, boardPx, boardPx);

  for (let idx = 0; idx < 81; idx++) {
    const row = (idx / 9) | 0;
    const col = idx % 9;
    const cell = game.cells[idx];
    ctx.fillStyle = cell.error && state.settings.showErrors ? palette.errorBg : palette.cellBg;
    ctx.fillRect(cellStart(col), cellStart(row), cellTrack, cellTrack);
  }

  drawKillerSumGuides(game, cellStart, cellSpan, cellTrack);

  ctx.save();
  ctx.strokeStyle = palette.gridLine;
  ctx.lineWidth = 1;
  for (let line = 0; line <= 9; line++) {
    const p = line === 9 ? boardPad + boardPx - 0.5 : Math.round(cellStart(line)) + 0.5;
    ctx.beginPath();
    if (line > 0 && line < 9) {
      ctx.moveTo(p, boardPad);
      ctx.lineTo(p, boardPad + boardPx);
    }
    ctx.moveTo(boardPad, p);
    ctx.lineTo(boardPad + boardPx, p);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = palette.boxLine;
  ctx.lineWidth = Math.max(1.5, cellTrack * 0.022);
  [3, 6].forEach(line => {
    const p = Math.round(cellStart(line)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, boardPad + gridBorder);
    ctx.lineTo(p, boardPad + boardPx - gridBorder);
    ctx.moveTo(boardPad + gridBorder, p);
    ctx.lineTo(boardPad + boardPx - gridBorder, p);
    ctx.stroke();
  });
  ctx.restore();

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(cellTrack * 0.52)}px ${bodyStyle.fontFamily || 'system-ui, sans-serif'}`;
  for (let idx = 0; idx < 81; idx++) {
    const cell = game.cells[idx];
    if (cell.value === 0) continue;
    const row = (idx / 9) | 0;
    const col = idx % 9;
    ctx.fillStyle = cell.error && state.settings.showErrors
      ? palette.error
      : cell.given
        ? palette.given
        : palette.user;
    if (state.settings.showHighlights && idx === game.selectedCell) {
      ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'dark' ? '#f4f5ff' : '#1a1b2e';
    }
    ctx.fillText(String(cell.value), cellStart(col) + cellTrack / 2, cellStart(row) + cellTrack / 2 + cellTrack * 0.02);
  }
  ctx.restore();

}

function drawKillerSumGuides(
  game: GameState,
  cellStart: (line: number) => number,
  cellSpan: (count: number) => number,
  cellTrack: number,
): void {
  const canvas = el.sumCanvas;
  const boardPx = el.boardContainer.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(boardPx * dpr);
  canvas.height = Math.round(boardPx * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, boardPx, boardPx);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const peerFill = isDark ? 'rgba(129,140,248,0.18)' : 'rgba(99,102,241,0.14)';

  if (state.settings.showHighlights && game.selectedCell !== -1) {
    const sc = game.selectedCell % 9;
    const sr = (game.selectedCell / 9) | 0;
    ctx.save();
    ctx.fillStyle = peerFill;
    if (sc > 0) ctx.fillRect(cellStart(0), cellStart(sr), cellStart(sc) - cellStart(0), cellTrack);
    if (sc < 8) ctx.fillRect(cellStart(sc + 1), cellStart(sr), cellStart(0) + cellSpan(9) - cellStart(sc + 1), cellTrack);
    if (sr > 0) ctx.fillRect(cellStart(sc), cellStart(0), cellTrack, cellStart(sr) - cellStart(0));
    if (sr < 8) ctx.fillRect(cellStart(sc), cellStart(sr + 1), cellTrack, cellStart(0) + cellSpan(9) - cellStart(sr + 1));
    ctx.fillRect(cellStart(sc), cellStart(sr), cellTrack, cellTrack);
    ctx.restore();
  }

  // Draw memos in a compact centered block so killer cage labels stay clear.
  const bodyStyle = getComputedStyle(document.body);
  const memoColor = bodyStyle.getPropertyValue('--cell-memo').trim() || (isDark ? '#a5b4fc' : '#4f46e5');
  const memoBlock = cellTrack * 0.64;
  const memoPad = (cellTrack - memoBlock) / 2;
  const memoSlot = memoBlock / 3;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(memoSlot * 0.86)}px ${bodyStyle.fontFamily || 'system-ui, sans-serif'}`;
  for (let idx = 0; idx < 81; idx++) {
    const cell = game.cells[idx];
    if (cell.value !== 0 || cell.memos.length === 0) continue;
    const mRow = (idx / 9) | 0;
    const mCol = idx % 9;
    ctx.fillStyle = memoColor;
    for (const n of cell.memos) {
      const nr = ((n - 1) / 3) | 0;
      const nc = (n - 1) % 3;
      ctx.fillText(
        String(n),
        cellStart(mCol) + memoPad + (nc + 0.5) * memoSlot,
        cellStart(mRow) + memoPad + (nr + 0.5) * memoSlot,
      );
    }
  }
  ctx.restore();

  drawDragCageSumOverlay(game, ctx, cellStart, cellTrack, boardPx);
}

function drawDragCageSumOverlay(
  game: GameState,
  ctx: CanvasRenderingContext2D,
  cellStart: (line: number) => number,
  cellTrack: number,
  boardPx: number,
): void {
  const bounds = dragBounds();
  if (!bounds || !game.cages) return;

  const isInside = (pos: number): boolean => {
    const row = (pos / 9) | 0;
    const col = pos % 9;
    return row >= bounds.minRow && row <= bounds.maxRow && col >= bounds.minCol && col <= bounds.maxCol;
  };
  const included = game.cages.filter(cage => cage.cells.every(isInside));
  const includedIds = new Set(included.map(cage => cage.id));
  const sum = included.reduce((acc, cage) => acc + cage.sum, 0);
  const bodyStyle = getComputedStyle(document.body);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const accent = bodyStyle.getPropertyValue('--accent').trim() || '#6366f1';
  const distinctHighlightFills = isDark
    ? ['rgba(129,140,248,0.30)','rgba(244,114,182,0.30)','rgba(74,222,128,0.30)','rgba(251,191,36,0.30)','rgba(45,212,191,0.30)','rgba(192,132,252,0.30)']
    : ['rgba(99,102,241,0.28)','rgba(236,72,153,0.28)','rgba(34,197,94,0.28)','rgba(245,158,11,0.28)','rgba(20,184,166,0.28)','rgba(168,85,247,0.28)'];
  const distinctHighlightBorders = isDark
    ? ['rgba(129,140,248,0.85)','rgba(244,114,182,0.85)','rgba(74,222,128,0.85)','rgba(251,191,36,0.85)','rgba(45,212,191,0.85)','rgba(192,132,252,0.85)']
    : ['rgba(99,102,241,0.80)','rgba(236,72,153,0.80)','rgba(34,197,94,0.80)','rgba(217,119,6,0.82)','rgba(20,184,166,0.80)','rgba(168,85,247,0.80)'];
  const accentHighlightFill = isDark ? 'rgba(129,140,248,0.30)' : 'rgba(99,102,241,0.28)';
  const accentHighlightBorder = accent;
  const x = cellStart(bounds.minCol);
  const y = cellStart(bounds.minRow);
  const w = cellTrack * (bounds.maxCol - bounds.minCol + 1);
  const h = cellTrack * (bounds.maxRow - bounds.minRow + 1);

  ctx.save();
  ctx.fillStyle = isDark ? 'rgba(0,0,0,0.58)' : 'rgba(26,27,46,0.38)';
  game.cages.forEach(cage => {
    if (includedIds.has(cage.id)) return;
    cage.cells.forEach(pos => {
      const row = (pos / 9) | 0;
      const col = pos % 9;
      ctx.fillRect(cellStart(col), cellStart(row), cellTrack, cellTrack);
    });
  });

  ctx.lineWidth = Math.max(1, cellTrack * 0.022);
  included.forEach(cage => {
    const useAccent = state.settings.cageColorMode === 'accent';
    ctx.fillStyle = useAccent ? accentHighlightFill : distinctHighlightFills[cage.colorIndex];
    ctx.strokeStyle = useAccent ? accentHighlightBorder : distinctHighlightBorders[cage.colorIndex];
    cage.cells.forEach(pos => {
      const row = (pos / 9) | 0;
      const col = pos % 9;
      const cellX = cellStart(col);
      const cellY = cellStart(row);
      ctx.fillRect(cellX, cellY, cellTrack, cellTrack);
      ctx.strokeRect(cellX + 1, cellY + 1, cellTrack - 2, cellTrack - 2);
    });
  });

  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.42)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1.5, cellTrack * 0.026);
  ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);

  const label = String(sum);
  const fontSize = Math.max(18, Math.round(cellTrack * 0.42));
  ctx.font = `900 ${fontSize}px ${bodyStyle.fontFamily || 'system-ui, sans-serif'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelWidth = Math.ceil(ctx.measureText(label).width) + 26;
  const labelHeight = fontSize + 16;
  const labelX = Math.min(boardPx - labelWidth / 2 - 4, Math.max(labelWidth / 2 + 4, x + w / 2));
  const labelY = Math.min(boardPx - labelHeight / 2 - 4, y + h + labelHeight / 2 + 6);
  ctx.fillStyle = isDark ? 'rgba(15,15,26,0.98)' : 'rgba(255,255,255,0.98)';
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(labelX - labelWidth / 2, labelY - labelHeight / 2, labelWidth, labelHeight, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.fillText(label, labelX, labelY + 1);
  ctx.restore();
}

function renderCell(game: GameState, idx: number): void {
  const cellEl = el.cells[idx];
  if (!cellEl) return;
  const cell = game.cells[idx];

  // Class state
  cellEl.className = 'cell';

  const row = (idx / 9) | 0;
  const col = idx % 9;
  if (col === 2 || col === 5) cellEl.classList.add('box-border-right');
  if (row === 2 || row === 5) cellEl.classList.add('box-border-bottom');

  if (cell.given) cellEl.classList.add('given');
  else if (cell.value !== 0) cellEl.classList.add('user');
  if (cell.error && state.settings.showErrors) cellEl.classList.add('error', 'hl-error');

  // Highlight
  if (state.settings.showHighlights && game.selectedCell !== -1) {
    if (idx === game.selectedCell) {
      cellEl.classList.add('hl-selected');
    } else {
      const selRow = (game.selectedCell / 9) | 0;
      const selCol = game.selectedCell % 9;
      const selBox = getBoxIndex(game.selectedCell);
      if (row === selRow || col === selCol || getBoxIndex(idx) === selBox) {
        cellEl.classList.add('hl-peer');
      } else {
        const selVal = game.cells[game.selectedCell].value;
        if (selVal !== 0 && cell.value === selVal) {
          cellEl.classList.add('hl-sameval');
        }
      }
    }
  }

  // Content
  cellEl.innerHTML = '';
  if (cell.memos.length > 0 && cell.value === 0) {
    const memoGrid = document.createElement('div');
    memoGrid.className = 'cell-memos';
    for (let n = 1; n <= 9; n++) {
      const m = document.createElement('div');
      m.className = 'memo-num' + (cell.memos.includes(n) ? ' active' : '');
      m.textContent = cell.memos.includes(n) ? String(n) : '';
      memoGrid.appendChild(m);
    }
    cellEl.appendChild(memoGrid);
  } else if (cell.value !== 0) {
    const val = document.createElement('div');
    val.className = 'cell-value';
    val.textContent = String(cell.value);
    cellEl.appendChild(val);
  }
}

// ── Cell interaction ──────────────────────────────────────────────────────────

function onCellSelect(idx: number): void {
  const game = state.game;
  if (!game || game.completed) return;
  dragSum = null;

  haptic('light');

  if (game.selectedCell === idx) {
    // Deselect
    game.selectedCell = -1;
  } else {
    game.selectedCell = idx;
  }

  renderAllCells(game);
  updateKillerStats(game);
}

function onBoardPointerDown(e: PointerEvent): void {
  const game = state.game;
  if (!game || game.completed || state.screen !== 'game') return;
  const cell = cellFromPointerEvent(e);
  dragSum = { pointerId: e.pointerId, startCell: cell, currentCell: cell, active: false };
  el.boardGrid.setPointerCapture(e.pointerId);
}

function onBoardPointerMove(e: PointerEvent): void {
  const game = state.game;
  if (!game || !dragSum || dragSum.pointerId !== e.pointerId || !game.cages) return;
  const cell = cellFromPointerEvent(e);
  const moved = cell !== dragSum.startCell;
  if (!moved && !dragSum.active) return;
  e.preventDefault();
  dragSum = { ...dragSum, currentCell: cell, active: true };
  drawBoardCanvas(game);
}

function onBoardPointerUp(e: PointerEvent): void {
  const game = state.game;
  if (!game || !dragSum || dragSum.pointerId !== e.pointerId) return;
  const wasDrag = dragSum.active;
  const cell = cellFromPointerEvent(e);
  try {
    el.boardGrid.releasePointerCapture(e.pointerId);
  } catch {
    // Pointer capture may already be released by the browser.
  }

  if (wasDrag && game.cages) {
    dragSum = { ...dragSum, currentCell: cell, active: true, pointerId: -1 };
    drawBoardCanvas(game);
    haptic('light');
    return;
  }

  dragSum = null;
  onCellSelect(cell);
}

function onBoardPointerCancel(e: PointerEvent): void {
  const game = state.game;
  if (!dragSum || dragSum.pointerId !== e.pointerId) return;
  dragSum = null;
  if (game) drawBoardCanvas(game);
}

function snapshotGame(game: GameState): GameSnapshot {
  return {
    cells: game.cells.map(c => ({ ...c, memos: [...c.memos] })),
    hintCount: game.hintCount ?? 0,
    memoMode: game.memoMode,
    completed: game.completed,
  };
}

function pushUndo(game: GameState): void {
  undoStack.push(snapshotGame(game));
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
}

function pushRedo(game: GameState): void {
  redoStack.push(snapshotGame(game));
  if (redoStack.length > 50) redoStack.shift();
}

function restoreSnapshot(game: GameState, snapshot: GameSnapshot): GameState {
  return {
    ...game,
    cells: snapshot.cells.map(c => ({ ...c, memos: [...c.memos] })),
    hintCount: snapshot.hintCount,
    memoMode: snapshot.memoMode,
    completed: snapshot.completed,
  };
}

function renderRestoredGame(game: GameState): void {
  renderAllCells(game);
  updateNumpadCounts(game);
  updateMemoBtn(game);
  updateHintCount(game);
  updateKillerStats(game);

  if (game.completed) {
    showCompletion(game);
  } else {
    el.completeOverlay.classList.remove('visible');
    scheduleSave(game);
  }
}

function onNumInput(num: number): void {
  const game = state.game;
  if (!game || game.completed || game.selectedCell === -1) return;

  const cell = game.cells[game.selectedCell];
  if (cell.given) return;

  if (!game.memoMode && cell.value === num) { onErase(); return; }

  haptic('medium');

  pushUndo(game);

  const newGame = setCellValue(game, game.selectedCell, num, true);
  state.game = newGame;

  // Animate cell
  const cellEl = el.cells[game.selectedCell];
  cellEl.classList.remove('animate-place', 'animate-error');
  void cellEl.offsetWidth; // reflow
  if (newGame.cells[game.selectedCell].error && state.settings.showErrors) {
    cellEl.classList.add('animate-error');
  } else if (newGame.cells[game.selectedCell].value !== 0) {
    cellEl.classList.add('animate-place');
  }

  renderAllCells(newGame);
  updateNumpadCounts(newGame);
  updateKillerStats(newGame);
  scheduleSave(newGame);

  if (newGame.completed) {
    showCompletion(newGame);
  }
}

function onErase(): void {
  const game = state.game;
  if (!game || game.selectedCell === -1) return;
  const cell = game.cells[game.selectedCell];
  if (cell.given || (cell.value === 0 && cell.memos.length === 0)) return;

  haptic('light');
  pushUndo(game);

  const newGame = eraseCellValue(game, game.selectedCell);
  state.game = newGame;
  renderAllCells(newGame);
  updateNumpadCounts(newGame);
  updateKillerStats(newGame);
  scheduleSave(newGame);
}

function onUndo(): void {
  if (undoStack.length === 0) return;
  const game = state.game;
  if (!game) return;
  const prev = undoStack.pop()!;

  haptic('light');
  pushRedo(game);
  state.game = restoreSnapshot(game, prev);
  renderRestoredGame(state.game);
}

function onRedo(): void {
  if (redoStack.length === 0) return;
  const game = state.game;
  if (!game) return;
  const next = redoStack.pop()!;

  haptic('light');
  undoStack.push(snapshotGame(game));
  if (undoStack.length > 50) undoStack.shift();
  state.game = restoreSnapshot(game, next);
  renderRestoredGame(state.game);
}

function onHint(): void {
  const game = state.game;
  if (!game || game.selectedCell === -1) return;
  const cell = game.cells[game.selectedCell];
  if (cell.given || cell.value === game.solution[game.selectedCell]) return;

  haptic('medium');
  pushUndo(game);

  const correct = game.solution[game.selectedCell];
  // Turn off memo mode temporarily for hint
  const savedMemoMode = game.memoMode;
  state.game = { ...game, memoMode: false, hintCount: (game.hintCount ?? 0) + 1 };
  const newGame = setCellValue(state.game, game.selectedCell, correct, true);
  state.game = { ...newGame, memoMode: savedMemoMode };

  renderAllCells(state.game);
  updateNumpadCounts(state.game);
  updateHintCount(state.game);
  updateKillerStats(state.game);
  scheduleSave(state.game);

  if (state.game.completed) showCompletion(state.game);
}

function onToggleMemo(): void {
  const game = state.game;
  if (!game) return;
  state.game = { ...game, memoMode: !game.memoMode };
  updateMemoBtn(state.game);
  updateNumpadCounts(state.game);
  haptic('light');
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function updateNumpadCounts(game: GameState): void {
  const counts = new Array(10).fill(0);
  game.cells.forEach(c => { if (c.value > 0) counts[c.value]++; });

  el.numBtns.forEach(btn => {
    const n = parseInt(btn.dataset.num ?? '0');
    if (n < 1 || n > 9) return;
    const cnt = counts[n];
    const completed = cnt >= 9;
    btn.classList.toggle('completed', completed && !game.memoMode);
    const countEl = btn.querySelector('.num-count');
    if (countEl) countEl.textContent = completed ? '' : String(9 - cnt);
  });
}

function updateMemoBtn(game: GameState): void {
  el.btnMemo.classList.toggle('active', game.memoMode);
}

function updateHintCount(game: GameState): void {
  el.hintCount.textContent = String(game.hintCount ?? 0);
}

function updateHintButtonVisibility(): void {
  el.btnHint.hidden = !state.settings.showHintButton;
}

function updateKillerStats(game: GameState): void {
  if (game.cages) setupCageCanvas(game, getInnerBoardPx());
  drawBoardCanvas(game);
}

function bindPressButton(button: HTMLElement, handler: () => void): void {
  let lastPointerAt = 0;

  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    lastPointerAt = performance.now();
    handler();
  });

  button.addEventListener('click', (e) => {
    if (performance.now() - lastPointerAt < 500) {
      e.preventDefault();
      return;
    }
    handler();
  });
}

function showCompletion(game: GameState): void {
  stopTimer();
  removeSavedGame(game.id);

  const typeLabel = game.type === 'classic' ? '스도쿠' : '킬러 스도쿠';
  const diffLabel = difficultyLabel(game.difficulty);
  el.completeGameLabel.textContent = `${typeLabel} · ${diffLabel}`;
  el.completeTime.textContent = formatTime(game.elapsed);
  el.completeOverlay.classList.add('visible');
  haptic('success');
}

function scheduleSave(game: GameState): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => autoSave(game), 800);
}

function onCalcButton(action: string): void {
  if (action === 'clear') {
    clearCalculator();
  } else if (action === 'clear-entry') {
    clearCalculatorEntry();
  } else if (action === 'back') {
    backspaceCalculator();
  } else if (/^\d$/.test(action)) {
    appendCalculatorDigit(action);
  } else if (isCalculatorOperator(action)) {
    applyCalculatorOperator(action);
  } else if (action === '=') {
    finishCalculator();
  }
  renderCalculator();
}

function appendCalculatorDigit(digit: string): void {
  if (!calcEnteringNumber) {
    calcInputValue = '';
    calcEnteringNumber = true;
  }
  calcInputValue = calcInputValue === '0' ? digit : calcInputValue + digit;
}

function applyCalculatorPending(current: number): number {
  if (calcPendingOp === '+') return calcAccumulator + current;
  if (calcPendingOp === '-') return calcAccumulator - current;
  if (calcPendingOp === '*') return calcAccumulator * current;
  if (calcPendingOp === '/') return current === 0 ? NaN : calcAccumulator / current;
  return current;
}

function isCalculatorOperator(action: string): action is '+' | '-' | '*' | '/' {
  return action === '+' || action === '-' || action === '*' || action === '/';
}

function applyCalculatorOperator(op: '+' | '-' | '*' | '/'): void {
  if (!calcEnteringNumber && calcPendingOp !== null) {
    calcPendingOp = op;
    return;
  }

  const current = calcInputValue === '' ? calcAccumulator : Number(calcInputValue);
  calcAccumulator = applyCalculatorPending(current);

  calcPendingOp = op;
  calcInputValue = String(calcAccumulator);
  calcEnteringNumber = false;
}

function finishCalculator(): void {
  if (calcPendingOp === null) {
    calcEnteringNumber = false;
    return;
  }

  const current = calcInputValue === '' ? calcAccumulator : Number(calcInputValue);
  calcAccumulator = applyCalculatorPending(current);
  calcPendingOp = null;
  calcInputValue = String(calcAccumulator);
  calcEnteringNumber = false;
}

function backspaceCalculator(): void {
  if (!calcEnteringNumber) {
    clearCalculator();
    return;
  }
  calcInputValue = calcInputValue.slice(0, -1);
}

function onCalculatorKeydown(e: KeyboardEvent): void {
  const keyMap: Record<string, string> = {
    Enter: '=',
    '=': '=',
    '+': '+',
    '-': '-',
    '*': '*',
    '/': '/',
    x: '*',
    X: '*',
    Backspace: 'back',
    Delete: 'clear-entry',
    Escape: 'clear',
  };
  const action = /^\d$/.test(e.key) ? e.key : keyMap[e.key];
  if (!action) return;
  e.preventDefault();
  onCalcButton(action);
}

function clearCalculator(): void {
  calcAccumulator = 0;
  calcPendingOp = null;
  calcInputValue = '';
  calcEnteringNumber = true;
}

function clearCalculatorEntry(): void {
  calcInputValue = '';
  calcEnteringNumber = true;
}

function renderCalculator(): void {
  el.calcInput.value = calcInputValue || '0';
}

function updateCalculatorVisibility(): void {
  const pc = isPC();
  const landscape = isLandscape();
  const open = calcExpanded;

  el.btnCalc.classList.toggle('active', calcExpanded);
  el.btnCalc.setAttribute('aria-expanded', String(calcExpanded));

  if (pc) {
    document.documentElement.removeAttribute('data-calc-open');
    el.floatCalc.style.display = open ? 'block' : 'none';
    el.calcRow.classList.remove('collapsed');
    el.calcPad.classList.remove('collapsed');
  } else if (landscape) {
    // Side panel: collapse numpad to make room
    document.documentElement.toggleAttribute('data-calc-open', open);
    el.calcRow.classList.toggle('collapsed', !calcExpanded);
    el.calcPad.classList.toggle('collapsed', !calcExpanded);
  } else {
    // Mobile portrait: replace the numpad area so the controls remain visible.
    document.documentElement.toggleAttribute('data-calc-open', open);
    el.mobileCalcWrap.classList.toggle('open', open);
    el.calcRow.classList.remove('collapsed');
    el.calcPad.classList.remove('collapsed');
  }

}

function toggleCalculator(): void {
  calcExpanded = !calcExpanded;
  updateCalculatorVisibility();
  if (state.screen === 'game' && state.game) {
    requestAnimationFrame(() => renderBoard(state.game!));
  }
}

function setupFloatCalcDrag(): void {
  const header = document.getElementById('float-calc-header')!;
  let dragging = false;
  let ox = 0, oy = 0, ol = 0, ot = 0;

  header.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.float-calc-close')) return;
    dragging = true;
    const rect = el.floatCalc.getBoundingClientRect();
    ox = e.clientX; oy = e.clientY;
    ol = rect.left; ot = rect.top;
    el.floatCalc.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    el.floatCalc.style.left = (ol + e.clientX - ox) + 'px';
    el.floatCalc.style.top = (ot + e.clientY - oy) + 'px';
    el.floatCalc.style.right = 'auto';
    el.floatCalc.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    el.floatCalc.classList.remove('dragging');
  });

  document.getElementById('float-calc-close')?.addEventListener('click', () => {
    calcExpanded = false;
    updateCalculatorVisibility();
  });
}

// ── Haptics ───────────────────────────────────────────────────────────────────

function haptic(type: 'light' | 'medium' | 'success'): void {
  if (!state.settings.haptics) return;
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => void };
  if (!nav.vibrate) return;
  if (type === 'light')   nav.vibrate(8);
  if (type === 'medium')  nav.vibrate(15);
  if (type === 'success') nav.vibrate([20, 40, 20]);
}

// ── History screen ────────────────────────────────────────────────────────────

function renderHistory(): void {
  const history = loadHistory();
  state.history = history;
  const list = el.historyList;
  list.innerHTML = '';

  if (history.length === 0) {
    list.innerHTML = `
      <div class="history-empty">
        <div class="history-empty-icon">📋</div>
        <div>아직 플레이 기록이 없습니다</div>
      </div>`;
    return;
  }

  const savedIds = new Set(loadSavedGames().map(g => g.id));

  history.forEach(record => {
    const typeLabel = record.type === 'classic' ? '스도쿠' : '킬러 스도쿠';
    const diffLabel = difficultyLabel(record.difficulty);
    const icon = record.completed ? '✅' : '⏸';
    const hintText = record.completed ? ` · 힌트 ${record.hintCount ?? 0}` : '';
    const date = new Date(record.date);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
    const resumable = !record.completed && savedIds.has(record.id);

    const item = document.createElement('div');
    item.className = resumable ? 'history-item resumable' : 'history-item';
    item.innerHTML = `
      <div class="history-icon">${icon}</div>
      <div class="history-info">
        <h4>${typeLabel}</h4>
        <p>${diffLabel} · ${record.completed ? '완료' : '중단'}${hintText}</p>
      </div>
      <div class="history-meta">
        <div class="history-time">${formatTime(record.elapsed)}</div>
        <div class="history-date">${dateStr}</div>
      </div>
      ${resumable ? '<button class="history-resume-btn">이어하기</button>' : ''}
      <button class="history-delete-btn" aria-label="삭제">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>`;

    if (resumable) {
      item.querySelector('.history-resume-btn')!.addEventListener('click', (e) => {
        e.stopPropagation();
        const saved = loadSavedGames().find(g => g.id === record.id);
        if (saved) resumeGame(saved);
      });
    }

    item.querySelector('.history-delete-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      animateRemove(item, () => {
        removeHistoryRecord(record.id);
        item.remove();
        if (list.children.length === 0) renderHistory();
      });
    });

    list.appendChild(item);
  });
}

// ── Settings screen ───────────────────────────────────────────────────────────

function syncSettingsUI(): void {
  const s = state.settings;
  el.toggleErrors.checked     = s.showErrors;
  el.toggleHighlights.checked = s.showHighlights;
  el.toggleHintButton.checked = s.showHintButton;
  el.toggleHaptics.checked    = s.haptics;
  el.gridLineOpacity.value    = String(s.gridLineOpacity);
  el.boxLineOpacity.value     = String(s.boxLineOpacity);
  el.numpadLayoutBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === s.numpadLayout);
  });
  el.cageColorModeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cageColor === s.cageColorMode);
  });
  el.themeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === s.theme);
  });
  el.accentThemeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.accent === s.accentTheme);
  });
  applyAccentTheme(s.accentTheme);
  applyGridLineSettings();
  updateHintButtonVisibility();
}

function saveSettingsState(): void {
  saveSettings(state.settings);
}

// ── Resize handler ────────────────────────────────────────────────────────────

let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function syncViewportHeight(): void {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
}

function onResize(): void {
  syncViewportHeight();
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.screen === 'game' && state.game) {
      renderBoard(state.game);
    }
  }, 150);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

export function init(): void {
  el.appVersion.textContent = `Sudoku PWA ${__APP_VERSION__}`;
  syncViewportHeight();

  // Apply theme
  applyTheme(state.settings.theme);
  applyAccentTheme(state.settings.accentTheme);
  applyNumpadLayout(state.settings.numpadLayout);
  applyGridLineSettings();
  updateCalculatorVisibility();
  refreshMainFeatures();

  // System theme change
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'auto') applyTheme('auto');
  });

  // Screen navigation buttons
  document.getElementById('nav-to-history')?.addEventListener('click', () => navigate('history'));
  document.getElementById('nav-to-settings')?.addEventListener('click', openSettings);
  document.getElementById('back-from-history')?.addEventListener('click', () => navigate('menu', 'back'));
  document.getElementById('back-from-settings')?.addEventListener('click', closeSettings);
  document.getElementById('back-from-game')?.addEventListener('click', () => {
    stopTimer();
    if (state.game && !state.game.completed) {
      state.game = { ...state.game, elapsed: getElapsed(state.game), paused: true };
      autoSave(state.game);
      recordAbandonedGame(state.game);
    }
    navigate('menu', 'back');
  });
  document.getElementById('game-settings-btn')?.addEventListener('click', openSettings);

  // Menu
  el.typeClassic.addEventListener('click', () => selectType('classic'));
  el.typeKiller.addEventListener('click',  () => selectType('killer'));
  el.diffBtns.forEach(btn => {
    btn.addEventListener('click', () => selectDiff(btn.dataset.diff as Difficulty));
  });
  el.startBtn.addEventListener('click', startNewGame);

  // Numpad
  el.numBtns.forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const n = parseInt(btn.dataset.num ?? '0');
      if (n >= 1 && n <= 9) onNumInput(n);
    });
  });

  el.boardGrid.addEventListener('pointerdown', onBoardPointerDown);
  el.boardGrid.addEventListener('pointermove', onBoardPointerMove);
  el.boardGrid.addEventListener('pointerup', onBoardPointerUp);
  el.boardGrid.addEventListener('pointercancel', onBoardPointerCancel);

  // Controls
  bindPressButton(el.btnUndo, onUndo);
  bindPressButton(el.btnRedo, onRedo);
  bindPressButton(el.btnErase, onErase);
  bindPressButton(el.btnMemo, onToggleMemo);
  bindPressButton(el.btnHint, onHint);
  bindPressButton(el.btnCalc, toggleCalculator);
  el.calcInput.addEventListener('keydown', onCalculatorKeydown);
  document.querySelectorAll<HTMLButtonElement>('[data-calc]').forEach(btn => {
    bindPressButton(btn, () => onCalcButton(btn.dataset.calc ?? ''));
  });
  setupFloatCalcDrag();

  // Keyboard support
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (state.screen !== 'game') return;
    const key = e.key;
    if (key >= '1' && key <= '9') { onNumInput(parseInt(key)); return; }
    if (key === 'Backspace' || key === 'Delete' || key === '0' || key === 'e' || key === 'E') { onErase(); return; }
    if ((key === 'z' || key === 'Z') && (e.ctrlKey || e.metaKey) && e.shiftKey) { onRedo(); return; }
    if ((key === 'y' || key === 'Y') && (e.ctrlKey || e.metaKey)) { onRedo(); return; }
    if (key === 'z' && (e.ctrlKey || e.metaKey)) { onUndo(); return; }
    if ((key === 'u' || key === 'U') && !e.ctrlKey && !e.metaKey) { onUndo(); return; }
    if ((key === 'r' || key === 'R') && !e.ctrlKey && !e.metaKey) { onRedo(); return; }
    if (key === 'm' || key === 'M') { onToggleMemo(); return; }
    if (key === 'h' || key === 'H') { onHint(); return; }
    if (key === 'c' || key === 'C') { toggleCalculator(); return; }
    const game = state.game;
    if (!game) return;
    let next = game.selectedCell;
    if (key === 'ArrowRight') next = Math.min(80, next === -1 ? 0 : next + 1);
    if (key === 'ArrowLeft')  next = Math.max(0,  next === -1 ? 0 : next - 1);
    if (key === 'ArrowDown')  next = Math.min(80, next === -1 ? 0 : next + 9);
    if (key === 'ArrowUp')    next = Math.max(0,  next === -1 ? 0 : next - 9);
    if (next !== game.selectedCell) {
      state.game = { ...game, selectedCell: next };
      renderAllCells(state.game);
      updateKillerStats(state.game);
    }
  });

  // Complete overlay buttons
  document.getElementById('complete-new-game')?.addEventListener('click', () => {
    el.completeOverlay.classList.remove('visible');
    navigate('menu', 'back');
    setTimeout(() => startNewGame(), 400);
  });
  document.getElementById('complete-menu')?.addEventListener('click', () => {
    el.completeOverlay.classList.remove('visible');
    navigate('menu', 'back');
  });

  // Settings toggles
  el.toggleErrors.addEventListener('change', () => {
    state.settings = { ...state.settings, showErrors: el.toggleErrors.checked };
    saveSettingsState();
    if (state.game) renderAllCells(state.game);
  });
  el.toggleHighlights.addEventListener('change', () => {
    state.settings = { ...state.settings, showHighlights: el.toggleHighlights.checked };
    saveSettingsState();
    if (state.game) renderAllCells(state.game);
  });
  el.toggleHintButton.addEventListener('change', () => {
    state.settings = { ...state.settings, showHintButton: el.toggleHintButton.checked };
    saveSettingsState();
    updateHintButtonVisibility();
  });
  el.toggleHaptics.addEventListener('change', () => {
    state.settings = { ...state.settings, haptics: el.toggleHaptics.checked };
    saveSettingsState();
  });
  el.numpadLayoutBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const numpadLayout = btn.dataset.layout as NumpadLayout;
      state.settings = { ...state.settings, numpadLayout };
      saveSettingsState();
      applyNumpadLayout(numpadLayout);
      syncSettingsUI();
    });
  });
  el.cageColorModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const cageColorMode = btn.dataset.cageColor as CageColorMode;
      state.settings = { ...state.settings, cageColorMode };
      saveSettingsState();
      syncSettingsUI();
    });
  });
  el.gridLineOpacity.addEventListener('input', () => {
    state.settings = { ...state.settings, gridLineOpacity: Number(el.gridLineOpacity.value) };
    applyGridLineSettings();
    if (state.game && state.screen === 'game') renderAllCells(state.game);
  });
  el.gridLineOpacity.addEventListener('change', () => {
    saveSettingsState();
  });
  el.boxLineOpacity.addEventListener('input', () => {
    state.settings = { ...state.settings, boxLineOpacity: Number(el.boxLineOpacity.value) };
    applyGridLineSettings();
    if (state.game && state.screen === 'game') renderAllCells(state.game);
    if (state.screen === 'game' && state.game?.cages) setupCageCanvas(state.game, el.boardContainer.clientWidth);
  });
  el.boxLineOpacity.addEventListener('change', () => {
    saveSettingsState();
  });
  el.themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme as Theme;
      state.settings = { ...state.settings, theme };
      saveSettingsState();
      applyTheme(theme);
      syncSettingsUI();
      // Refresh cage canvas if in game
      if (state.screen === 'game' && state.game?.cages) {
        const boardPx = el.boardContainer.clientWidth;
        setupCageCanvas(state.game, boardPx);
      }
    });
  });
  el.accentThemeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const accentTheme = btn.dataset.accent as AccentTheme;
      state.settings = { ...state.settings, accentTheme };
      saveSettingsState();
      applyAccentTheme(accentTheme);
      syncSettingsUI();
      if (state.game && state.screen === 'game') renderAllCells(state.game);
      if (state.screen === 'game' && state.game?.cages) setupCageCanvas(state.game, el.boardContainer.clientWidth);
    });
  });

  // History clear
  document.getElementById('clear-history-btn')?.addEventListener('click', () => {
    void showConfirm('기록 삭제', '플레이 기록을 모두 삭제하시겠습니까?').then(ok => {
      if (ok) { clearHistory(); renderHistory(); }
    });
  });

  // Resize
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('scroll', onResize);

  // Prevent default scroll/zoom behaviors
  document.addEventListener('touchmove', (e) => {
    if (state.screen === 'settings') return;
    if (e.target instanceof HTMLInputElement && e.target.type === 'range') return;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());

  // Confirm dialog buttons
  el.confirmOk.addEventListener('click',     () => resolveConfirm(true));
  el.confirmCancel.addEventListener('click', () => resolveConfirm(false));
  el.confirmBackdrop.addEventListener('click', (e) => {
    if (e.target === el.confirmBackdrop) resolveConfirm(false);
  });

  // PWA / Android back-button support
  history.replaceState({ page: 'menu' }, '');
  window.addEventListener('popstate', () => {
    history.pushState({ page: state.screen }, '');
    // Close confirm dialog first if open
    if (confirmResolver) { resolveConfirm(false); return; }
    // Complete overlay
    if (el.completeOverlay.classList.contains('visible')) {
      el.completeOverlay.classList.remove('visible');
      navigate('menu', 'back');
      return;
    }
    if (state.screen === 'game') {
      stopTimer();
      if (state.game && !state.game.completed) {
        state.game = { ...state.game, elapsed: getElapsed(state.game), paused: true };
        autoSave(state.game);
        recordAbandonedGame(state.game);
      }
      navigate('menu', 'back');
    } else if (state.screen === 'settings') {
      closeSettings();
    } else if (state.screen === 'history') {
      navigate('menu', 'back');
    }
  });

  // Initial state
  selectType('classic');
  selectDiff('easy');
  renderMenuSavedGames();

  // Show initial screen
  screens.game.classList.add('hidden');
  screens.history.classList.add('hidden');
  screens.settings.classList.add('hidden');
}
