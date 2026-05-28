// Sudoku puzzle generation and solving engine

export type Grid = number[]; // 81 cells, 0 = empty
export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert' | 'master';

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

const UNITS: number[][] = [
  ...Array.from({ length: 9 }, (_, row) => getRowIndices(row)),
  ...Array.from({ length: 9 }, (_, col) => getColIndices(col)),
  ...Array.from({ length: 9 }, (_, box) => {
    const br = ((box / 3) | 0) * 3;
    const bc = (box % 3) * 3;
    return getBoxIndices(br, bc);
  }),
];

type Technique =
  | 'Naked Single'
  | 'Hidden Single'
  | 'Locked Candidate'
  | 'Naked Pair'
  | 'Hidden Pair'
  | 'Naked Triple'
  | 'Hidden Triple'
  | 'X-Wing'
  | 'Swordfish'
  | 'Forcing Chain'
  | 'Nishio';

interface LogicalReport {
  solved: boolean;
  contradiction: boolean;
  hardestLevel: number;
  placements: number;
  eliminations: number;
  advancedSteps: number;
  techniqueCounts: Partial<Record<Technique, number>>;
}

interface SolverState {
  grid: Grid;
  candidates: number[];
}

const TECHNIQUE_LEVEL: Record<Technique, number> = {
  'Naked Single': 1,
  'Hidden Single': 1,
  'Locked Candidate': 2,
  'Naked Pair': 3,
  'Hidden Pair': 3,
  'Naked Triple': 3,
  'Hidden Triple': 3,
  'X-Wing': 4,
  'Swordfish': 4,
  'Forcing Chain': 5,
  'Nishio': 5,
};

const DIFFICULTY_LEVEL: Record<Difficulty, number> = {
  easy: 1,
  medium: 2,
  hard: 3,
  expert: 4,
  master: 5,
};

const CLASSIC_PROFILES: Record<Difficulty, { targets: number[]; minRemoved: number; attempts: number }> = {
  easy: { targets: [36, 38, 40], minRemoved: 32, attempts: 18 },
  medium: { targets: [50, 52, 54], minRemoved: 45, attempts: 54 },
  hard: { targets: [52, 54, 56], minRemoved: 48, attempts: 72 },
  expert: { targets: [54, 56, 58], minRemoved: 50, attempts: 180 },
  master: { targets: [56, 58, 60, 62], minRemoved: 54, attempts: 120 },
};

interface ClassicTemplate {
  id: string;
  difficulty: Difficulty;
  puzzle: string;
  solution: string;
}

const CLASSIC_TEMPLATES: Record<Difficulty, ClassicTemplate[]> = {
  easy: [{
    id: 'easy-singles-001',
    difficulty: 'easy',
    puzzle: '090607301060809040080105090000018039900000408072394006738001264120403870045002913',
    solution: '594627381261839547387145692456218739913576428872394156738951264129463875645782913',
  }],
  medium: [{
    id: 'medium-locked-001',
    difficulty: 'medium',
    puzzle: '950000000806000059000070600060042070000000100000360080200016800004000001003807590',
    solution: '957684312846231759321975648568142973439758126172369485295416837784593261613827594',
  }],
  hard: [{
    id: 'hard-pairs-001',
    difficulty: 'hard',
    puzzle: '005300000800000020070010500400005300010070006003200080060500009004000030000009700',
    solution: '145327698839654127672918543496185372218473956753296481367542819984761235521839764',
  }],
  expert: [{
    id: 'expert-xwing-001',
    difficulty: 'expert',
    puzzle: '000000010400000000020000000000050407008000300001090000300400200050100000000806000',
    solution: '693784512487512936125963874932651487568247391741398625319475268856129743274836159',
  }],
  master: [{
    id: 'master-escargot-001',
    difficulty: 'master',
    puzzle: '100007090030020008009600500005300900010080002600004000300000010040000007007000300',
    solution: '162857493534129678789643521475312986913586742628794135356478219241935867897261354',
  }],
};

function parseGridString(value: string): Grid {
  return Array.from(value, char => Number(char));
}

function relabelDigits(grid: Grid, map: number[]): Grid {
  return grid.map(value => value === 0 ? 0 : map[value]);
}

