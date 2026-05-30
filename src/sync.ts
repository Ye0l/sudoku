// Cloud sync engine — Durable Object (game state) + Cloudflare KV (settings, clears)

import type { AppSettings, GameState, GameType, Difficulty, HistoryRecord } from './types.ts';
import { loadSavedGames, loadHistory, loadSettings, saveSettings } from './storage.ts';

const SYNC_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_SYNC_URL ?? '';

// ── Remote types ──────────────────────────────────────────────────────────────

interface RemoteSettings {
  data: AppSettings;
  updatedAt: number;
}

interface RemotePuzzle {
  data: GameState;
  globalSeq: number;
  updatedAt: number;
  deletedAt?: number;
}

interface ClearLog {
  id: string;
  type: GameType;
  difficulty: Difficulty;
  completed: boolean;
  elapsed: number;
  date: number;
  moves: number;
  hintCount: number;
}

interface RemoteClears {
  logs: ClearLog[];
  updatedAt: number;
}

type PuzzleIndex = Record<string, { updatedAt: number; deletedAt?: number }>;

// ── WebSocket message types ───────────────────────────────────────────────────

export interface CellUpdateMsg {
  type: 'cell';
  puzzleId: string;
  row: number;
  col: number;
  value: number | null;
  memos: number[];
  seq: number;
}

export interface InitMsg {
  type: 'init';
  cells: Record<string, { value: number | null; memos: number[] }>; // key: "row:col"
  seq: number;
}

export type WsCallbacks = {
  onInit: (msg: InitMsg) => void;
  onCell: (msg: CellUpdateMsg) => void;
};

// ── Sync metadata (local) ─────────────────────────────────────────────────────

interface PuzzleMeta {
  localUpdatedAt: number;
  serverUpdatedAt: number;
}

interface SyncMeta {
  settings: { localUpdatedAt: number; serverUpdatedAt: number } | null;
  puzzles: Record<string, PuzzleMeta>;
  deletedPuzzles: Record<string, { deletedAt: number; pushed?: boolean }>;
  clears: { serverUpdatedAt: number } | null;
  lastSyncAt: number;
}

const META_KEY = 'sudoku_sync_meta';

function loadMeta(): SyncMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw) return JSON.parse(raw) as SyncMeta;
  } catch { /* ignore */ }
  return { settings: null, puzzles: {}, deletedPuzzles: {}, clears: null, lastSyncAt: 0 };
}

