// Killer Sudoku generation engine

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

type Technique = 'singlePossibility' | 'nakedSingle' | 'cageSumElimination' | 'inniesOuties' | 'nakedHiddenPairTriple';

interface DifficultyReport {
  solved: boolean;
  score: number;
  maxLevel: number;
  steps: number;
  usage: Record<Technique, number>;
}

interface CageSizeProfile {
  sizes: Array<{ size: number; weight: number }>;
  maxSize: number;
  maxSingles: number;
}

const ALL_DIGITS_MASK = 0b1111111110;
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const TECHNIQUE_LEVEL: Record<Technique, number> = {
  singlePossibility: 1,
  nakedSingle: 1,
  cageSumElimination: 2,
  inniesOuties: 2,
  nakedHiddenPairTriple: 3,
};
const TECHNIQUE_WEIGHT: Record<Technique, number> = {
  singlePossibility: 1,
  nakedSingle: 1,
  cageSumElimination: 2,
  inniesOuties: 3,
  nakedHiddenPairTriple: 4,
};

const TARGETS: Record<Difficulty, { min: number; max: number; maxLevel: number }> = {
  easy: { min: 0, max: 45, maxLevel: 2 },
  medium: { min: 31, max: 85, maxLevel: 2 },
  hard: { min: 71, max: 140, maxLevel: 3 },
};

const CAGE_SIZE_PROFILES: Record<Difficulty, CageSizeProfile> = {
  easy: {
    sizes: [
      { size: 1, weight: 8 },
      { size: 2, weight: 52 },
      { size: 3, weight: 34 },
      { size: 4, weight: 6 },
    ],
    maxSize: 4,
    maxSingles: 5,
  },
  medium: {
    sizes: [
      { size: 1, weight: 3 },
      { size: 2, weight: 25 },
      { size: 3, weight: 44 },
      { size: 4, weight: 22 },
      { size: 5, weight: 6 },
    ],
    maxSize: 5,
    maxSingles: 2,
  },
  hard: {
    sizes: [
      { size: 2, weight: 8 },
      { size: 3, weight: 24 },
      { size: 4, weight: 38 },
      { size: 5, weight: 22 },
      { size: 6, weight: 8 },
    ],
    maxSize: 6,
    maxSingles: 1,
  },
};

const UNITS: number[][] = [
  ...Array.from({ length: 9 }, (_, row) => Array.from({ length: 9 }, (_, col) => row * 9 + col)),
  ...Array.from({ length: 9 }, (_, col) => Array.from({ length: 9 }, (_, row) => row * 9 + col)),
  ...Array.from({ length: 9 }, (_, box) => {
    const row0 = ((box / 3) | 0) * 3;
    const col0 = (box % 3) * 3;
    const cells: number[] = [];
    for (let row = row0; row < row0 + 3; row++) {
      for (let col = col0; col < col0 + 3; col++) cells.push(row * 9 + col);
    }
    return cells;
  }),
];

const BOX_OF = Array.from({ length: 81 }, (_, pos) => {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  return ((row / 3) | 0) * 3 + ((col / 3) | 0);
});

const PEERS: number[][] = Array.from({ length: 81 }, (_, pos) => {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  const box = BOX_OF[pos];
  const peers = new Set<number>();
  for (const p of UNITS[row]) peers.add(p);
  for (const p of UNITS[9 + col]) peers.add(p);
  for (const p of UNITS[18 + box]) peers.add(p);
  peers.delete(pos);
  return [...peers];
});

const COMBO_CACHE = new Map<string, number[]>();
const SUBSET_SUM_CACHE = new Map<string, boolean>();

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

function bitCount(mask: number): number {
  let count = 0;
  while (mask) {
    mask &= mask - 1;
    count++;
  }
  return count;
}

function maskForDigit(digit: number): number {
  return 1 << digit;
}

function singleDigit(mask: number): number {
  for (const digit of DIGITS) {
    if (mask === maskForDigit(digit)) return digit;
  }
  return 0;
}

function chooseWeighted(options: Array<{ size: number; weight: number }>): number {
  const total = options.reduce((acc, option) => acc + option.weight, 0);
  let roll = Math.random() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll <= 0) return option.size;
  }
  return options[options.length - 1].size;
}

