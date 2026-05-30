import { SudokuGameDO } from './game-do.ts';
export { SudokuGameDO };

export interface Env {
  SUDOKU_KV: KVNamespace;
  GAME_DO: DurableObjectNamespace;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const p = url.pathname;
    let m: RegExpMatchArray | null;

    // WebSocket: game state live sync via Durable Object
    if ((m = p.match(/^\/user\/([^/]+)\/game\/([^/]+)\/ws$/))) {
      const [, uid, gid] = m;
      if (!UID_RE.test(uid) || !UID_RE.test(gid)) return json({ error: 'Invalid ID' }, 400);
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      const id = env.GAME_DO.idFromName(`${uid}:${gid}`);
      const stub = env.GAME_DO.get(id);
      return stub.fetch(request);
    }

    if ((m = p.match(/^\/user\/([^/]+)\/settings$/)))
      return UID_RE.test(m[1]) ? handleSettings(request, env, m[1]) : json({ error: 'Invalid ID' }, 400);

    if ((m = p.match(/^\/user\/([^/]+)\/puzzle-index$/))) {
      if (!UID_RE.test(m[1])) return json({ error: 'Invalid ID' }, 400);
      if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
      const data = await env.SUDOKU_KV.get(`user:${m[1]}:puzzle_index`);
      return json(data ? JSON.parse(data) : {});
    }

    if ((m = p.match(/^\/user\/([^/]+)\/puzzle\/([^/]+)$/))) {
      const [, uid, pid] = m;
      return UID_RE.test(uid) && UID_RE.test(pid)
        ? handlePuzzle(request, env, uid, pid)
        : json({ error: 'Invalid ID' }, 400);
    }

    if ((m = p.match(/^\/user\/([^/]+)\/clears$/)))
      return UID_RE.test(m[1]) ? handleClears(request, env, m[1]) : json({ error: 'Invalid ID' }, 400);

    return json({ error: 'Not Found' }, 404);
  },
};

// ── Settings ──────────────────────────────────────────────────────────────────

async function handleSettings(request: Request, env: Env, uid: string): Promise<Response> {
  const key = `user:${uid}:settings`;

  if (request.method === 'GET') {
    const data = await env.SUDOKU_KV.get(key);
    return json(data ? JSON.parse(data) : null);
  }

  if (request.method === 'PUT') {
    const body = await request.json() as { data: unknown };
    const record = { data: body.data, updatedAt: Date.now() };
    await env.SUDOKU_KV.put(key, JSON.stringify(record));
    return json(record);
  }

  return json({ error: 'Method Not Allowed' }, 405);
}

// ── Puzzle ────────────────────────────────────────────────────────────────────

async function handlePuzzle(request: Request, env: Env, uid: string, pid: string): Promise<Response> {
  const key = `user:${uid}:puzzle:${pid}`;
  const indexKey = `user:${uid}:puzzle_index`;

  if (request.method === 'GET') {
    const data = await env.SUDOKU_KV.get(key);
    return json(data ? JSON.parse(data) : null);
  }

  if (request.method === 'PUT') {
    const body = await request.json() as { data?: unknown; deletedAt?: number };
    const now = Date.now();
    const existing = await env.SUDOKU_KV.get(key);
    const prev = existing ? JSON.parse(existing) as { globalSeq?: number } : null;
    const record: Record<string, unknown> = {
      data: body.data ?? {},
      globalSeq: (prev?.globalSeq ?? 0) + 1,
      updatedAt: now,
    };
    if (body.deletedAt !== undefined) record.deletedAt = body.deletedAt;
    await env.SUDOKU_KV.put(key, JSON.stringify(record));

    const indexRaw = await env.SUDOKU_KV.get(indexKey);
    const index = (indexRaw ? JSON.parse(indexRaw) : {}) as Record<string, { updatedAt: number; deletedAt?: number }>;
    index[pid] = { updatedAt: now };
    if (body.deletedAt !== undefined) index[pid].deletedAt = body.deletedAt;
    await env.SUDOKU_KV.put(indexKey, JSON.stringify(index));

    return json(record);
  }

  return json({ error: 'Method Not Allowed' }, 405);
}

// ── Clears ────────────────────────────────────────────────────────────────────

async function handleClears(request: Request, env: Env, uid: string): Promise<Response> {
  const key = `user:${uid}:clears`;

  if (request.method === 'GET') {
    const data = await env.SUDOKU_KV.get(key);
    return json(data ? JSON.parse(data) : null);
  }

  if (request.method === 'PUT') {
    const body = await request.json() as { logs: unknown[] };
    const record = { logs: body.logs, updatedAt: Date.now() };
    await env.SUDOKU_KV.put(key, JSON.stringify(record));
    return json(record);
  }

  return json({ error: 'Method Not Allowed' }, 405);
}
