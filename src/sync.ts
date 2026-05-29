// Cloud sync engine — Cloudflare KV backend

import type { AppSettings, GameState, GameType, Difficulty, HistoryRecord } from './types.ts';
import { loadSavedGames, loadHistory, loadSettings, saveSettings } from './storage.ts';

const SYNC_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_SYNC_URL ?? '';
const HEARTBEAT_INTERVAL = 30_000;
const AUTO_SYNC_INTERVAL = 3 * 60_000;

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

// ── Session management ────────────────────────────────────────────────────────

let sessionToken: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export class SessionConflictError extends Error {
  constructor(public readonly acquiredAt: number) {
    super('Another device has an active session');
    this.name = 'SessionConflictError';
  }
}

export async function acquireSession(userId: string): Promise<void> {
  const res = await fetch(`${SYNC_URL}/session/${userId}`, { method: 'POST' });
  const data = await res.json() as { ok: true; token: string } | { conflict: true; acquiredAt: number };
  if ('conflict' in data) throw new SessionConflictError(data.acquiredAt);
  sessionToken = data.token;
  startHeartbeat(userId);
}

export async function forceAcquireSession(userId: string): Promise<void> {
  const res = await fetch(`${SYNC_URL}/session/${userId}`, {
    method: 'POST',
    headers: { 'X-Force': '1' },
  });
  const data = await res.json() as { ok: true; token: string };
  sessionToken = data.token;
  startHeartbeat(userId);
}

export async function releaseSession(userId: string): Promise<void> {
  stopHeartbeat();
  if (!sessionToken) return;
  const token = sessionToken;
  sessionToken = null;
  await fetch(`${SYNC_URL}/session/${userId}`, {
    method: 'DELETE',
    headers: { 'X-Session-Token': token },
  }).catch(() => {});
}

function startHeartbeat(userId: string): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!sessionToken) { stopHeartbeat(); return; }
    const res = await fetch(`${SYNC_URL}/session/${userId}/heartbeat`, {
      method: 'PUT',
      headers: { 'X-Session-Token': sessionToken },
    }).catch(() => null);
    if (!res?.ok) { sessionToken = null; stopHeartbeat(); }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ── API helpers ───────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionToken) h['X-Session-Token'] = sessionToken;
  return h;
}

async function apiGet<T>(path: string): Promise<T | null> {
  const res = await fetch(`${SYNC_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json() as Promise<T | null>;
}

async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SYNC_URL}${path}`, {
    method: 'PUT',
    headers: authHeaders(),
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

// New device — just pull everything down, no merge logic
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
    // Local is newer or no remote — push
    const r = await apiPut<RemoteSettings>(`/user/${userId}/settings`, { data: localSettings });
    meta.settings = { localUpdatedAt: r.updatedAt, serverUpdatedAt: r.updatedAt };
  } else if (remote.updatedAt > knownServerAt) {
    // Remote is newer — pull
    saveSettings(remote.data);
    meta.settings = { localUpdatedAt: remote.updatedAt, serverUpdatedAt: remote.updatedAt };
  }
  // Equal — no action
}

// Puzzles — Last-Write-Wins per puzzle, Tombstone for deletes
async function syncPuzzles(userId: string, meta: SyncMeta): Promise<string[]> {
  const overwritten: string[] = [];

  // Push pending tombstones first
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
      // Remote deleted this puzzle
      if (local) overwritten.push(pid);
      unsynced.delete(pid);
      delete meta.puzzles[pid];
      continue;
    }

    if (!local) {
      // New from remote — pull
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
        // Remote is newer — pull (flag if local had unsaved changes)
        const r = await apiGet<RemotePuzzle>(`/user/${userId}/puzzle/${pid}`);
        if (r && !r.deletedAt) {
          if (localAt > knownAt) overwritten.push(pid);
          result.push(r.data);
          meta.puzzles[pid] = { localUpdatedAt: r.updatedAt, serverUpdatedAt: r.updatedAt };
        }
      } else {
        // Local is newer or same
        result.push(local);
        if (localAt > knownAt) {
          // Local changed since last sync — push
          const r = await apiPut<RemotePuzzle>(`/user/${userId}/puzzle/${pid}`, { data: local });
          meta.puzzles[pid] = { localUpdatedAt: r.updatedAt, serverUpdatedAt: r.updatedAt };
        }
      }
    }
  }

  // Local-only puzzles — push to remote
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

// Full sync (caller must hold session)
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

// Quick sync after puzzle clear (acquire own session, best-effort)
export async function syncOnClear(userId: string, puzzleId: string): Promise<void> {
  if (!SYNC_URL) return;
  try {
    await acquireSession(userId);
    const meta = loadMeta();
    await syncClears(userId, meta);
    // Push tombstone for the cleared (removed) puzzle if pending
    const del = meta.deletedPuzzles[puzzleId];
    if (del && !del.pushed) {
      await apiPut(`/user/${userId}/puzzle/${puzzleId}`, { deletedAt: del.deletedAt });
      meta.deletedPuzzles[puzzleId] = { ...del, pushed: true };
    }
    meta.lastSyncAt = Date.now();
    saveMeta(meta);
  } catch (e) {
    if (!(e instanceof SessionConflictError)) console.warn('syncOnClear failed', e);
  } finally {
    await releaseSession(userId);
  }
}

// ── Auto-sync ─────────────────────────────────────────────────────────────────

let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoSync(
  userId: string,
  onSync: (result: SyncResult) => void,
  onError: (err: Error) => void,
): void {
  if (!SYNC_URL) return;
  stopAutoSync();
  autoSyncTimer = setInterval(async () => {
    try {
      await acquireSession(userId);
      try {
        const result = await syncAll(userId);
        onSync(result);
      } finally {
        await releaseSession(userId);
      }
    } catch (e) {
      if (!(e instanceof SessionConflictError)) onError(e as Error);
      // Another device is active — silently skip this tick
    }
  }, AUTO_SYNC_INTERVAL);
}

export function stopAutoSync(): void {
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
}

// ── Page lifecycle ────────────────────────────────────────────────────────────

export function setupPageLifecycle(userId: string): void {
  const release = (): void => { void releaseSession(userId); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') release();
  });
  window.addEventListener('pagehide', release);
}

// ── Util ──────────────────────────────────────────────────────────────────────

export function lastSyncAt(): number {
  return loadMeta().lastSyncAt;
}

export const hasSyncUrl = (): boolean => SYNC_URL !== '';