function normalizeCageIds(cages: Cage[]): void {
  cages.forEach((cage, id) => {
    cage.id = id;
    cage.cells.sort((a, b) => a - b);
  });
}

function getDigitCombinations(size: number, sum: number): number[] {
  const key = `${size}:${sum}`;
  const cached = COMBO_CACHE.get(key);
  if (cached) return cached;

  const result: number[] = [];
  const walk = (digit: number, left: number, remaining: number, mask: number): void => {
    if (left === 0) {
      if (remaining === 0) result.push(mask);
      return;
    }
    for (let next = digit; next <= 9; next++) {
      if (next > remaining) break;
      walk(next + 1, left - 1, remaining - next, mask | maskForDigit(next));
    }
  };

  walk(1, size, sum, 0);
  COMBO_CACHE.set(key, result);
  return result;
}

function hasSubsetSum(mask: number, size: number, sum: number): boolean {
  const key = `${mask}:${size}:${sum}`;
  const cached = SUBSET_SUM_CACHE.get(key);
  if (cached !== undefined) return cached;
  if (size === 0) return sum === 0;
  if (sum <= 0 || bitCount(mask) < size) return false;

  for (const digit of DIGITS) {
    const bit = maskForDigit(digit);
    if (!(mask & bit)) continue;
    if (hasSubsetSum(mask & ~bit, size - 1, sum - digit)) {
      SUBSET_SUM_CACHE.set(key, true);
      return true;
    }
  }
  SUBSET_SUM_CACHE.set(key, false);
  return false;
}

function canAssignCombo(cells: number[], masks: number[], comboMask: number, forcedCell = -1, forcedDigit = 0): boolean {
  const ordered = [...cells].sort((a, b) => bitCount(masks[a] & comboMask) - bitCount(masks[b] & comboMask));

  const search = (index: number, usedMask: number): boolean => {
    if (index === ordered.length) return usedMask === comboMask;
    const cell = ordered[index];
    let allowed = masks[cell] & comboMask & ~usedMask;
    if (cell === forcedCell) allowed &= maskForDigit(forcedDigit);
    if (!allowed) return false;

    for (const digit of DIGITS) {
      const bit = maskForDigit(digit);
      if ((allowed & bit) && search(index + 1, usedMask | bit)) return true;
    }
    return false;
  };

  return search(0, 0);
}

function cagesByCell(cages: Cage[]): Int32Array {
  const result = new Int32Array(81).fill(-1);
  cages.forEach((cage, cageIndex) => cage.cells.forEach(cell => { result[cell] = cageIndex; }));
  return result;
}

function applyMask(masks: number[], cell: number, allowed: number): boolean {
  const next = masks[cell] & allowed;
  if (next === 0 || next === masks[cell]) return false;
  masks[cell] = next;
  return true;
}

function applySinglePossibility(masks: number[]): boolean {
  let changed = false;
  for (let pos = 0; pos < 81; pos++) {
    const digit = singleDigit(masks[pos]);
    if (!digit) continue;
    const bit = maskForDigit(digit);
    for (const peer of PEERS[pos]) {
      if (bitCount(masks[peer]) > 1) changed = applyMask(masks, peer, ~bit) || changed;
    }
  }
  return changed;
}

function applyNakedSingle(masks: number[]): boolean {
  let changed = false;
  for (const unit of UNITS) {
    for (const digit of DIGITS) {
      const bit = maskForDigit(digit);
      const places = unit.filter(pos => masks[pos] & bit);
      if (places.length === 1 && masks[places[0]] !== bit) {
        masks[places[0]] = bit;
        changed = true;
      }
    }
  }
  return changed;
}

function applyCageSumElimination(masks: number[], cages: Cage[]): boolean {
  let changed = false;
  for (const cage of cages) {
    const combos = getDigitCombinations(cage.cells.length, cage.sum).filter(combo => canAssignCombo(cage.cells, masks, combo));
    if (combos.length === 0) continue;

    for (const cell of cage.cells) {
      let allowed = 0;
      for (const combo of combos) {
        for (const digit of DIGITS) {
          const bit = maskForDigit(digit);
          if ((combo & bit) && (masks[cell] & bit) && canAssignCombo(cage.cells, masks, combo, cell, digit)) {
            allowed |= bit;
          }
        }
      }
      changed = applyMask(masks, cell, allowed) || changed;
    }
  }
  return changed;
}

