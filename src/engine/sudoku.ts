// Sudoku puzzle generation and solving engine

export type Grid = number[]; // 81 cells, 0 = empty
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface ClassicPuzzle {
  board: Grid;
  solution: Grid;
}

// --- Constraint helpers ---

function getRowIndices(row: number): number[] {
  const start = row * 9;
  return Array.from({ length: 9 }, (_, i) => start + i);
}

function getColIndices(col: number): number[] {
  return Array.from({ length: 9 }, (_, i) => i * 9 + col);
}

function getBoxIndices(row: number, col: number): number[] {
  const br = (row / 3 | 0) * 3;
  const bc = (col / 3 | 0) * 3;
  const result: number[] = [];
  for (let r = br; r < br + 3; r++)
    for (let c = bc; c < bc + 3; c++)
      result.push(r * 9 + c);
  return result;
}

export function getPeers(pos: number): number[] {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  const peers = new Set<number>([
    ...getRowIndices(row),
    ...getColIndices(col),
    ...getBoxIndices(row, col),
  ]);
  peers.delete(pos);
  return [...peers];
}

function getCandidates(grid: Grid, pos: number): number[] {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  const used = new Uint8Array(10);
  for (const p of getRowIndices(row)) used[grid[p]] = 1;
  for (const p of getColIndices(col)) used[grid[p]] = 1;
  for (const p of getBoxIndices(row, col)) used[grid[p]] = 1;
  const result: number[] = [];
  for (let n = 1; n <= 9; n++) if (!used[n]) result.push(n);
  return result;
}

// --- Backtracking solver (with MRV heuristic) ---

function solveInternal(grid: Grid, random: boolean, limit: number): number {
  // Find empty cell with minimum remaining values
  let pos = -1;
  let minCount = 10;

  for (let i = 0; i < 81; i++) {
    if (grid[i] !== 0) continue;
    const count = getCandidates(grid, i).length;
    if (count === 0) return 0;
    if (count < minCount) {
      minCount = count;
      pos = i;
      if (count === 1) break;
    }
  }

  if (pos === -1) return 1; // all filled → solved

  let candidates = getCandidates(grid, pos);
  if (random) shuffle(candidates);

  let solutions = 0;
  for (const n of candidates) {
    grid[pos] = n;
    solutions += solveInternal(grid, random, limit - solutions);
    if (solutions >= limit) break;
    grid[pos] = 0;
  }
  return solutions;
}

export function solve(grid: Grid): boolean {
  const copy = [...grid];
  if (solveInternal(copy, false, 1) === 1) {
    copy.forEach((v, i) => { grid[i] = v; });
    return true;
  }
  return false;
}

export function solveRandom(grid: Grid): boolean {
  return solveInternal(grid, true, 1) === 1;
}

export function countSolutions(grid: Grid, limit = 2): number {
  return solveInternal([...grid], false, limit);
}

// --- Utility ---

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Puzzle generation ---

const REMOVE_COUNT: Record<Difficulty, number> = {
  easy: 36,
  medium: 46,
  hard: 54,
};

export function generateClassicPuzzle(difficulty: Difficulty): ClassicPuzzle {
  // Step 1: generate a complete random solution
  const solution: Grid = new Array(81).fill(0);
  solveInternal(solution, true, 1);

  // Step 2: remove cells while keeping unique solution
  const board = [...solution];
  const positions = shuffle(Array.from({ length: 81 }, (_, i) => i));
  const target = REMOVE_COUNT[difficulty];
  let removed = 0;

  for (const pos of positions) {
    if (removed >= target) break;
    const backup = board[pos];
    board[pos] = 0;
    if (countSolutions(board, 2) === 1) {
      removed++;
    } else {
      board[pos] = backup;
    }
  }

  return { board, solution };
}

// --- Validation ---

export function isValidPlacement(board: Grid, pos: number, value: number): boolean {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  for (const p of getRowIndices(row)) if (board[p] === value) return false;
  for (const p of getColIndices(col)) if (board[p] === value) return false;
  for (const p of getBoxIndices(row, col)) if (board[p] === value) return false;
  return true;
}

export function getBoxIndex(pos: number): number {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  return ((row / 3) | 0) * 3 + ((col / 3) | 0);
}
