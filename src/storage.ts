// LocalStorage persistence

import type { GameState, HistoryRecord, AppSettings } from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';

const KEYS = {
  GAME: 'sudoku_game',
  HISTORY: 'sudoku_history',
  SETTINGS: 'sudoku_settings',
} as const;

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
