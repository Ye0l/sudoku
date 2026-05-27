import type { Cage } from './engine/killer.ts';
import type { Difficulty } from './engine/sudoku.ts';

export type { Difficulty, Cage };
export type GameType = 'classic' | 'killer';
export type Theme = 'light' | 'dark' | 'auto';
export type NumpadLayout = 'row' | 'grid';
export type AccentTheme = 'blue' | 'yellow' | 'red' | 'violet' | 'green';
export type CageColorMode = 'distinct' | 'accent';
export type Screen = 'menu' | 'game' | 'history' | 'settings';

export interface CellState {
  value: number;       // 0 = empty
  given: boolean;      // immutable given digit
  memos: number[];     // memo digits 1-9
  error: boolean;      // highlight as wrong
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
  startTime: number;   // epoch ms when started
  elapsed: number;     // accumulated ms (paused time)
  hintCount: number;
  completed: boolean;
  paused: boolean;
}

export interface CachedPuzzle {
  type: GameType;
  difficulty: Difficulty;
  board: number[];
  solution: number[];
  cages?: Cage[];
  createdAt: number;
}

export interface HistoryRecord {
  id: string;
  type: GameType;
  difficulty: Difficulty;
  completed: boolean;
  elapsed: number;
  date: number; // epoch ms
  moves: number;
  hintCount: number;
}

export interface AppSettings {
  theme: Theme;
  showErrors: boolean;
  showHighlights: boolean;
  haptics: boolean;
  autoAdvance: boolean;
  accentTheme: AccentTheme;
  cageColorMode: CageColorMode;
  numpadLayout: NumpadLayout;
  gridLineOpacity: number;
  boxLineOpacity: number;
  showKillerStats: boolean;
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
  accentTheme: 'blue',
  cageColorMode: 'distinct',
  numpadLayout: 'grid',
  gridLineOpacity: 0.14,
  boxLineOpacity: 0.42,
  showKillerStats: true,
};
