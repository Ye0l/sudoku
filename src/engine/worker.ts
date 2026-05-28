// Web Worker: puzzle generation (runs off main thread)

import { generateClassicPuzzle, type Difficulty } from './sudoku.ts';
import { generateKillerPuzzle, type KillerDifficulty } from './killer.ts';

type WorkerRequest =
  | { type: 'classic'; difficulty: Difficulty; id: string }
  | { type: 'killer';  difficulty: KillerDifficulty; id: string };

type WorkerResponse =
  | { type: 'classic'; puzzle: ReturnType<typeof generateClassicPuzzle>; id: string }
  | { type: 'killer';  puzzle: ReturnType<typeof generateKillerPuzzle>;  id: string }
  | { type: 'error';   message: string; id: string };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { type, difficulty, id } = e.data;
  try {
    if (type === 'classic') {
      const puzzle = generateClassicPuzzle(difficulty);
      (self as unknown as Worker).postMessage({ type: 'classic', puzzle, id } satisfies WorkerResponse);
    } else {
      const puzzle = generateKillerPuzzle(difficulty);
      (self as unknown as Worker).postMessage({ type: 'killer', puzzle, id } satisfies WorkerResponse);
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      message: String(err),
      id,
    } satisfies WorkerResponse);
  }
};