function applyGroupSum(masks: number[], cells: number[], sum: number): boolean {
  if (cells.length === 0 || cells.length > 5) return false;
  const combos = getDigitCombinations(cells.length, sum).filter(combo => canAssignCombo(cells, masks, combo));
  if (combos.length === 0) return false;

  let changed = false;
  for (const cell of cells) {
    let allowed = 0;
    for (const combo of combos) {
      for (const digit of DIGITS) {
        const bit = maskForDigit(digit);
        if ((combo & bit) && (masks[cell] & bit) && canAssignCombo(cells, masks, combo, cell, digit)) {
          allowed |= bit;
        }
      }
    }
    changed = applyMask(masks, cell, allowed) || changed;
  }
  return changed;
}

function applyInniesOuties(masks: number[], cages: Cage[]): boolean {
  let changed = false;
  for (const unit of UNITS) {
    let fixedSum = 0;
    const innies: number[] = [];

    for (const cage of cages) {
      const inside = cage.cells.filter(cell => unit.includes(cell));
      if (inside.length === 0) continue;
      if (inside.length === cage.cells.length) {
        fixedSum += cage.sum;
      } else {
        innies.push(...inside);
      }
    }

    const target = 45 - fixedSum;
    if (target > 0) changed = applyGroupSum(masks, innies, target) || changed;
  }
  return changed;
}

function applyNakedHiddenPairTriple(masks: number[]): boolean {
  let changed = false;
  for (const unit of UNITS) {
    for (let size = 2; size <= 3; size++) {
      const seen = new Map<number, number[]>();
      for (const cell of unit) {
        if (bitCount(masks[cell]) <= size) {
          const cells = seen.get(masks[cell]) ?? [];
          cells.push(cell);
          seen.set(masks[cell], cells);
        }
      }

      for (const [mask, cells] of seen) {
        if (bitCount(mask) !== size || cells.length !== size) continue;
        for (const cell of unit) {
          if (!cells.includes(cell) && bitCount(masks[cell]) > 1) {
            changed = applyMask(masks, cell, ~mask) || changed;
          }
        }
      }

      for (let digitMask = 0; digitMask < (1 << 9); digitMask++) {
        if (bitCount(digitMask) !== size) continue;
        let mask = 0;
        for (let i = 0; i < 9; i++) {
          if (digitMask & (1 << i)) mask |= maskForDigit(i + 1);
        }
        const cells = unit.filter(cell => masks[cell] & mask);
        const unique = [...new Set(cells)];
        if (unique.length !== size) continue;
        for (const cell of unique) changed = applyMask(masks, cell, mask) || changed;
      }
    }
  }
  return changed;
}

function measureDifficulty(cages: Cage[]): DifficultyReport {
  const masks = new Array<number>(81).fill(ALL_DIGITS_MASK);
  const usage: Record<Technique, number> = {
    singlePossibility: 0,
    nakedSingle: 0,
    cageSumElimination: 0,
    inniesOuties: 0,
    nakedHiddenPairTriple: 0,
  };
  let maxLevel = 1;
  let steps = 0;

  for (let pass = 0; pass < 240; pass++) {
    if (masks.every(mask => bitCount(mask) === 1)) {
      const weighted = Object.entries(usage).reduce((acc, [name, count]) => acc + TECHNIQUE_WEIGHT[name as Technique] * count, 0);
      return { solved: true, score: weighted + steps * 0.1, maxLevel, steps, usage };
    }

    const techniques: Array<[Technique, () => boolean]> = [
      ['singlePossibility', () => applySinglePossibility(masks)],
      ['nakedSingle', () => applyNakedSingle(masks)],
      ['cageSumElimination', () => applyCageSumElimination(masks, cages)],
      ['inniesOuties', () => applyInniesOuties(masks, cages)],
      ['nakedHiddenPairTriple', () => applyNakedHiddenPairTriple(masks)],
    ];

    let progressed = false;
    for (const [technique, apply] of techniques) {
      if (!apply()) continue;
      usage[technique]++;
      maxLevel = Math.max(maxLevel, TECHNIQUE_LEVEL[technique]);
      steps++;
      progressed = true;
      break;
    }
    if (!progressed || masks.some(mask => mask === 0)) break;
  }

  const weighted = Object.entries(usage).reduce((acc, [name, count]) => acc + TECHNIQUE_WEIGHT[name as Technique] * count, 0);
  return { solved: false, score: weighted + steps * 0.1 + 200, maxLevel: 4, steps, usage };
}

