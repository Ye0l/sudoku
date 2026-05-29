// LocalStorage persistence

import type { AccentTheme, GameState, HistoryRecord, AppSettings, CachedPuzzle, GameType, Difficulty } from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';

const KEYS = {
  GAME: 'sudoku_game',               // legacy single-game key, migration only
  SAVED_GAMES: 'sudoku_saved_games',
  HISTORY: 'sudoku_history',
  SETTINGS: 'sudoku_settings',
  PUZZLE_CACHE: 'sudoku_puzzle_cache_v1',
} as const;

const MAX_SAVED_GAMES = 10;
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

export function loadSavedGames(): GameState[] {
  const games = load<GameState[] | null>(KEYS.SAVED_GAMES, null);
  if (games !== null) return games;

  // Migrate from legacy single-game key
  const legacy = load<GameState | null>(KEYS.GAME, null);
  const migrated: GameState[] = (legacy && !legacy.completed) ? [legacy] : [];
  save(KEYS.SAVED_GAMES, migrated);
  return migrated;
}

export function saveGame(game: GameState): void {
  const games = loadSavedGames();
  const idx = games.findIndex(g => g.id === game.id);
  if (idx >= 0) {
    games[idx] = game;
  } else {
    games.unshift(game);
    if (games.length > MAX_SAVED_GAMES) games.length = MAX_SAVED_GAMES;
  }
  save(KEYS.SAVED_GAMES, games);
}

export function removeSavedGame(id: string): void {
  const games = loadSavedGames().filter(g => g.id !== id);
  save(KEYS.SAVED_GAMES, games);
}

export function loadHistory(): HistoryRecord[] {
  return load<HistoryRecord[]>(KEYS.HISTORY, []);
}

export function addHistory(record: HistoryRecord): void {
  const history = loadHistory();
  history.unshift(record);
  if (history.length > 100) history.length = 100;
  save(KEYS.HISTORY, history);
}

// Upsert: removes existing record with same id before inserting, prevents duplicates
export function upsertHistory(record: HistoryRecord): void {
  const history = loadHistory().filter(h => h.id !== record.id);
  history.unshift(record);
  if (history.length > 100) history.length = 100;
  save(KEYS.HISTORY, history);
}

export function removeHistoryRecord(id: string): void {
  const history = loadHistory().filter(h => h.id !== id);
  save(KEYS.HISTORY, history);
}

export function clearHistory(): void {
  localStorage.removeItem(KEYS.HISTORY);
}

export function loadSettings(): AppSettings {
  const saved = load<Partial<AppSettings> & { nightly?: boolean }>(KEYS.SETTINGS, {});
  const savedAccent = saved.accentTheme as string | undefined;
  const accentTheme: AccentTheme = savedAccent === 'default'
    ? 'blue'
    : savedAccent === 'nightly'
      ? 'yellow'
      : saved.accentTheme ?? (saved.nightly ? 'yellow' : DEFAULT_SETTINGS.accentTheme);
  const { nightly: _nightly, ...settings } = saved;
  return { ...DEFAULT_SETTINGS, ...settings, accentTheme };
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