function saveMeta(meta: SyncMeta): void {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

// ── Change tracking (call these whenever local data changes) ──────────────────

export function markSettingsChanged(): void {
  const meta = loadMeta();
  meta.settings = {
    localUpdatedAt: Date.now(),
    serverUpdatedAt: meta.settings?.serverUpdatedAt ?? 0,
  };
  saveMeta(meta);
}

export function markPuzzleChanged(puzzleId: string): void {
  const meta = loadMeta();
  meta.puzzles[puzzleId] = {
    localUpdatedAt: Date.now(),
    serverUpdatedAt: meta.puzzles[puzzleId]?.serverUpdatedAt ?? 0,
  };
  saveMeta(meta);
}

export function markPuzzleDeleted(puzzleId: string): void {
  const meta = loadMeta();
  delete meta.puzzles[puzzleId];
  meta.deletedPuzzles[puzzleId] = { deletedAt: Date.now() };
  saveMeta(meta);
}

export function clearSyncMeta(): void {
  localStorage.removeItem(META_KEY);
}

// ── WebSocket game connections ─────────────────────────────────────────────────

const gameWs = new Map<string, WebSocket>();
const wantedGames = new Set<string>();
const sendTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function connectGameWS(
  userId: string,
  gameId: string,
  callbacks: WsCallbacks,
): void {
  if (!SYNC_URL) return;
  disconnectGameWS(gameId);
  wantedGames.add(gameId);

  const base = SYNC_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  const ws = new WebSocket(`${base}/user/${userId}/game/${gameId}/ws`);
  gameWs.set(gameId, ws);

  let lastSeq = 0;

  ws.addEventListener('message', (e) => {
    let msg: CellUpdateMsg | InitMsg;
    try { msg = JSON.parse(e.data as string) as CellUpdateMsg | InitMsg; } catch { return; }
    if (msg.type === 'init') {
      lastSeq = (msg as InitMsg).seq;
      callbacks.onInit(msg as InitMsg);
    } else if (msg.type === 'cell') {
      const cm = msg as CellUpdateMsg;
      if (cm.seq <= lastSeq) return; // out-of-order protection
      lastSeq = cm.seq;
      callbacks.onCell(cm);
    }
  });

  ws.addEventListener('close', () => {
    if (gameWs.get(gameId) === ws) {
      gameWs.delete(gameId);
      if (wantedGames.has(gameId)) {
        setTimeout(() => {
          if (wantedGames.has(gameId)) connectGameWS(userId, gameId, callbacks);
        }, 3_000);
      }
    }
  });
}

export function disconnectGameWS(gameId: string): void {
  wantedGames.delete(gameId);
  const ws = gameWs.get(gameId);
  if (ws) { ws.close(); gameWs.delete(gameId); }
}

export function sendCellUpdate(
  gameId: string,
  puzzleId: string,
  row: number,
  col: number,
  value: number | null,
  memos: number[] = [],
): void {
  const key = `${gameId}:${row}:${col}`;
  const existing = sendTimers.get(key);
  if (existing) clearTimeout(existing);

  sendTimers.set(key, setTimeout(() => {
    sendTimers.delete(key);
    const ws = gameWs.get(gameId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'cell', puzzleId, row, col, value, memos }));
  }, 200));
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiGet<T>(path: string): Promise<T | null> {
  const res = await fetch(`${SYNC_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json() as Promise<T | null>;
}

async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SYNC_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Converters ────────────────────────────────────────────────────────────────

function toLog(h: HistoryRecord): ClearLog {
  return { id: h.id, type: h.type, difficulty: h.difficulty, completed: h.completed, elapsed: h.elapsed, date: h.date, moves: h.moves, hintCount: h.hintCount };
}

function fromLog(c: ClearLog): HistoryRecord {
  return { id: c.id, type: c.type, difficulty: c.difficulty, completed: c.completed, elapsed: c.elapsed, date: c.date, moves: c.moves, hintCount: c.hintCount };
}

// ── Sync phases ───────────────────────────────────────────────────────────────

// New device — pull everything, no merge logic
async function fullPull(userId: string, meta: SyncMeta): Promise<void> {
  const [remoteSettings, puzzleIndex, remoteClears] = await Promise.all([
    apiGet<RemoteSettings>(`/user/${userId}/settings`),
    apiGet<PuzzleIndex>(`/user/${userId}/puzzle-index`),
    apiGet<RemoteClears>(`/user/${userId}/clears`),
  ]);

  if (remoteSettings) {
    saveSettings(remoteSettings.data);
    meta.settings = { localUpdatedAt: remoteSettings.updatedAt, serverUpdatedAt: remoteSettings.updatedAt };
  }

  const games: GameState[] = [];
  if (puzzleIndex) {
    for (const [pid, entry] of Object.entries(puzzleIndex)) {
      if (entry.deletedAt) continue;
      const puzzle = await apiGet<RemotePuzzle>(`/user/${userId}/puzzle/${pid}`);
      if (puzzle && !puzzle.deletedAt) {
        games.push(puzzle.data);
        meta.puzzles[pid] = { localUpdatedAt: puzzle.updatedAt, serverUpdatedAt: puzzle.updatedAt };
      }
    }
  }
  localStorage.setItem('sudoku_saved_games', JSON.stringify(games));

  if (remoteClears) {
    localStorage.setItem('sudoku_history', JSON.stringify(remoteClears.logs.map(fromLog)));
    meta.clears = { serverUpdatedAt: remoteClears.updatedAt };
  }
}

// Settings — Last-Write-Wins by server timestamp
async function syncSettings(userId: string, meta: SyncMeta): Promise<void> {
  const remote = await apiGet<RemoteSettings>(`/user/${userId}/settings`);
  const localSettings = loadSettings();
  const localUpdatedAt = meta.settings?.localUpdatedAt ?? 0;
  const knownServerAt = meta.settings?.serverUpdatedAt ?? 0;

  if (!remote || localUpdatedAt > knownServerAt) {
    const r = await apiPut<RemoteSettings>(`/user/${userId}/settings`, { data: localSettings });
    meta.settings = { localUpdatedAt: r.updatedAt, serverUpdatedAt: r.updatedAt };
  } else if (remote.updatedAt > knownServerAt) {
    saveSettings(remote.data);
    meta.settings = { localUpdatedAt: remote.updatedAt, serverUpdatedAt: remote.updatedAt };
  }
}

// Puzzles — Last-Write-Wins per puzzle, Tombstone for deletes
async function syncPuzzles(userId: string, meta: SyncMeta): Promise<string[]> {
  const overwritten: string[] = [];

  for (const [pid, del] of Object.entries(meta.deletedPuzzles)) {
    if (!del.pushed) {
      await apiPut(`/user/${userId}/puzzle/${pid}`, { deletedAt: del.deletedAt });
      meta.deletedPuzzles[pid] = { ...del, pushed: true };
    }
  }

  const puzzleIndex = await apiGet<PuzzleIndex>(`/user/${userId}/puzzle-index`) ?? {};
  const localGames = loadSavedGames();
  const unsynced = new Map(localGames.map(g => [g.id, g]));
  const result: GameState[] = [];

  for (const [pid, entry] of Object.entries(puzzleIndex)) {
    const local = unsynced.get(pid);
    const localMeta = meta.puzzles[pid];

    if (entry.deletedAt) {
      if (local) overwritten.push(pid);
      unsynced.delete(pid);
      delete meta.puzzles[pid];
      continue;
    }

    if (!local) {
      const r = await apiGet<RemotePuzzle>(`/user/${userId}/puzzle/${pid}`);
      if (r && !r.deletedAt) {
        result.push(r.data);
        meta.puzzles[pid] = { localUpdatedAt: r.updatedAt, serverUpdatedAt: r.updatedAt };
      }
    } else {
      unsynced.delete(pid);
      const localAt = localMeta?.localUpdatedAt ?? 0;
      const knownAt = localMeta?.serverUpdatedAt ?? 0;

      if (entry.updatedAt > localAt) {
        const r = await apiGet<RemotePuzzle>(`/user/${userId}/puzzle/${pid}`);
        if (r && !r.deletedAt) {
          if (localAt > knownAt) overwritten.push(pid);
          result.push(r.data);
          meta.puzzles[pid] = { localUpdatedAt: r.updatedAt, serverUpdatedAt: r.updatedAt };
        }
      } else {
        result.push(local);
        if (localAt > knownAt) {
          const r = await apiPut<RemotePuzzle>(`/user/${userId}/puzzle/${pid}`, { data: local });
          meta.puzzles[pid] = { localUpdatedAt: r.updatedAt, serverUpdatedAt: r.updatedAt };
        }
      }
    }
  }

  for (const [pid, game] of unsynced) {
    result.push(game);
    const r = await apiPut<RemotePuzzle>(`/user/${userId}/puzzle/${pid}`, { data: game });
    meta.puzzles[pid] = { localUpdatedAt: r.updatedAt, serverUpdatedAt: r.updatedAt };
  }

  localStorage.setItem('sudoku_saved_games', JSON.stringify(result));
  return overwritten;
}

// Clears — Union merge (append-only)
async function syncClears(userId: string, meta: SyncMeta): Promise<void> {
  const remote = await apiGet<RemoteClears>(`/user/${userId}/clears`);
  const localLogs = loadHistory().map(toLog);

  const map = new Map<string, ClearLog>();
  for (const log of [...(remote?.logs ?? []), ...localLogs]) map.set(log.id, log);
  const merged = [...map.values()].sort((a, b) => b.date - a.date).slice(0, 100);

  const r = await apiPut<RemoteClears>(`/user/${userId}/clears`, { logs: merged });
  localStorage.setItem('sudoku_history', JSON.stringify(merged.map(fromLog)));
  meta.clears = { serverUpdatedAt: r.updatedAt };
}

// ── Public sync API ───────────────────────────────────────────────────────────

export interface SyncResult {
  overwritten: string[];
}

export async function syncAll(userId: string): Promise<SyncResult> {
  if (!SYNC_URL) throw new Error('VITE_SYNC_URL not configured');

  const meta = loadMeta();
  const isNewDevice = meta.lastSyncAt === 0 && !loadSavedGames().length && !loadHistory().length;

  if (isNewDevice) {
    await fullPull(userId, meta);
    meta.lastSyncAt = Date.now();
    saveMeta(meta);
    return { overwritten: [] };
  }

  const overwritten = await syncPuzzles(userId, meta);
  await syncSettings(userId, meta);
  await syncClears(userId, meta);
  meta.lastSyncAt = Date.now();
  saveMeta(meta);
  return { overwritten };
}

// Quick sync after puzzle clear (best-effort, no session needed)
export async function syncOnClear(userId: string, puzzleId: string): Promise<void> {
  if (!SYNC_URL) return;
  try {
    const meta = loadMeta();
    await syncClears(userId, meta);
    const del = meta.deletedPuzzles[puzzleId];
    if (del && !del.pushed) {
      await apiPut(`/user/${userId}/puzzle/${puzzleId}`, { deletedAt: del.deletedAt });
      meta.deletedPuzzles[puzzleId] = { ...del, pushed: true };
    }
    meta.lastSyncAt = Date.now();
    saveMeta(meta);
  } catch (e) {
    console.warn('syncOnClear failed', e);
  }
}

// ── Page lifecycle ────────────────────────────────────────────────────────────

export function setupPageLifecycle(userId: string, onSyncDone?: () => void): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !SYNC_URL) return;
    void (async () => {
      try {
        const meta = loadMeta();
        await syncSettings(userId, meta);
        await syncClears(userId, meta);
        saveMeta(meta);
        onSyncDone?.();
      } catch { /* ignore */ }
    })();
  });
}

// ── Util ──────────────────────────────────────────────────────────────────────

export function lastSyncAt(): number {
  return loadMeta().lastSyncAt;
}

export const hasSyncUrl = (): boolean => SYNC_URL !== '';