function transposeGrid(grid: Grid): Grid {
  const next = new Array(81).fill(0);
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      next[r * 9 + c] = grid[c * 9 + r];
  return next;
}

function rotateGrid(grid: Grid): Grid {
  const next = new Array(81).fill(0);
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      next[r * 9 + c] = grid[(8 - c) * 9 + r];
  return next;
}

function reflectGrid(grid: Grid): Grid {
  const next = new Array(81).fill(0);
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      next[r * 9 + c] = grid[r * 9 + (8 - c)];
  return next;
}

function shuffledUnitOrder(): number[] {
  const groups = shuffle([0, 1, 2]);
  const order: number[] = [];
  for (const group of groups) {
    for (const offset of shuffle([0, 1, 2])) order.push(group * 3 + offset);
  }
  return order;
}

function permuteRowsAndColumns(grid: Grid, rows: number[], cols: number[]): Grid {
  const next = new Array(81).fill(0);
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      next[r * 9 + c] = grid[rows[r] * 9 + cols[c]];
  return next;
}

function transformTemplate(template: ClassicTemplate): ClassicPuzzle {
  const digitMap = [0, ...shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])];
  let board = relabelDigits(parseGridString(template.puzzle), digitMap);
  let solution = relabelDigits(parseGridString(template.solution), digitMap);

  if (Math.random() < 0.5) {
    board = transposeGrid(board);
    solution = transposeGrid(solution);
  }

  const rotations = (Math.random() * 4) | 0;
  for (let i = 0; i < rotations; i++) {
    board = rotateGrid(board);
    solution = rotateGrid(solution);
  }

  if (Math.random() < 0.5) {
    board = reflectGrid(board);
    solution = reflectGrid(solution);
  }

  const rows = shuffledUnitOrder();
  const cols = shuffledUnitOrder();
  board = permuteRowsAndColumns(board, rows, cols);
  solution = permuteRowsAndColumns(solution, rows, cols);
  return { board, solution };
}

function generateFromTemplate(difficulty: Difficulty): ClassicPuzzle {
  const templates = CLASSIC_TEMPLATES[difficulty];
  return transformTemplate(templates[(Math.random() * templates.length) | 0]);
}

function countRemoved(board: Grid): number {
  let removed = 0;
  for (const value of board) if (value === 0) removed++;
  return removed;
}

function candidateMask(grid: Grid, pos: number): number {
  let mask = 0b1111111110;
  for (const peer of getPeers(pos)) {
    const value = grid[peer];
    if (value !== 0) mask &= ~(1 << value);
  }
  return mask;
}

function maskSize(mask: number): number {
  let count = 0;
  for (let n = 1; n <= 9; n++) if (mask & (1 << n)) count++;
  return count;
}

function maskSingle(mask: number): number {
  for (let n = 1; n <= 9; n++) if (mask === (1 << n)) return n;
  return 0;
}

function maskDigits(mask: number): number[] {
  const digits: number[] = [];
  for (let n = 1; n <= 9; n++) if (mask & (1 << n)) digits.push(n);
  return digits;
}

function addTechnique(report: LogicalReport, technique: Technique, amount = 1): void {
  report.techniqueCounts[technique] = (report.techniqueCounts[technique] ?? 0) + amount;
  report.hardestLevel = Math.max(report.hardestLevel, TECHNIQUE_LEVEL[technique]);
  if (TECHNIQUE_LEVEL[technique] >= 4) report.advancedSteps += amount;
}

function createSolverState(board: Grid): SolverState {
  const state: SolverState = {
    grid: [...board],
    candidates: new Array(81).fill(0),
  };

  for (let pos = 0; pos < 81; pos++) {
    state.candidates[pos] = state.grid[pos] === 0 ? candidateMask(state.grid, pos) : 0;
  }

  return state;
}

