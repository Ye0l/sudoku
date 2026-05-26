// Main application controller

import type { AppState, GameState, GameType, Difficulty, Screen, Theme, CellState, CachedPuzzle, HistoryRecord } from './types.ts';
import {
  loadGame, saveGame, loadHistory, loadSettings, saveSettings, clearHistory,
  takeCachedPuzzle, addCachedPuzzle, countCachedPuzzles, addHistory,
} from './storage.ts';
import {
  createGame, setCellValue, eraseCellValue, autoSave,
  startTimer, stopTimer, formatTime, getElapsed,
} from './game.ts';
import { getBoxIndex } from './engine/sudoku.ts';
import * as nightlyModule from './nightly.ts';

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
let pendingWorker: Worker | null = null;
const cacheFillInProgress = new Set<string>();
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let confirmResolver: ((ok: boolean) => void) | null = null;

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
  diffBtns:      document.querySelectorAll<HTMLButtonElement>('.diff-btn'),
  startBtn:      document.getElementById('start-btn')!,
  resumeCard:    document.getElementById('resume-card')!,

  // Game
  timer:         document.getElementById('timer')!,
  gameInfo:      document.getElementById('game-info')!,
  boardGrid:     document.getElementById('board-grid')!,
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
  btnErase:      document.getElementById('btn-erase')!,
  btnMemo:       document.getElementById('btn-memo')!,
  btnHint:       document.getElementById('btn-hint')!,

  // History
  historyList:   document.getElementById('history-list')!,

  // Settings
  toggleErrors:    document.getElementById('toggle-errors') as HTMLInputElement,
  toggleHighlights:document.getElementById('toggle-highlights') as HTMLInputElement,
  toggleHaptics:   document.getElementById('toggle-haptics') as HTMLInputElement,
  toggleNightly:   document.getElementById('toggle-nightly') as HTMLInputElement,
  themeBtns:       document.querySelectorAll<HTMLButtonElement>('.theme-btn'),
};

const undoStack: { cells: CellState[] }[] = [];
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
    renderMenuResumeCard();
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
  };
  addHistory(record);
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
}

// ── Menu ──────────────────────────────────────────────────────────────────────

function renderMenuResumeCard(): void {
  const saved = loadGame();
  if (saved && !saved.completed) {
    el.resumeCard.classList.remove('hidden');
    const typeLabel = saved.type === 'classic' ? '스도쿠' : '킬러 스도쿠';
    const diffLabel = { easy: '쉬움', medium: '보통', hard: '어려움' }[saved.difficulty];
    el.resumeCard.querySelector('.resume-info h4')!.textContent = `${typeLabel} · ${diffLabel}`;
    el.resumeCard.querySelector('.resume-info p')!.textContent = '진행 중인 게임을 이어서 하기';
    el.resumeCard.querySelector('.resume-time')!.textContent = formatTime(getElapsed(saved));
  } else {
    el.resumeCard.classList.add('hidden');
  }
}

function selectType(type: GameType): void {
  selectedType = type;
  el.typeClassic.classList.toggle('active', type === 'classic');
  el.typeKiller.classList.toggle('active', type === 'killer');
  fillPuzzleCache(selectedType, selectedDiff);
}

