// Game state management

import type { GameState, CellState, GameType, Difficulty, HistoryRecord } from './types.ts';
import { saveGame, addHistory } from './storage.ts';
import type { Cage } from './engine/killer.ts';
import { getPeers, getBoxIndex } from './engine/sudoku.ts';

let timerInterval: ReturnType<typeof setInterval> | null = null;

export function createCells(board: number[]): CellState[] {
  return board.map((v) => ({
    value: v,
    given: v !== 0,
    memos: [],
    error: false,
  }));
}

export function createGame(
  type: GameType,
  difficulty: Difficulty,
  board: number[],
  solution: number[],
  cages?: Cage[],
): GameState {
  return {
    id: crypto.randomUUID(),
    type,
    difficulty,
    cells: createCells(board),
    solution,
    cages,
    selectedCell: -1,
    memoMode: false,
    startTime: Date.now(),
    elapsed: 0,
    completed: false,
    paused: false,
    hints: 0,
  };
}

export function startTimer(
  game: GameState,
  onTick: (elapsed: number) => void,
): void {
  stopTimer();
  if (game.completed || game.paused) return;

  const base = game.elapsed;
  const start = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = base + (Date.now() - start);
    onTick(elapsed);
  }, 500);
}

export function stopTimer(): void {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

export function getElapsed(game: GameState): number {
  if (game.completed || game.paused) return game.elapsed;
  return game.elapsed + (Date.now() - game.startTime);
}

export function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Build the set of cells that should have memo `value` removed
// when a confirmed value is placed at `pos`.
function buildMemoRemovalSet(game: GameState, pos: number, _value: number): Set<number> {
  const set = new Set<number>(getPeers(pos));
  // Also remove from cage mates (killer sudoku)
  if (game.cages) {
    const cage = game.cages.find(c => c.cells.includes(pos));
    if (cage) cage.cells.forEach(c => { if (c !== pos) set.add(c); });
  }
  return set;
}

export function setCellValue(game: GameState, pos: number, value: number): GameState {
  const cell = game.cells[pos];
  if (cell.given) return game;

  // ── Memo mode: toggle the memo digit on this cell only ──────────────────────
  if (game.memoMode && value !== 0) {
    const cells = game.cells.map((c, i) => {
      if (i !== pos) return c;
      const memos = c.memos.includes(value)
        ? c.memos.filter(m => m !== value)
        : [...c.memos, value].sort((a, b) => a - b);
      return { ...c, value: 0, memos, error: false };
    });
    return validateAndCheck({ ...game, cells });
  }

  // ── Confirm mode: place value, then remove it from peers' memos ─────────────
  const cells = game.cells.map((c, i) => {
    if (i !== pos) return c;
    return { ...c, value, memos: [], error: false };
  });

  if (value === 0) {
    return validateAndCheck({ ...game, cells });
  }

  // Remove `value` from memos in: same row + col + box + cage mates
  const removalSet = buildMemoRemovalSet(game, pos, value);
  const updatedCells = cells.map((c, i) => {
    if (!removalSet.has(i) || c.memos.length === 0) return c;
    const newMemos = c.memos.filter(m => m !== value);
    return newMemos.length !== c.memos.length ? { ...c, memos: newMemos } : c;
  });

  return validateAndCheck({ ...game, cells: updatedCells });
}

export function eraseCellValue(game: GameState, pos: number): GameState {
  const cell = game.cells[pos];
  if (cell.given) return game;

  const cells = game.cells.map((c, i) => {
    if (i !== pos) return c;
    if (c.memos.length > 0) return { ...c, memos: [] };
    return { ...c, value: 0, error: false };
  });

  return { ...game, cells };
}

export function validateAndCheck(game: GameState): GameState {
  const cells = game.cells.map((c, i) => {
    if (c.value === 0 || c.given) return { ...c, error: false };
    const correct = c.value === game.solution[i];
    return { ...c, error: !correct };
  });

  const completed = cells.every((c, i) => c.value === game.solution[i]);
  const elapsed = getElapsed(game);

  if (completed && !game.completed) {
    stopTimer();
    const record: HistoryRecord = {
      id: game.id,
      type: game.type,
      difficulty: game.difficulty,
      completed: true,
      elapsed,
      date: Date.now(),
      moves: 0,
      hints: game.hints,
    };
    addHistory(record);
  }

  return { ...game, cells, completed, elapsed: completed ? elapsed : game.elapsed };
}

export function getHighlightState(
  game: GameState,
  pos: number,
  showHighlights: boolean,
): 'selected' | 'peer' | 'same-value' | 'none' {
  if (!showHighlights) return 'none';
  const selected = game.selectedCell;
  if (pos === selected) return 'selected';
  if (selected === -1) return 'none';

  const selRow = (selected / 9) | 0;
  const selCol = selected % 9;
  const selBox = getBoxIndex(selected);

  const row = (pos / 9) | 0;
  const col = pos % 9;
  const box = getBoxIndex(pos);

  const isPeer = row === selRow || col === selCol || box === selBox;
  if (isPeer) return 'peer';

  const selValue = game.cells[selected].value;
  if (selValue !== 0 && game.cells[pos].value === selValue) return 'same-value';

  return 'none';
}

export function autoSave(game: GameState): void {
  const toSave = { ...game, elapsed: getElapsed(game) };
  saveGame(toSave);
}
