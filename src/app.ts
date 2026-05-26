// Main application controller

import type { AppState, GameState, GameType, Difficulty, Screen, Theme, CellState } from './types.ts';
import { loadGame, saveGame, loadHistory, loadSettings, saveSettings, clearHistory } from './storage.ts';
import {
  createGame, setCellValue, eraseCellValue, autoSave,
  startTimer, stopTimer, formatTime, getElapsed,
} from './game.ts';
import { getBoxIndex } from './engine/sudoku.ts';
import { computeCageBorders } from './engine/killer.ts';

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
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

// Calculator state
interface CalcState {
  expr: string;
  result: string; // shown after = press
  active: boolean;
}
const calc: CalcState = { expr: '', result: '', active: false };

// Undo stack records full cell state + hint count before each move
const undoStack: { cells: CellState[]; hints: number }[] = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────

const screens = {
  menu:     document.getElementById('screen-menu')!,
  game:     document.getElementById('screen-game')!,
  history:  document.getElementById('screen-history')!,
  settings: document.getElementById('screen-settings')!,
};

const el = {
  typeClassic:    document.getElementById('type-classic')!,
  typeKiller:     document.getElementById('type-killer')!,
  diffBtns:       document.querySelectorAll<HTMLButtonElement>('.diff-btn'),
  startBtn:       document.getElementById('start-btn')!,
  resumeCard:     document.getElementById('resume-card')!,

  timer:          document.getElementById('timer')!,
  gameInfo:       document.getElementById('game-info')!,
  boardGrid:      document.getElementById('board-grid')!,
  boardContainer: document.getElementById('board-container')!,
  cageCanvas:     document.getElementById('cage-canvas') as HTMLCanvasElement,
  loadingOverlay: document.getElementById('loading-overlay')!,
  completeOverlay:document.getElementById('complete-overlay')!,
  completeTime:   document.getElementById('complete-time')!,
  completeHints:  document.getElementById('complete-hints')!,
  cells:          [] as HTMLElement[],

  sideTimer:      document.getElementById('side-timer'),

  numBtns:        document.querySelectorAll<HTMLButtonElement>('.num-btn'),

  btnUndo:        document.getElementById('btn-undo')!,
  btnErase:       document.getElementById('btn-erase')!,
  btnMemo:        document.getElementById('btn-memo')!,
  btnHint:        document.getElementById('btn-hint')!,
  btnCalc:        document.getElementById('btn-calc')!,
  hintBadge:      document.getElementById('hint-badge')!,

  calcBar:        document.getElementById('calc-bar')!,
  calcDisplay:    document.getElementById('calc-display')!,

  historyList:    document.getElementById('history-list')!,

  toggleErrors:   document.getElementById('toggle-errors') as HTMLInputElement,
  toggleHighlights: document.getElementById('toggle-highlights') as HTMLInputElement,
  toggleHaptics:  document.getElementById('toggle-haptics') as HTMLInputElement,
  themeBtns:      document.querySelectorAll<HTMLButtonElement>('.theme-btn'),
};

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

  toEl.classList.remove('hidden');
  toEl.classList.add(enterClass);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toEl.classList.remove(enterClass);
      fromEl.classList.add(exitClass);

      const cleanup = () => {
        fromEl.classList.remove(exitClass);
        fromEl.classList.add('hidden');
        state.screen = to;
        onScreenEnter(to);
      };
      toEl.addEventListener('transitionend', cleanup, { once: true });
    });
  });
}

function onScreenEnter(screen: Screen): void {
  if (screen === 'menu')     renderMenuResumeCard();
  else if (screen === 'history')  renderHistory();
  else if (screen === 'settings') syncSettingsUI();
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') {
    root.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
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
  el.typeKiller.classList.toggle('active',  type === 'killer');
}

function selectDiff(diff: Difficulty): void {
  selectedDiff = diff;
  el.diffBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.diff === diff));
}

// ── Puzzle worker ─────────────────────────────────────────────────────────────