function countKillerSolutions(cages: Cage[], limit = 2): number {
  const cellToCage = cagesByCell(cages);
  const grid = new Array<number>(81).fill(0);
  const rowMasks = new Array<number>(9).fill(0);
  const colMasks = new Array<number>(9).fill(0);
  const boxMasks = new Array<number>(9).fill(0);
  const cageMasks = new Array<number>(cages.length).fill(0);
  const cageSums = new Array<number>(cages.length).fill(0);
  let solutions = 0;

  const cageCanFinish = (cageIndex: number, extraDigit: number): boolean => {
    const cage = cages[cageIndex];
    const usedMask = cageMasks[cageIndex] | maskForDigit(extraDigit);
    const usedSum = cageSums[cageIndex] + extraDigit;
    const remainingCells = cage.cells.reduce((acc, cell) => acc + (grid[cell] === 0 ? 1 : 0), 0) - 1;
    return hasSubsetSum(ALL_DIGITS_MASK & ~usedMask, remainingCells, cage.sum - usedSum);
  };

  const search = (): void => {
    if (solutions >= limit) return;

    let bestCell = -1;
    let bestMask = 0;
    let bestCount = 10;

    for (let pos = 0; pos < 81; pos++) {
      if (grid[pos] !== 0) continue;
      const row = (pos / 9) | 0;
      const col = pos % 9;
      const cageIndex = cellToCage[pos];
      let mask = ALL_DIGITS_MASK & ~(rowMasks[row] | colMasks[col] | boxMasks[BOX_OF[pos]] | cageMasks[cageIndex]);
      for (const digit of DIGITS) {
        const bit = maskForDigit(digit);
        if ((mask & bit) && !cageCanFinish(cageIndex, digit)) mask &= ~bit;
      }
      const count = bitCount(mask);
      if (count === 0) return;
      if (count < bestCount) {
        bestCell = pos;
        bestMask = mask;
        bestCount = count;
        if (count === 1) break;
      }
    }

    if (bestCell === -1) {
      solutions++;
      return;
    }

    const row = (bestCell / 9) | 0;
    const col = bestCell % 9;
    const box = BOX_OF[bestCell];
    const cageIndex = cellToCage[bestCell];

    for (const digit of shuffle(DIGITS.filter(n => bestMask & maskForDigit(n)))) {
      const bit = maskForDigit(digit);
      grid[bestCell] = digit;
      rowMasks[row] |= bit;
      colMasks[col] |= bit;
      boxMasks[box] |= bit;
      cageMasks[cageIndex] |= bit;
      cageSums[cageIndex] += digit;

      search();

      grid[bestCell] = 0;
      rowMasks[row] &= ~bit;
      colMasks[col] &= ~bit;
      boxMasks[box] &= ~bit;
      cageMasks[cageIndex] &= ~bit;
      cageSums[cageIndex] -= digit;
      if (solutions >= limit) return;
    }
  };

  search();
  return solutions;
}

function generateCages(solution: Grid, difficulty: Difficulty): Cage[] {
  const profile = CAGE_SIZE_PROFILES[difficulty];
  const assigned = new Int32Array(81).fill(-1);
  const cages: Cage[] = [];

  for (const start of shuffle(Array.from({ length: 81 }, (_, i) => i))) {
    if (assigned[start] !== -1) continue;

    const targetSize = chooseWeighted(profile.sizes);
    const cells = [start];
    const digits = new Set<number>([solution[start]]);
    assigned[start] = cages.length;

    const frontier = shuffle(getAdjacent(start).filter(cell => assigned[cell] === -1));
    while (cells.length < targetSize && frontier.length > 0) {
      const next = frontier.splice((Math.random() * frontier.length) | 0, 1)[0];
      if (assigned[next] !== -1 || digits.has(solution[next])) continue;

      cells.push(next);
      digits.add(solution[next]);
      assigned[next] = cages.length;

      for (const adj of shuffle(getAdjacent(next))) {
        if (assigned[adj] === -1 && !frontier.includes(adj)) frontier.push(adj);
      }
    }

    const sum = cells.reduce((acc, cell) => acc + solution[cell], 0);
    cages.push({ id: cages.length, cells, sum, colorIndex: 0 });
  }

  const merged = mergeExtraSingles(cages, solution, profile);
  normalizeCageIds(merged);
  assignCageColors(merged);
  return merged;
}