function selectDiff(diff: Difficulty): void {
  selectedDiff = diff;
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
  const id = crypto.randomUUID();

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
    const id = crypto.randomUUID();

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

  // Set temporary header before puzzle is ready
  const typeLabel = selectedType === 'classic' ? '스도쿠' : '킬러 스도쿠';
  const diffLabel = { easy: '쉬움', medium: '보통', hard: '어려움' }[selectedDiff];
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

function resumeGame(): void {
  const saved = loadGame();
  if (!saved || saved.completed) return;
  state.game = saved;
  undoStack.length = 0;
  updateGameHeader(saved);
  navigate('game');
  requestAnimationFrame(() => {
    renderBoard(saved);
    beginTimer();
  });
}

function updateGameHeader(game: GameState): void {
  const typeLabel = game.type === 'classic' ? '스도쿠' : '킬러 스도쿠';
  const diffLabel = { easy: '쉬움', medium: '보통', hard: '어려움' }[game.difficulty];
  el.gameInfo.textContent = `${typeLabel} · ${diffLabel}`;
}

function showLoading(show: boolean): void {
  el.loadingOverlay.classList.toggle('hidden', !show);
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function beginTimer(): void {
  const game = state.game;
  if (!game) return;
  // Reset startTime to now (elapsed already stored)
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

function updateLayoutMode(): void {
  const landscape = isLandscape();
  const side = document.getElementById('game-side')!;
  const numpad = document.querySelector('.numpad') as HTMLElement;
  const controls = document.querySelector('.controls-bar') as HTMLElement;
  const statusBar = document.querySelector('.game-status') as HTMLElement;

  if (landscape) {
    side.style.display = 'flex';
    // Move numpad and controls into side panel
    side.appendChild(numpad);
    side.appendChild(controls);
    statusBar.style.display = 'none';
  } else {
    const gameScreen = document.getElementById('screen-game')!;
    side.style.display = 'none';
    statusBar.style.display = '';
    // Move back to main flow
    if (numpad.parentElement !== gameScreen) gameScreen.appendChild(numpad);
    if (controls.parentElement !== gameScreen) {
      // Insert before numpad
      gameScreen.insertBefore(controls, numpad);
    }
  }
}

function renderBoard(game: GameState): void {
  const container = el.boardContainer;
  const grid      = el.boardGrid;

  updateLayoutMode();

  // Measure .board-area (grandparent of board-grid), not board-container.
  // board-container has no CSS dimensions so its clientWidth/Height is 0.
  const area     = el.boardGrid.parentElement!.parentElement!;
  const maxSize  = Math.min(area.clientWidth - 16, area.clientHeight - 16) - 4;
  const size     = Math.max(200, maxSize);
  const cellSize = Math.floor(size / 9);
  const boardPx  = cellSize * 9;

  container.style.width  = boardPx + 'px';
  container.style.height = boardPx + 'px';
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

    // Touch/click
    cellEl.addEventListener('pointerdown', () => onCellSelect(i), { passive: true });

    grid.appendChild(cellEl);
    el.cells.push(cellEl);
  }

  // Killer: prepare cage overlay
  if (game.cages) {
    setupCageCanvas(game, boardPx);
  } else {
    el.cageCanvas.style.display = 'none';
    el.cageLineCanvas.style.display = 'none';
    document.querySelectorAll('.cage-sum-label').forEach(e => e.remove());
  }

  renderAllCells(game);
  updateNumpadCounts(game);
  updateMemoBtn(game);
}

function setupCageCanvas(game: GameState, boardPx: number): void {
  const canvas = el.cageCanvas;
  const lineCanvas = el.cageLineCanvas;
  const canvasPad = 0;
  const canvasPx = boardPx + canvasPad * 2;
  const gridStyle = getComputedStyle(el.boardGrid);
  const gridBorder = parseFloat(gridStyle.borderLeftWidth) || 0;
  const gridGap = parseFloat(gridStyle.columnGap) || 0;
  const cellTrack = (boardPx - gridBorder * 2 - gridGap * 8) / 9;
  const dpr = window.devicePixelRatio || 1;
  [canvas, lineCanvas].forEach(c => {
    c.style.display = 'block';
    c.width  = Math.round(canvasPx * dpr);
    c.height = Math.round(canvasPx * dpr);
    c.style.left = -canvasPad + 'px';
    c.style.top = -canvasPad + 'px';
    c.style.right = 'auto';
    c.style.bottom = 'auto';
    c.style.width  = canvasPx + 'px';
    c.style.height = canvasPx + 'px';
  });

  document.querySelectorAll('.cage-sum-label').forEach(e => e.remove());

  const ctx = canvas.getContext('2d')!;
  const lineCtx = lineCanvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lineCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvasPx, canvasPx);
  lineCtx.clearRect(0, 0, canvasPx, canvasPx);

  const cages   = game.cages!;
  const isDark  = document.documentElement.getAttribute('data-theme') === 'dark';

  const CAGE_FILLS = isDark
    ? ['oklch(74% 0.15 275 / 0.12)','oklch(74% 0.17 350 / 0.12)','oklch(78% 0.16 145 / 0.12)','oklch(82% 0.14 85 / 0.12)','oklch(78% 0.12 190 / 0.12)','oklch(74% 0.16 305 / 0.12)']
    : ['oklch(58% 0.20 275 / 0.16)','oklch(62% 0.22 350 / 0.16)','oklch(70% 0.18 145 / 0.16)','oklch(78% 0.16 85 / 0.16)','oklch(72% 0.14 190 / 0.16)','oklch(63% 0.20 305 / 0.16)'];

  const CAGE_BORDERS = isDark
    ? ['oklch(74% 0.15 275 / 0.68)','oklch(74% 0.17 350 / 0.68)','oklch(78% 0.16 145 / 0.68)','oklch(82% 0.14 85 / 0.68)','oklch(78% 0.12 190 / 0.68)','oklch(74% 0.16 305 / 0.68)']
    : ['oklch(58% 0.20 275 / 0.62)','oklch(62% 0.22 350 / 0.62)','oklch(70% 0.18 145 / 0.62)','oklch(78% 0.16 85 / 0.68)','oklch(72% 0.14 190 / 0.62)','oklch(63% 0.20 305 / 0.62)'];
  const BOX_GRID = isDark ? 'oklch(96% 0.01 275 / 0.15)' : 'oklch(18% 0.01 275 / 0.13)';

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

  const strokeCageOutline = (cellSet: Set<number>): void => {
    const cornerDots: [number, number][] = [];
    lineCtx.beginPath();
    traceBoundaryLoops(cellSet).forEach(loop => {
      const vertices = simplifyLoopVertices(loop.map(edge => edge.start));
      if (vertices.length < 2) return;
      vertices.forEach((point, i) => {
        const prev = vertices[(i - 1 + vertices.length) % vertices.length];
        const next = vertices[(i + 1) % vertices.length];
        const [x, y] = insetPoint(prev, point, next);
        cornerDots.push([x, y]);
        if (i === 0) lineCtx.moveTo(x, y);
        else lineCtx.lineTo(x, y);
      });
      lineCtx.closePath();
    });
    lineCtx.stroke();

    lineCtx.save();
    lineCtx.setLineDash([]);
    cornerDots.forEach(([x, y]) => {
      lineCtx.beginPath();
      lineCtx.arc(x, y, lineCtx.lineWidth * 0.55, 0, Math.PI * 2);
      lineCtx.fill();
    });
    lineCtx.restore();
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
  lineCtx.lineCap = 'round';
  lineCtx.lineJoin = 'round';
  lineCtx.lineWidth = Math.max(1.5, cellTrack * 0.035);
  lineCtx.setLineDash([Math.max(1.5, cellTrack * 0.055), Math.max(3, cellTrack * 0.07)]);
  lineCtx.shadowBlur = 0;
  lineCtx.shadowColor = 'transparent';
  strokeBoxGrid();

  cages.forEach(cage => {
    lineCtx.strokeStyle = CAGE_BORDERS[cage.colorIndex];
    lineCtx.fillStyle = CAGE_BORDERS[cage.colorIndex];
    strokeCageOutline(new Set(cage.cells));
  });

  lineCtx.save();
  lineCtx.globalCompositeOperation = 'destination-out';
  lineCtx.beginPath();
  cages.forEach(cage => {
    const labelCell = getLabelCell(cage);
    const { x, y, w, h } = labelBounds(cage.sum, labelCell);
    roundedRect(x, y, w, h, labelRadius);
  });
  lineCtx.fill();
  lineCtx.restore();

  cages.forEach(cage => {
    const labelCell = getLabelCell(cage);
    const row = (labelCell / 9) | 0;
    const col = labelCell % 9;
    const x = cellStartCoord(col);
    const y = cellStartCoord(row);
    const label = document.createElement('div');
    label.className = 'cage-sum-label';
    label.textContent = String(cage.sum);
    label.style.fontSize = labelFontSize + 'px';
    label.style.left = (x + cageInset + 1) + 'px';
    label.style.top  = (y + cageInset - 4) + 'px';
    el.boardContainer.appendChild(label);
  });
}

function renderAllCells(game: GameState): void {
  for (let i = 0; i < 81; i++) {
    renderCell(game, i);
  }
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

  haptic('light');

  if (game.selectedCell === idx) {
    // Deselect
    game.selectedCell = -1;
  } else {
    game.selectedCell = idx;
  }

  renderAllCells(game);
}

function onNumInput(num: number): void {
  const game = state.game;
  if (!game || game.completed || game.selectedCell === -1) return;

  const cell = game.cells[game.selectedCell];
  if (cell.given) return;

  haptic('medium');

  // Push undo state
  undoStack.push({ cells: game.cells.map(c => ({ ...c, memos: [...c.memos] })) });
  if (undoStack.length > 50) undoStack.shift();

  const newGame = setCellValue(game, game.selectedCell, num);
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
  undoStack.push({ cells: game.cells.map(c => ({ ...c, memos: [...c.memos] })) });

  const newGame = eraseCellValue(game, game.selectedCell);
  state.game = newGame;
  renderAllCells(newGame);
  updateNumpadCounts(newGame);
  scheduleSave(newGame);
}

function onUndo(): void {
  if (undoStack.length === 0) return;
  const prev = undoStack.pop()!;
  const game = state.game;
  if (!game) return;

  haptic('light');
  state.game = { ...game, cells: prev.cells };
  renderAllCells(state.game);
  updateNumpadCounts(state.game);
  scheduleSave(state.game);
}

function onHint(): void {
  const game = state.game;
  if (!game || game.selectedCell === -1) return;
  const cell = game.cells[game.selectedCell];
  if (cell.given || cell.value === game.solution[game.selectedCell]) return;

  haptic('medium');
  undoStack.push({ cells: game.cells.map(c => ({ ...c, memos: [...c.memos] })) });

  const correct = game.solution[game.selectedCell];
  // Turn off memo mode temporarily for hint
  const savedMemoMode = game.memoMode;
  state.game = { ...game, memoMode: false };
  const newGame = setCellValue(state.game, game.selectedCell, correct);
  state.game = { ...newGame, memoMode: savedMemoMode };

  renderAllCells(state.game);
  updateNumpadCounts(state.game);
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

function showCompletion(game: GameState): void {
  stopTimer();
  saveGame(null); // clear saved game

  const typeLabel = game.type === 'classic' ? '스도쿠' : '킬러 스도쿠';
  const diffLabel = { easy: '쉬움', medium: '보통', hard: '어려움' }[game.difficulty];
  el.completeGameLabel.textContent = `${typeLabel} · ${diffLabel}`;
  el.completeTime.textContent = formatTime(game.elapsed);
  el.completeOverlay.classList.add('visible');
  haptic('success');
}

function scheduleSave(game: GameState): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => autoSave(game), 800);
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

  history.forEach(record => {
    const typeLabel = record.type === 'classic' ? '스도쿠' : '킬러 스도쿠';
    const diffLabel = { easy: '쉬움', medium: '보통', hard: '어려움' }[record.difficulty];
    const icon = record.completed ? '✅' : '⏸';
    const date = new Date(record.date);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;

    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-icon">${icon}</div>
      <div class="history-info">
        <h4>${typeLabel}</h4>
        <p>${diffLabel} · ${record.completed ? '완료' : '중단'}</p>
      </div>
      <div class="history-meta">
        <div class="history-time">${formatTime(record.elapsed)}</div>
        <div class="history-date">${dateStr}</div>
      </div>`;
    list.appendChild(item);
  });
}

// ── Settings screen ───────────────────────────────────────────────────────────

function syncSettingsUI(): void {
  const s = state.settings;
  el.toggleErrors.checked     = s.showErrors;
  el.toggleHighlights.checked = s.showHighlights;
  el.toggleHaptics.checked    = s.haptics;
  el.toggleNightly.checked    = s.nightly || nightlyModule.isActive();
  el.themeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === s.theme);
  });
}

function saveSettingsState(): void {
  saveSettings(state.settings);
}

// ── Resize handler ────────────────────────────────────────────────────────────

let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function onResize(): void {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.screen === 'game' && state.game) {
      renderBoard(state.game);
    }
  }, 150);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

export function init(): void {
  // Apply theme
  applyTheme(state.settings.theme);

  // Nightly mode – activate if saved in settings OR if ?nightly is in the URL
  const urlNightly = new URLSearchParams(location.search).has('nightly');
  if (state.settings.nightly || urlNightly) {
    nightlyModule.activate();
    // URL-only activation is session-scoped; don't persist it automatically
  }

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
  el.resumeCard.addEventListener('click', resumeGame);

  // Numpad
  el.numBtns.forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const n = parseInt(btn.dataset.num ?? '0');
      if (n >= 1 && n <= 9) onNumInput(n);
    });
  });

  // Controls
  el.btnUndo.addEventListener('click',  onUndo);
  el.btnErase.addEventListener('click', onErase);
  el.btnMemo.addEventListener('click',  onToggleMemo);
  el.btnHint.addEventListener('click',  onHint);

  // Keyboard support
  document.addEventListener('keydown', (e) => {
    if (state.screen !== 'game') return;
    const key = e.key;
    if (key >= '1' && key <= '9') { onNumInput(parseInt(key)); return; }
    if (key === 'Backspace' || key === 'Delete' || key === '0') { onErase(); return; }
    if (key === 'z' && (e.ctrlKey || e.metaKey)) { onUndo(); return; }
    if (key === 'm' || key === 'M') { onToggleMemo(); return; }
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
  el.toggleHaptics.addEventListener('change', () => {
    state.settings = { ...state.settings, haptics: el.toggleHaptics.checked };
    saveSettingsState();
  });
  el.toggleNightly.addEventListener('change', () => {
    const on = el.toggleNightly.checked;
    state.settings = { ...state.settings, nightly: on };
    saveSettingsState();
    if (on) nightlyModule.activate();
    else    nightlyModule.deactivate();
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

  // History clear
  document.getElementById('clear-history-btn')?.addEventListener('click', () => {
    void showConfirm('기록 삭제', '플레이 기록을 모두 삭제하시겠습니까?').then(ok => {
      if (ok) { clearHistory(); renderHistory(); }
    });
  });

  // Resize
  window.addEventListener('resize', onResize);

  // Prevent default scroll/zoom behaviors
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
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
  renderMenuResumeCard();

  // Show initial screen
  screens.game.classList.add('hidden');
  screens.history.classList.add('hidden');
  screens.settings.classList.add('hidden');
}