function hasContradiction(state: SolverState): boolean {
  for (let pos = 0; pos < 81; pos++) {
    if (state.grid[pos] === 0 && state.candidates[pos] === 0) return true;
  }

  for (const unit of UNITS) {
    for (let n = 1; n <= 9; n++) {
      const bit = 1 << n;
      let placed = 0;
      let possible = 0;
      for (const pos of unit) {
        if (state.grid[pos] === n) placed++;
        if (state.grid[pos] === 0 && (state.candidates[pos] & bit)) possible++;
      }
      if (placed > 1 || (placed === 0 && possible === 0)) return true;
    }
  }

  return false;
}

function placeDigit(state: SolverState, pos: number, digit: number): boolean {
  if (state.grid[pos] === digit) return false;
  state.grid[pos] = digit;
  state.candidates[pos] = 0;
  const bit = 1 << digit;
  for (const peer of getPeers(pos)) {
    if (state.grid[peer] === 0) state.candidates[peer] &= ~bit;
  }
  return true;
}

function eliminateMask(state: SolverState, pos: number, mask: number): boolean {
  if (state.grid[pos] !== 0) return false;
  const next = state.candidates[pos] & ~mask;
  if (next === state.candidates[pos]) return false;
  state.candidates[pos] = next;
  return true;
}

function combinations<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  const combo: T[] = [];

  function visit(start: number): void {
    if (combo.length === size) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i <= items.length - (size - combo.length); i++) {
      combo.push(items[i]);
      visit(i + 1);
      combo.pop();
    }
  }

  visit(0);
  return result;
}

function applySingles(state: SolverState, report: LogicalReport): boolean {
  for (let pos = 0; pos < 81; pos++) {
    if (state.grid[pos] !== 0) continue;
    const single = maskSingle(state.candidates[pos]);
    if (single !== 0) {
      placeDigit(state, pos, single);
      report.placements++;
      addTechnique(report, 'Naked Single');
      return true;
    }
  }

  for (const unit of UNITS) {
    for (let n = 1; n <= 9; n++) {
      const bit = 1 << n;
      let onlyPos = -1;
      let count = 0;
      for (const pos of unit) {
        if (state.grid[pos] !== 0 || (state.candidates[pos] & bit) === 0) continue;
        onlyPos = pos;
        count++;
        if (count > 1) break;
      }
      if (count === 1) {
        placeDigit(state, onlyPos, n);
        report.placements++;
        addTechnique(report, 'Hidden Single');
        return true;
      }
    }
  }

  return false;
}

function applyLockedCandidates(state: SolverState, report: LogicalReport): boolean {
  for (let box = 0; box < 9; box++) {
    const boxCells = UNITS[18 + box];
    for (let n = 1; n <= 9; n++) {
      const bit = 1 << n;
      const cells = boxCells.filter(pos => state.grid[pos] === 0 && (state.candidates[pos] & bit));
      if (cells.length < 2) continue;
      const sameRow = cells.every(pos => (pos / 9 | 0) === (cells[0] / 9 | 0));
      const sameCol = cells.every(pos => pos % 9 === cells[0] % 9);
      const unit = sameRow ? getRowIndices(cells[0] / 9 | 0) : sameCol ? getColIndices(cells[0] % 9) : null;
      if (!unit) continue;
      for (const pos of unit) {
        if (!boxCells.includes(pos) && eliminateMask(state, pos, bit)) {
          report.eliminations++;
          addTechnique(report, 'Locked Candidate');
          return true;
        }
      }
    }
  }

  for (let unitIndex = 0; unitIndex < 18; unitIndex++) {
    const unit = UNITS[unitIndex];
    for (let n = 1; n <= 9; n++) {
      const bit = 1 << n;
      const cells = unit.filter(pos => state.grid[pos] === 0 && (state.candidates[pos] & bit));
      if (cells.length < 2) continue;
      const box = getBoxIndex(cells[0]);
      if (!cells.every(pos => getBoxIndex(pos) === box)) continue;
      for (const pos of UNITS[18 + box]) {
        if (!unit.includes(pos) && eliminateMask(state, pos, bit)) {
          report.eliminations++;
          addTechnique(report, 'Locked Candidate');
          return true;
        }
      }
    }
  }

  return false;
}

function subsetTechnique(size: 2 | 3, hidden: boolean): Technique {
  if (hidden) return size === 2 ? 'Hidden Pair' : 'Hidden Triple';
  return size === 2 ? 'Naked Pair' : 'Naked Triple';
}