function mergeExtraSingles(cages: Cage[], solution: Grid, profile: CageSizeProfile): Cage[] {
  const cellToCage = cagesByCell(cages);
  const removed = new Set<number>();
  let singlesToKeep = profile.maxSingles;

  for (let cageIndex = 0; cageIndex < cages.length; cageIndex++) {
    const cage = cages[cageIndex];
    if (cage.cells.length !== 1 || removed.has(cageIndex)) continue;
    if (singlesToKeep > 0) {
      singlesToKeep--;
      continue;
    }

    const cell = cage.cells[0];
    const target = getAdjacent(cell)
      .map(adj => cellToCage[adj])
      .filter((index, pos, arr) => index !== -1 && index !== cageIndex && !removed.has(index) && arr.indexOf(index) === pos)
      .map(index => cages[index])
      .filter(candidate => candidate.cells.length < profile.maxSize && candidate.cells.every(candidateCell => solution[candidateCell] !== solution[cell]))
      .sort((a, b) => a.cells.length - b.cells.length)[0];

    if (!target) continue;
    target.cells.push(cell);
    target.sum += solution[cell];
    cellToCage[cell] = target.id;
    removed.add(cageIndex);
  }

  return cages.filter((_, index) => !removed.has(index));
}

function difficultyDistance(report: DifficultyReport, difficulty: Difficulty): number {
  const target = TARGETS[difficulty];
  const scoreDistance = report.score < target.min ? target.min - report.score : Math.max(0, report.score - target.max);
  const levelDistance = Math.max(0, report.maxLevel - target.maxLevel) * 50;
  return scoreDistance + levelDistance;
}

function isInTargetBand(report: DifficultyReport, difficulty: Difficulty): boolean {
  const target = TARGETS[difficulty];
  return report.solved && report.maxLevel <= target.maxLevel && report.score >= target.min && report.score <= target.max;
}

function assignCageColors(cages: Cage[]): void {
  const cellToCage = cagesByCell(cages);

  cages.forEach(cage => {
    const usedColors = new Set<number>();
    cage.cells.forEach(cell => {
      getAdjacent(cell).forEach(adj => {
        const adjCageId = cellToCage[adj];
        if (adjCageId !== -1 && adjCageId !== cage.id) usedColors.add(cages[adjCageId]?.colorIndex ?? -1);
      });
    });
    for (let color = 0; color < 6; color++) {
      if (!usedColors.has(color)) {
        cage.colorIndex = color;
        return;
      }
    }
    cage.colorIndex = cage.id % 6;
  });
}

export function generateKillerPuzzle(difficulty: Difficulty): KillerPuzzle {
  const solution: Grid = new Array(81).fill(0);
  solveRandom(solution);

  const candidates: Array<{ cages: Cage[]; report: DifficultyReport }> = [];
  const maxAttempts = difficulty === 'hard' ? 90 : 70;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const cages = generateCages(solution, difficulty);
    if (cages.length < 10) continue;

    const report = measureDifficulty(cages);
    if (!report.solved) continue;
    candidates.push({ cages, report });
    if (isInTargetBand(report, difficulty) && candidates.length >= 8) break;
  }

  candidates.sort((a, b) => difficultyDistance(a.report, difficulty) - difficultyDistance(b.report, difficulty));
  const verified = candidates.slice(0, 10).find(candidate => countKillerSolutions(candidate.cages, 2) === 1);
  const cages = verified?.cages ?? candidates[0]?.cages ?? generateCages(solution, difficulty);
  assignCageColors(cages);

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