function generatePuzzle(type: GameType, diff: Difficulty): Promise<GameState> {
  return new Promise((resolve, reject) => {
    if (pendingWorker) { pendingWorker.terminate(); pendingWorker = null; }

    const worker = createPuzzleWorker();
    pendingWorker = worker;
    const id = crypto.randomUUID();

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      worker.terminate();
      pendingWorker = null;

      if (e.data.type === 'error') { reject(new Error(e.data.message as string)); return; }

      const puzzle = e.data.puzzle;
      resolve(createGame(type, diff, puzzle.board, puzzle.solution, puzzle.cages));
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
  undoStack.length = 0;

  const typeLabel = selectedType === 'classic' ? '스도쿠' : '킬러 스도쿠';
  const diffLabel = { easy: '쉬움', medium: '보통', hard: '어려움' }[selectedDiff];
  el.gameInfo.textContent = `${typeLabel} · ${diffLabel}`;
  el.timer.textContent = '00:00';

  navigate('game');
  await new Promise(r => setTimeout(r, 80));
  showLoading(true);

  try {
    const game = await generatePuzzle(selectedType, selectedDiff);
    state.game = game;
    saveGame(game);
    calcClose();
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
  // Migrate old saves without hints field
  state.game = saved.hints !== undefined ? saved : { ...saved, hints: 0 };
  undoStack.length = 0;
  updateGameHeader(state.game);
  calcClose();
  navigate('game');
  requestAnimationFrame(() => {
    renderBoard(state.game!);
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
  game.startTime = Date.now();
  startTimer(game, (elapsed) => {
    const t = formatTime(elapsed);
    el.timer.textContent = t;
    if (el.sideTimer) el.sideTimer.textContent = t;
  });
}

// ── Board rendering ───────────────────────────────────────────────────────────

let cageBordersCache: ReturnType<typeof computeCageBorders> | null = null;

function isLandscape(): boolean {
  return window.innerWidth > window.innerHeight && window.innerWidth >= 600;
}

function updateLayoutMode(): void {
  const landscape = isLandscape();
  const side     = document.getElementById('game-side')!;
  const numpad   = document.querySelector('.numpad') as HTMLElement;
  const controls = document.querySelector('.controls-bar') as HTMLElement;
  const calcBar  = el.calcBar;
  const statusBar = document.querySelector('.game-status') as HTMLElement;

  if (landscape) {
    side.style.display = 'flex';
    side.appendChild(controls);
    side.appendChild(calcBar);
    side.appendChild(numpad);
    statusBar.style.display = 'none';
  } else {
    const gameScreen = document.getElementById('screen-game')!;
    side.style.display = 'none';
    statusBar.style.display = '';
    if (controls.parentElement !== gameScreen) gameScreen.insertBefore(controls, calcBar);
    if (calcBar.parentElement !== gameScreen) gameScreen.insertBefore(calcBar, numpad);
    if (numpad.parentElement !== gameScreen)  gameScreen.appendChild(numpad);
  }
}

function renderBoard(game: GameState): void {
  updateLayoutMode();

  const area     = el.boardGrid.parentElement!;
  const maxSize  = Math.min(area.clientWidth, area.clientHeight) - 4;
  const size     = Math.max(200, maxSize);
  const cellSize = Math.floor(size / 9);
  const boardPx  = cellSize * 9;

  el.boardContainer.style.width  = boardPx + 'px';
  el.boardContainer.style.height = boardPx + 'px';
  document.documentElement.style.setProperty('--cell-size', cellSize + 'px');

  el.boardGrid.innerHTML = '';
  el.cells = [];
  cageBordersCache = game.cages ? computeCageBorders(game.cages) : null;

  for (let i = 0; i < 81; i++) {
    const cellEl = document.createElement('div');
    cellEl.className = 'cell';
    cellEl.dataset.idx = String(i);

    const row = (i / 9) | 0;
    const col = i % 9;
    if (col === 2 || col === 5) cellEl.classList.add('box-border-right');
    if (row === 2 || row === 5) cellEl.classList.add('box-border-bottom');

    cellEl.addEventListener('pointerdown', () => onCellSelect(i), { passive: true });
    el.boardGrid.appendChild(cellEl);
    el.cells.push(cellEl);
  }

  if (game.cages) {
    setupCageCanvas(game, boardPx, cellSize);
  } else {
    el.cageCanvas.style.display = 'none';
    document.querySelectorAll('.cage-sum-label').forEach(e => e.remove());
  }

  renderAllCells(game);
  updateNumpadCounts(game);
  updateMemoBtn(game);
  updateHintBadge(game);
}

function setupCageCanvas(game: GameState, boardPx: number, cellSize: number): void {
  const canvas = el.cageCanvas;
  canvas.style.display = 'block';
  canvas.width  = boardPx;
  canvas.height = boardPx;
  canvas.style.width  = boardPx + 'px';
  canvas.style.height = boardPx + 'px';

  document.querySelectorAll('.cage-sum-label').forEach(e => e.remove());

  const ctx    = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, boardPx, boardPx);

  const borders = cageBordersCache!;
  const cages   = game.cages!;
  const isDark  = document.documentElement.getAttribute('data-theme') === 'dark';

  const CAGE_COLORS = isDark
    ? ['rgba(129,140,248,0.55)','rgba(244,114,182,0.55)','rgba(74,222,128,0.55)','rgba(251,191,36,0.55)','rgba(45,212,191,0.55)','rgba(192,132,252,0.55)']
    : ['rgba(99,102,241,0.6)','rgba(236,72,153,0.6)','rgba(34,197,94,0.6)','rgba(245,158,11,0.6)','rgba(20,184,166,0.6)','rgba(168,85,247,0.6)'];
  const CAGE_FILLS = isDark
    ? ['rgba(129,140,248,0.10)','rgba(244,114,182,0.10)','rgba(74,222,128,0.10)','rgba(251,191,36,0.10)','rgba(45,212,191,0.10)','rgba(192,132,252,0.10)']
    : ['rgba(99,102,241,0.06)','rgba(236,72,153,0.06)','rgba(34,197,94,0.06)','rgba(245,158,11,0.06)','rgba(20,184,166,0.06)','rgba(168,85,247,0.06)'];

  cages.forEach(cage => {
    ctx.fillStyle = CAGE_FILLS[cage.colorIndex];
    cage.cells.forEach(pos => {
      const r = (pos / 9) | 0, c = pos % 9;
      ctx.fillRect(c * cellSize + 2, r * cellSize + 2, cellSize - 4, cellSize - 4);
    });
  });

  ctx.lineCap = 'round';
  ctx.setLineDash([3, 2]);
  ctx.lineWidth = 1.5;

  borders.forEach((b, pos) => {
    const r = (pos / 9) | 0, c = pos % 9;
    const x = c * cellSize, y = r * cellSize;
    const cage = cages[b.cageId];
    if (!cage) return;

    ctx.strokeStyle = CAGE_COLORS[cage.colorIndex];
    ctx.beginPath();
    if (b.top)    { ctx.moveTo(x + 3,           y + 1.5);           ctx.lineTo(x + cellSize - 3, y + 1.5); }
    if (b.bottom) { ctx.moveTo(x + 3,           y + cellSize - 1.5); ctx.lineTo(x + cellSize - 3, y + cellSize - 1.5); }
    if (b.left)   { ctx.moveTo(x + 1.5,         y + 3);             ctx.lineTo(x + 1.5,           y + cellSize - 3); }
    if (b.right)  { ctx.moveTo(x + cellSize - 1.5, y + 3);          ctx.lineTo(x + cellSize - 1.5, y + cellSize - 3); }
    ctx.stroke();

    if (b.isTopLeft) {
      const label = document.createElement('div');
      label.className = 'cage-sum-label';
      label.textContent = String(cage.sum);
      label.style.left = (x + 3) + 'px';
      label.style.top  = (y + 3) + 'px';
      el.boardContainer.appendChild(label);
    }
  });
}

function renderAllCells(game: GameState): void {
  for (let i = 0; i < 81; i++) renderCell(game, i);
}

function renderCell(game: GameState, idx: number): void {
  const cellEl = el.cells[idx];
  if (!cellEl) return;
  const cell = game.cells[idx];

  cellEl.className = 'cell';

  const row = (idx / 9) | 0;
  const col = idx % 9;
  if (col === 2 || col === 5) cellEl.classList.add('box-border-right');
  if (row === 2 || row === 5) cellEl.classList.add('box-border-bottom');

  if (cell.given) cellEl.classList.add('given');
  else if (cell.value !== 0) cellEl.classList.add('user');
  if (cell.error && state.settings.showErrors) cellEl.classList.add('error', 'hl-error');

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
        if (selVal !== 0 && cell.value === selVal) cellEl.classList.add('hl-sameval');
      }
    }
  }

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
  game.selectedCell = game.selectedCell === idx ? -1 : idx;
  renderAllCells(game);
}

function onNumInput(num: number): void {
  // Route to calculator when active
  if (calc.active) {
    calcInput(String(num));
    return;
  }

  const game = state.game;
  if (!game || game.completed || game.selectedCell === -1) return;
  if (game.cells[game.selectedCell].given) return;

  haptic('medium');

  pushUndo(game);

  const newGame = setCellValue(game, game.selectedCell, num);
  state.game = newGame;

  const cellEl = el.cells[game.selectedCell];
  cellEl.classList.remove('animate-place', 'animate-error');
  void cellEl.offsetWidth;
  if (newGame.cells[game.selectedCell].error && state.settings.showErrors) {
    cellEl.classList.add('animate-error');
  } else if (newGame.cells[game.selectedCell].value !== 0 && !newGame.memoMode) {
    cellEl.classList.add('animate-place');
  }

  renderAllCells(newGame);
  updateNumpadCounts(newGame);
  scheduleSave(newGame);

  if (newGame.completed) showCompletion(newGame);
}

function onErase(): void {
  if (calc.active) { calcClear(); return; }

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
  scheduleSave(newGame);
}

function onUndo(): void {
  if (calc.active) { calcBackspace(); return; }

  if (undoStack.length === 0) return;
  const prev = undoStack.pop()!;
  const game = state.game;
  if (!game) return;

  haptic('light');
  state.game = { ...game, cells: prev.cells, hints: prev.hints };
  renderAllCells(state.game);
  updateNumpadCounts(state.game);
  updateHintBadge(state.game);
  scheduleSave(state.game);
}

function onHint(): void {
  const game = state.game;
  if (!game || game.selectedCell === -1) return;
  const cell = game.cells[game.selectedCell];
  if (cell.given || cell.value === game.solution[game.selectedCell]) return;

  haptic('medium');
  pushUndo(game);

  const correct = game.solution[game.selectedCell];
  const savedMemoMode = game.memoMode;
  state.game = { ...game, memoMode: false };
  const newGame = setCellValue(state.game, game.selectedCell, correct);
  state.game = { ...newGame, memoMode: savedMemoMode, hints: game.hints + 1 };

  renderAllCells(state.game);
  updateNumpadCounts(state.game);
  updateHintBadge(state.game);
  scheduleSave(state.game);

  if (state.game.completed) showCompletion(state.game);
}

function onToggleMemo(): void {
  const game = state.game;
  if (!game) return;
  state.game = { ...game, memoMode: !game.memoMode };
  updateMemoBtn(state.game);
  haptic('light');
}

// ── Undo helpers ──────────────────────────────────────────────────────────────

function pushUndo(game: GameState): void {
  undoStack.push({
    cells: game.cells.map(c => ({ ...c, memos: [...c.memos] })),
    hints: game.hints,
  });
  if (undoStack.length > 50) undoStack.shift();
}

// ── Calculator ────────────────────────────────────────────────────────────────

function calcOpen(): void {
  calc.active = true;
  calc.expr   = '';
  calc.result = '';
  el.calcBar.classList.remove('hidden', 'calc-closing');
  el.calcBar.classList.add('calc-open');
  el.btnCalc.classList.add('active');
  renderCalc();
}

function calcClose(): void {
  calc.active = false;
  el.calcBar.classList.remove('calc-open');
  el.calcBar.classList.add('calc-closing');
  el.btnCalc.classList.remove('active');
  setTimeout(() => {
    el.calcBar.classList.remove('calc-closing');
    el.calcBar.classList.add('hidden');
  }, 260);
}

function calcToggle(): void {
  calc.active ? calcClose() : calcOpen();
}

function calcInput(ch: string): void {
  // If showing a result and user types a digit, start fresh
  if (calc.result && /\d/.test(ch)) {
    calc.expr   = ch;
    calc.result = '';
  } else if (calc.result && /[+\-×÷]/.test(ch)) {
    // Continue from result
    calc.expr   = calc.result + ch;
    calc.result = '';
  } else {
    calc.expr += ch;
  }
  renderCalc();
}

function calcEval(): void {
  if (!calc.expr) return;
  try {
    // Replace × and ÷ with js operators, then safe-eval using Function
    const safe = calc.expr.replace(/×/g, '*').replace(/÷/g, '/');
    // Only allow digits and operators
    if (!/^[\d+\-*/.\s]+$/.test(safe)) { calc.result = 'ERR'; renderCalc(); return; }
    const result = Function('"use strict"; return (' + safe + ')')() as number;
    calc.result = Number.isFinite(result) ? String(Math.round(result * 1000) / 1000) : 'ERR';
    calc.expr   = '';
  } catch {
    calc.result = 'ERR';
  }
  renderCalc();
}

function calcClear(): void {
  calc.expr   = '';
  calc.result = '';
  renderCalc();
}

function calcBackspace(): void {
  if (calc.result) { calc.result = ''; calc.expr = calc.expr.slice(0, -1); }
  else             { calc.expr = calc.expr.slice(0, -1); }
  renderCalc();
}

function renderCalc(): void {
  const display = calc.result
    ? `<span class="calc-result">${calc.result}</span>`
    : `<span class="calc-expr">${calc.expr || '<span class="calc-placeholder">계산기</span>'}</span>`;
  el.calcDisplay.innerHTML = display;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function updateNumpadCounts(game: GameState): void {
  const counts = new Array(10).fill(0);
  game.cells.forEach(c => { if (c.value > 0) counts[c.value]++; });

  el.numBtns.forEach(btn => {
    const n = parseInt(btn.dataset.num ?? '0');
    if (n < 1 || n > 9) return;
    const cnt = counts[n];
    const done = cnt >= 9;
    btn.classList.toggle('completed', done);
    const countEl = btn.querySelector('.num-count');
    if (countEl) countEl.textContent = done ? '' : String(9 - cnt);
  });
}

function updateMemoBtn(game: GameState): void {
  el.btnMemo.classList.toggle('active', game.memoMode);
  el.btnMemo.setAttribute('aria-pressed', String(game.memoMode));
}

function updateHintBadge(game: GameState): void {
  el.hintBadge.textContent = game.hints > 0 ? String(game.hints) : '';
  el.hintBadge.classList.toggle('visible', game.hints > 0);
}

function showCompletion(game: GameState): void {
  stopTimer();
  saveGame(null);

  el.completeTime.textContent  = formatTime(game.elapsed);
  el.completeHints.textContent = game.hints > 0 ? `힌트 ${game.hints}회 사용` : '힌트 없이 클리어!';
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
    const icon      = record.completed ? '✅' : '⏸';
    const date      = new Date(record.date);
    const dateStr   = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
    const hints     = (record.hints ?? 0);
    const hintStr   = hints > 0 ? ` · 힌트 ${hints}` : '';

    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-icon">${icon}</div>
      <div class="history-info">
        <h4>${typeLabel}</h4>
        <p>${diffLabel} · ${record.completed ? '완료' : '중단'}${hintStr}</p>
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
  el.themeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.theme === s.theme));
}

