// Killer Sudoku cage generation engine

import { type Grid, type Difficulty, shuffle, solveRandom } from './sudoku.ts';

export interface Cage {
  id: number;
  cells: number[]; // cell indices (0-80)
  sum: number;
  colorIndex: number; // 0-5 for display
}

export interface KillerPuzzle {
  board: Grid;
  solution: Grid;
  cages: Cage[];
}

export interface CageBorders {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
  cageId: number;
  isTopLeft: boolean;
}

function getAdjacent(pos: number): number[] {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  const result: number[] = [];
  if (row > 0) result.push(pos - 9);
  if (row < 8) result.push(pos + 9);
  if (col > 0) result.push(pos - 1);
  if (col < 8) result.push(pos + 1);
  return result;
}

const CAGE_SIZE_AVG: Record<Difficulty, number> = {
  easy: 3,
  medium: 3,
  hard: 2,
};

function chooseCageSize(difficulty: Difficulty): number {
  const avg = CAGE_SIZE_AVG[difficulty];
  const r = Math.random();
  if (r < 0.1) return 1;
  if (r < 0.3) return 2;
  if (r < 0.7) return avg;
  if (r < 0.9) return avg + 1;
  return Math.min(avg + 2, 5);
}

function generateCages(solution: Grid, difficulty: Difficulty): Cage[] {
  const assigned = new Int32Array(81).fill(-1);
  const cages: Cage[] = [];
  let cageId = 0;

  const order = shuffle(Array.from({ length: 81 }, (_, i) => i));

  for (const start of order) {
    if (assigned[start] !== -1) continue;

    const targetSize = chooseCageSize(difficulty);
    const cells: number[] = [start];
    assigned[start] = cageId;

    const frontier: number[] = [];
    getAdjacent(start).forEach(p => {
      if (assigned[p] === -1 && !frontier.includes(p)) frontier.push(p);
    });
    shuffle(frontier);

    while (cells.length < targetSize && frontier.length > 0) {
      const idx = Math.floor(Math.random() * frontier.length);
      const next = frontier.splice(idx, 1)[0];
      if (assigned[next] !== -1) continue;

      // Cage digits must be unique
      const cageVals = cells.map(c => solution[c]);
      if (cageVals.includes(solution[next])) continue;

      // Max sum constraint (max possible sum for n digits = 9+8+...+(9-n+1))
      const newSum = cageVals.reduce((a, b) => a + b, 0) + solution[next];
      const newSize = cells.length + 1;
      const maxPossible = Array.from({ length: newSize }, (_, i) => 9 - i).reduce((a, b) => a + b, 0);
      if (newSum > maxPossible) continue;

      cells.push(next);
      assigned[next] = cageId;

      getAdjacent(next).forEach(p => {
        if (assigned[p] === -1 && !frontier.includes(p)) frontier.push(p);
      });
    }

    const sum = cells.reduce((acc, c) => acc + solution[c], 0);
    cages.push({ id: cageId, cells, sum, colorIndex: 0 });
    cageId++;
  }

  assignCageColors(cages);
  return cages;
}

function assignCageColors(cages: Cage[]): void {
  const cellToCage = new Int32Array(81).fill(-1);
  cages.forEach(cage => cage.cells.forEach(c => { cellToCage[c] = cage.id; }));

  cages.forEach(cage => {
    const usedColors = new Set<number>();
    cage.cells.forEach(cell => {
      getAdjacent(cell).forEach(adj => {
        const adjCageId = cellToCage[adj];
        if (adjCageId !== -1 && adjCageId !== cage.id) {
          usedColors.add(cages[adjCageId]?.colorIndex ?? -1);
        }
      });
    });
    for (let c = 0; c < 6; c++) {
      if (!usedColors.has(c)) { cage.colorIndex = c; break; }
    }
  });
}

export function generateKillerPuzzle(difficulty: Difficulty): KillerPuzzle {
  const solution: Grid = new Array(81).fill(0);
  solveRandom(solution);

  let cages: Cage[] = [];
  let attempts = 0;
  do {
    cages = generateCages(solution, difficulty);
    attempts++;
  } while (cages.length < 10 && attempts < 10);

  return {
    board: new Array(81).fill(0),
    solution,
    cages,
  };
}

export function computeCageBorders(cages: Cage[], totalCells = 81): CageBorders[] {
  const cellToCage = new Int32Array(totalCells).fill(-1);
  cages.forEach(cage => cage.cells.forEach(c => { cellToCage[c] = cage.id; }));

  return Array.from({ length: totalCells }, (_, pos) => {
    const row = (pos / 9) | 0;
    const col = pos % 9;
    const cageId = cellToCage[pos];

    const top    = row === 0 || cellToCage[pos - 9] !== cageId;
    const bottom = row === 8 || cellToCage[pos + 9] !== cageId;
    const left   = col === 0 || cellToCage[pos - 1] !== cageId;
    const right  = col === 8 || cellToCage[pos + 1] !== cageId;

    const cage = cages.find(c => c.id === cageId);
    const isTopLeft = cage ? cage.cells[0] === pos : false;

    return { top, right, bottom, left, cageId, isTopLeft };
  });
}
