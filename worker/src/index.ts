export interface Env {
  SUDOKU_KV: KVNamespace;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Session-Token, X-Force',
};

const SESSION_TTL = 60;
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

    if ((m = p.match(/^\/session\/([^/]+)$/)))
      return UID_RE.test(m[1]) ? handleSession(request, env, m[1]) : json({ error: 'Invalid ID' }, 400);

    if ((m = p.match(/^\/session\/([^/]+)\/heartbeat$/)))
      return UID_RE.test(m[1]) ? handleHeartbeat(request, env, m[1]) : json({ error: 'Invalid ID' }, 400);

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

// ── Session ───────────────────────────────────────────────────────────────────

async function handleSession(request: Request, env: Env, uid: string): Promise<Response> {
  const key = `session:${uid}`;

  if (request.method === 'POST') {
    const force = request.headers.get('X-Force') === '1';
    const existing = await env.SUDOKU_KV.get(key);
    if (existing && !force) {
      const s = JSON.parse(existing) as { acquiredAt: number };
      return json({ conflict: true, acquiredAt: s.acquiredAt }, 409);
    }
    const token = crypto.randomUUID();
    await env.SUDOKU_KV.put(key, JSON.stringify({ token, acquiredAt: Date.now() }), {
      expirationTtl: SESSION_TTL,
    });
    return json({ ok: true, token });
  }

  if (request.method === 'DELETE') {
    const token = request.headers.get('X-Session-Token');
    const existing = await env.SUDOKU_KV.get(key);
    if (existing) {
      const s = JSON.parse(existing) as { token: string };
      if (s.token === token) await env.SUDOKU_KV.delete(key);
    }
    return json({ ok: true });
  }

  return json({ error: 'Method Not Allowed' }, 405);
}

async function handleHeartbeat(request: Request, env: Env, uid: string): Promise<Response> {
  if (request.method !== 'PUT') return json({ error: 'Method Not Allowed' }, 405);
  const key = `session:${uid}`;
  const token = request.headers.get('X-Session-Token');
  const existing = await env.SUDOKU_KV.get(key);
  if (!existing) return json({ error: 'Session expired' }, 404);
  const s = JSON.parse(existing) as { token: string };
  if (s.token !== token) return json({ error: 'Invalid token' }, 403);
  await env.SUDOKU_KV.put(key, existing, { expirationTtl: SESSION_TTL });
  return json({ ok: true });
}

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

    // Update puzzle index
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