function saveSettingsState(): void {
  saveSettings(state.settings);
}

// ── Resize handler ────────────────────────────────────────────────────────────

let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function onResize(): void {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.screen === 'game' && state.game) renderBoard(state.game);
  }, 150);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

export function init(): void {
  applyTheme(state.settings.theme);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'auto') applyTheme('auto');
  });

  // Navigation
  document.getElementById('nav-to-history')?.addEventListener('click', () => navigate('history'));
  document.getElementById('nav-to-settings')?.addEventListener('click', () => navigate('settings', 'fade'));
  document.getElementById('back-from-history')?.addEventListener('click', () => navigate('menu', 'back'));
  document.getElementById('back-from-settings')?.addEventListener('click', () => navigate('menu', 'back'));
  document.getElementById('back-from-game')?.addEventListener('click', () => {
    stopTimer();
    calcClose();
    if (state.game) autoSave(state.game);
    navigate('menu', 'back');
  });
  document.getElementById('game-settings-btn')?.addEventListener('click', () => navigate('settings', 'fade'));

  // Menu
  el.typeClassic.addEventListener('click', () => selectType('classic'));
  el.typeKiller.addEventListener('click',  () => selectType('killer'));
  el.diffBtns.forEach(btn => btn.addEventListener('click', () => selectDiff(btn.dataset.diff as Difficulty)));
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
  el.btnCalc.addEventListener('click',  calcToggle);

  // Calculator operation buttons
  document.querySelectorAll<HTMLButtonElement>('.calc-op-btn').forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const op = btn.dataset.op!;
      if (op === '=')   calcEval();
      else if (op === 'C')   calcClear();
      else if (op === '⌫')  calcBackspace();
      else calcInput(op);
    });
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (state.screen !== 'game') return;

    // Calculator keyboard
    if (calc.active) {
      if (e.key >= '1' && e.key <= '9') { calcInput(e.key); return; }
      if (e.key === '+') { calcInput('+'); return; }
      if (e.key === '-') { calcInput('-'); return; }
      if (e.key === '*') { calcInput('×'); return; }
      if (e.key === '/') { e.preventDefault(); calcInput('÷'); return; }
      if (e.key === '=' || e.key === 'Enter') { calcEval(); return; }
      if (e.key === 'Backspace') { calcBackspace(); return; }
      if (e.key === 'Escape') { calcClose(); return; }
      return;
    }

    const key = e.key;
    if (key >= '1' && key <= '9') { onNumInput(parseInt(key)); return; }
    if (key === 'Backspace' || key === 'Delete' || key === '0') { onErase(); return; }
    if (key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onUndo(); return; }
    if (key === 'm' || key === 'M') { onToggleMemo(); return; }
    if (key === 'c' || key === 'C') { calcToggle(); return; }

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

  // Complete overlay
  document.getElementById('complete-new-game')?.addEventListener('click', () => {
    el.completeOverlay.classList.remove('visible');
    navigate('menu', 'back');
    setTimeout(() => startNewGame(), 400);
  });
  document.getElementById('complete-menu')?.addEventListener('click', () => {
    el.completeOverlay.classList.remove('visible');
    navigate('menu', 'back');
  });

  // Settings
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
  el.themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme as Theme;
      state.settings = { ...state.settings, theme };
      saveSettingsState();
      applyTheme(theme);
      syncSettingsUI();
      if (state.screen === 'game' && state.game?.cages) {
        const boardPx  = el.boardContainer.clientWidth;
        const cellSize = Math.floor(boardPx / 9);
        setupCageCanvas(state.game, boardPx, cellSize);
      }
    });
  });

  document.getElementById('clear-history-btn')?.addEventListener('click', () => {
    if (confirm('플레이 기록을 모두 삭제하시겠습니까?')) {
      clearHistory();
      renderHistory();
    }
  });

  window.addEventListener('resize', onResize);

  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());

  selectType('classic');
  selectDiff('easy');
  renderMenuResumeCard();

  screens.game.classList.add('hidden');
  screens.history.classList.add('hidden');
  screens.settings.classList.add('hidden');
}
