// LocalStorage persistence

import type { AccentTheme, GameState, HistoryRecord, AppSettings, CachedPuzzle, GameType, Difficulty } from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import { createId } from './id.ts';

const KEYS = {
  GAME: 'sudoku_game',               // legacy single-game key, migration only
  SAVED_GAMES: 'sudoku_saved_games',
  HISTORY: 'sudoku_history',
  SETTINGS: 'sudoku_settings',
  PUZZLE_CACHE: 'sudoku_puzzle_cache_v1',
  USER_ID: 'sudoku_user_id',
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

export function loadOrCreateUserId(): string {
  const existing = localStorage.getItem(KEYS.USER_ID);
  if (existing) return existing;
  const id = createId();
  localStorage.setItem(KEYS.USER_ID, id);
  return id;
}

// ── Cloud sync ────────────────────────────────────────────────────────────────

const SYNC_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_SYNC_URL ?? '';

export interface SyncPayload {
  savedGames: GameState[];
  history: HistoryRecord[];
  settings: AppSettings;
  syncedAt: number;
}

export async function pushSync(userId: string): Promise<void> {
  if (!SYNC_URL) throw new Error('VITE_SYNC_URL not configured');
  const payload: SyncPayload = {
    savedGames: loadSavedGames(),
    history: loadHistory(),
    settings: loadSettings(),
    syncedAt: Date.now(),
  };
  const res = await fetch(`${SYNC_URL}/sync/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
}

export async function pullSync(userId: string): Promise<SyncPayload | null> {
  if (!SYNC_URL) throw new Error('VITE_SYNC_URL not configured');
  const res = await fetch(`${SYNC_URL}/sync/${userId}`);
  if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
  return res.json() as Promise<SyncPayload | null>;
}

export function mergeAndApplySync(remote: SyncPayload): void {
  // History: union by id, newest first, cap at 100
  const localHistory = loadHistory();
  const historyMap = new Map<string, HistoryRecord>();
  for (const r of [...remote.history, ...localHistory]) historyMap.set(r.id, r);
  const mergedHistory = [...historyMap.values()]
    .sort((a, b) => b.date - a.date)
    .slice(0, 100);
  save(KEYS.HISTORY, mergedHistory);

  // Saved games: union by id, cap at MAX_SAVED_GAMES
  const localGames = loadSavedGames();
  const gamesMap = new Map<string, GameState>();
  for (const g of [...localGames, ...remote.savedGames]) gamesMap.set(g.id, g);
  const mergedGames = [...gamesMap.values()].slice(0, MAX_SAVED_GAMES);
  save(KEYS.SAVED_GAMES, mergedGames);

  // Settings: use remote (user explicitly synced)
  save(KEYS.SETTINGS, remote.settings);
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