function applySubsets(state: SolverState, report: LogicalReport, size: 2 | 3, hidden: boolean): boolean {
  const technique = subsetTechnique(size, hidden);

  for (const unit of UNITS) {
    if (!hidden) {
      const cells = unit.filter(pos => state.grid[pos] === 0 && maskSize(state.candidates[pos]) >= 2 && maskSize(state.candidates[pos]) <= size);
      for (const combo of combinations(cells, size)) {
        const union = combo.reduce((mask, pos) => mask | state.candidates[pos], 0);
        if (maskSize(union) !== size) continue;
        for (const pos of unit) {
          if (!combo.includes(pos) && eliminateMask(state, pos, union)) {
            report.eliminations++;
            addTechnique(report, technique);
            return true;
          }
        }
      }
    } else {
      for (const digits of combinations([1, 2, 3, 4, 5, 6, 7, 8, 9], size)) {
        const digitMask = digits.reduce((mask, digit) => mask | (1 << digit), 0);
        const cells = unit.filter(pos => state.grid[pos] === 0 && (state.candidates[pos] & digitMask));
        if (cells.length !== size) continue;
        if (!digits.every(digit => cells.some(pos => state.candidates[pos] & (1 << digit)))) continue;
        for (const pos of cells) {
          if (eliminateMask(state, pos, state.candidates[pos] & ~digitMask)) {
            report.eliminations++;
            addTechnique(report, technique);
            return true;
          }
        }
      }
    }
  }

  return false;
}

function applyFish(state: SolverState, report: LogicalReport, size: 2 | 3): boolean {
  const technique: Technique = size === 2 ? 'X-Wing' : 'Swordfish';

  for (let n = 1; n <= 9; n++) {
    const bit = 1 << n;
    for (const byRows of [true, false]) {
      const baseUnits = byRows ? UNITS.slice(0, 9) : UNITS.slice(9, 18);
      const lineOptions = baseUnits
        .map((unit, index) => ({
          index,
          positions: unit.filter(pos => state.grid[pos] === 0 && (state.candidates[pos] & bit)),
        }))
        .filter(line => line.positions.length >= 2 && line.positions.length <= size);

      for (const lines of combinations(lineOptions, size)) {
        const cover = new Set<number>();
        lines.forEach(line => line.positions.forEach(pos => cover.add(byRows ? pos % 9 : (pos / 9) | 0)));
        if (cover.size !== size) continue;
        const lineSet = new Set(lines.map(line => line.index));

        for (const coverIndex of cover) {
          const unit = byRows ? getColIndices(coverIndex) : getRowIndices(coverIndex);
          for (const pos of unit) {
            const lineIndex = byRows ? ((pos / 9) | 0) : pos % 9;
            if (!lineSet.has(lineIndex) && eliminateMask(state, pos, bit)) {
              report.eliminations++;
              addTechnique(report, technique);
              return true;
            }
          }
        }
      }
    }
  }

  return false;
}

function cloneState(state: SolverState): SolverState {
  return { grid: [...state.grid], candidates: [...state.candidates] };
}

function applyForcingElimination(state: SolverState, report: LogicalReport, maxAssumptions: number): boolean {
  const candidates = Array.from({ length: 81 }, (_, pos) => pos)
    .filter(pos => state.grid[pos] === 0 && maskSize(state.candidates[pos]) >= 2)
    .sort((a, b) => maskSize(state.candidates[a]) - maskSize(state.candidates[b]))
    .slice(0, maxAssumptions);

  for (const pos of candidates) {
    for (const digit of maskDigits(state.candidates[pos])) {
      const trial = cloneState(state);
      placeDigit(trial, pos, digit);
      const trialReport = solveLogical(trial, 4, false, 160);
      if (trialReport.contradiction && eliminateMask(state, pos, 1 << digit)) {
        report.eliminations++;
        addTechnique(report, trialReport.advancedSteps > 0 ? 'Forcing Chain' : 'Nishio');
        return true;
      }
    }
  }

  return false;
}

