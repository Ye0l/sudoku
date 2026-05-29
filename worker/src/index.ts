export interface Env {
  SUDOKU_KV: KVNamespace;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/sync\/(.+)$/);
    if (!match) return json({ error: 'Not Found' }, 404);

    const userId = match[1];
    if (!USER_ID_RE.test(userId)) return json({ error: 'Invalid ID' }, 400);

    if (request.method === 'GET') {
      const data = await env.SUDOKU_KV.get(userId);
      return json(data ? JSON.parse(data) : null);
    }

    if (request.method === 'PUT') {
      const body = await request.text();
      if (body.length > 512 * 1024) return json({ error: 'Payload too large' }, 413);
      await env.SUDOKU_KV.put(userId, body, { expirationTtl: 60 * 60 * 24 * 365 });
      return json({ ok: true });
    }

    return json({ error: 'Method Not Allowed' }, 405);
  },
};
