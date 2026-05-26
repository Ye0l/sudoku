import type { Cage } from './engine/killer.ts';
import type { Difficulty } from './engine/sudoku.ts';

export type { Difficulty, Cage };
export type GameType = 'classic' | 'killer';
export type Theme = 'light' | 'dark' | 'auto';
export type Screen = 'menu' | 'game' | 'history' | 'settings';

export interface CellState {
  value: number;
  given: boolean;
  memos: number[];
  error: boolean;
}

export interface GameState {
  id: string;
  type: GameType;
  difficulty: Difficulty;
  cells: CellState[];
  solution: number[];
  cages?: Cage[];
  selectedCell: number; // -1 = none
  memoMode: boolean;
  startTime: number;
  elapsed: number;
  completed: boolean;
  paused: boolean;
  hints: number;        // hint count
}

export interface HistoryRecord {
  id: string;
  type: GameType;
  difficulty: Difficulty;
  completed: boolean;
  elapsed: number;
  date: number;
  moves: number;
  hints: number;        // hint count
}

export interface AppSettings {
  theme: Theme;
  showErrors: boolean;
  showHighlights: boolean;
  haptics: boolean;
  autoAdvance: boolean;
}

export interface AppState {
  screen: Screen;
  game: GameState | null;
  history: HistoryRecord[];
  settings: AppSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'auto',
  showErrors: true,
  showHighlights: true,
  haptics: true,
  autoAdvance: false,
};