function solveLogical(input: Grid | SolverState, maxLevel: number, allowForcing = true, stepLimit = 500): LogicalReport {
  const state = Array.isArray(input) ? createSolverState(input) : input;
  const report: LogicalReport = {
    solved: false,
    contradiction: hasContradiction(state),
    hardestLevel: 0,
    placements: 0,
    eliminations: 0,
    advancedSteps: 0,
    techniqueCounts: {},
  };

  for (let step = 0; step < stepLimit && !report.contradiction; step++) {
    if (countRemoved(state.grid) === 0) {
      report.solved = true;
      return report;
    }

    const progress =
      applySingles(state, report)
      || (maxLevel >= 2 && applyLockedCandidates(state, report))
      || (maxLevel >= 3 && applySubsets(state, report, 2, false))
      || (maxLevel >= 3 && applySubsets(state, report, 2, true))
      || (maxLevel >= 3 && applySubsets(state, report, 3, false))
      || (maxLevel >= 3 && applySubsets(state, report, 3, true))
      || (maxLevel >= 4 && applyFish(state, report, 2))
      || (maxLevel >= 4 && applyFish(state, report, 3))
      || (allowForcing && maxLevel >= 5 && applyForcingElimination(state, report, maxLevel === 5 ? 16 : 8));

    report.contradiction = hasContradiction(state);
    if (!progress) break;
  }

  report.solved = !report.contradiction && countRemoved(state.grid) === 0;
  return report;
}

function difficultyMatch(report: LogicalReport, difficulty: Difficulty): boolean {
  if (!report.solved || report.contradiction) return false;
  const targetLevel = DIFFICULTY_LEVEL[difficulty];
  if (report.hardestLevel !== targetLevel) return false;
  if (difficulty === 'master' && report.advancedSteps < 2) return false;
  return true;
}

function measureLogicalDifficulty(board: Grid): LogicalReport {
  let lastReport = solveLogical(board, 5);
  for (let level = 1; level <= 5; level++) {
    const report = solveLogical(board, level);
    if (report.solved) return report;
    lastReport = report;
  }
  return lastReport;
}

function rateClassicBoard(board: Grid, report: LogicalReport, difficulty: Difficulty): number {
  const targetLevel = DIFFICULTY_LEVEL[difficulty];
  const removed = countRemoved(board);
  const levelDistance = Math.abs(report.hardestLevel - targetLevel);
  return (difficultyMatch(report, difficulty) ? 100000 : 0)
    - levelDistance * (report.hardestLevel > targetLevel ? 26000 : 14000)
    + removed * 180
    + report.placements * 4
    + report.eliminations * 22
    + (report.hardestLevel <= targetLevel ? report.advancedSteps * 900 : 0);
}

export function analyzeClassicDifficulty(board: Grid): LogicalReport {
  return measureLogicalDifficulty(board);
}

function selectTargetRemoved(profile: { targets: number[] }, attempt: number): number {
  return profile.targets[attempt % profile.targets.length];
}

function generateSolution(): Grid {
  const solution: Grid = new Array(81).fill(0);
  solveInternal(solution, true, 1);
  return solution;
}

function carveClassicBoard(solution: Grid, targetRemoved: number): Grid {
  const board = [...solution];
  const positions = shuffle(Array.from({ length: 81 }, (_, i) => i));
  let removed = 0;

  for (const pos of positions) {
    if (removed >= targetRemoved) break;
    const backup = board[pos];
    board[pos] = 0;
    if (countSolutions(board, 2) === 1) {
      removed++;
    } else {
      board[pos] = backup;
    }
  }

  return board;
}

function seedSparseUniqueBoard(solution: Grid, minGivenCount: number, maxGivenCount: number): Grid | null {
  const board: Grid = new Array(81).fill(0);
  const positions = shuffle(Array.from({ length: 81 }, (_, i) => i));
  let givenCount = 0;

  for (const pos of positions) {
    board[pos] = solution[pos];
    givenCount++;
    if (givenCount < minGivenCount) continue;
    if (countSolutions(board, 2) === 1) return board;
    if (givenCount >= maxGivenCount) break;
  }

  return null;
}

export function generateClassicPuzzle(difficulty: Difficulty): ClassicPuzzle {
  return generateFromTemplate(difficulty);
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
