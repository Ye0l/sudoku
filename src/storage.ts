// LocalStorage persistence

import type { GameState, HistoryRecord, AppSettings, CachedPuzzle, GameType, Difficulty } from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';

const KEYS = {
  GAME: 'sudoku_game',
  HISTORY: 'sudoku_history',
  SETTINGS: 'sudoku_settings',
  PUZZLE_CACHE: 'sudoku_puzzle_cache_v1',
} as const;

const MAX_CACHED_PUZZLES_PER_KEY = 3;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full - ignore
  }
}

export function loadGame(): GameState | null {
  return load<GameState | null>(KEYS.GAME, null);
}

export function saveGame(game: GameState | null): void {
  if (game) {
    save(KEYS.GAME, game);
  } else {
    localStorage.removeItem(KEYS.GAME);
  }
}

export function loadHistory(): HistoryRecord[] {
  return load<HistoryRecord[]>(KEYS.HISTORY, []);
}

export function addHistory(record: HistoryRecord): void {
  const history = loadHistory();
  history.unshift(record);
  // Keep last 100 records
  if (history.length > 100) history.length = 100;
  save(KEYS.HISTORY, history);
}

export function clearHistory(): void {
  localStorage.removeItem(KEYS.HISTORY);
}

export function loadSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...load<Partial<AppSettings>>(KEYS.SETTINGS, {}) };
}

export function saveSettings(settings: AppSettings): void {
  save(KEYS.SETTINGS, settings);
}

function puzzleCacheKey(type: GameType, difficulty: Difficulty): string {
  return `${type}:${difficulty}`;
}

function loadPuzzleCache(): Record<string, CachedPuzzle[]> {
  return load<Record<string, CachedPuzzle[]>>(KEYS.PUZZLE_CACHE, {});
}

export function takeCachedPuzzle(type: GameType, difficulty: Difficulty): CachedPuzzle | null {
  const cache = loadPuzzleCache();
  const key = puzzleCacheKey(type, difficulty);
  const puzzles = cache[key] ?? [];
  const puzzle = puzzles.shift() ?? null;

  if (puzzle) {
    cache[key] = puzzles;
    save(KEYS.PUZZLE_CACHE, cache);
  }

  return puzzle;
}

export function countCachedPuzzles(type: GameType, difficulty: Difficulty): number {
  return loadPuzzleCache()[puzzleCacheKey(type, difficulty)]?.length ?? 0;
}

export function addCachedPuzzle(puzzle: CachedPuzzle): void {
  const cache = loadPuzzleCache();
  const key = puzzleCacheKey(puzzle.type, puzzle.difficulty);
  const puzzles = cache[key] ?? [];
  const signature = `${puzzle.solution.join('')}:${puzzle.cages?.map(cage => `${cage.sum}:${cage.cells.join('.')}`).join('|') ?? ''}`;

  if (puzzles.some(cached => {
    const cachedSignature = `${cached.solution.join('')}:${cached.cages?.map(cage => `${cage.sum}:${cage.cells.join('.')}`).join('|') ?? ''}`;
    return cachedSignature === signature;
  })) {
    return;
  }

  puzzles.push(puzzle);
  cache[key] = puzzles.slice(-MAX_CACHED_PUZZLES_PER_KEY);
  save(KEYS.PUZZLE_CACHE, cache);
}
