import { DurableObject } from 'cloudflare:workers';

interface Env {
  COUNTER: DurableObjectNamespace<Counter>;
}

const MARKER = 'SERVERLESS_BUILD_DURABLE_OBJECTS_TYPESCRIPT_V1';
const MIN = -1_000_000;
const MAX = 1_000_000;
const MAX_BODY_BYTES = 1024;
const NAME = /^[A-Za-z0-9_-]{1,40}$/;

/** Every distinct name maps to a different object and its own SQLite database. */
export class Counter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
    ctx.storage.sql.exec('INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)');
  }

  read(): number {
    return this.ctx.storage.sql.exec<{ value: number }>('SELECT value FROM counter WHERE id = 1').one().value;
  }

  change(delta: 1 | -1): number | null {
    // One synchronous SQL statement makes concurrent increments/decrements atomic.
    const rows = this.ctx.storage.sql.exec<{ value: number }>(
      'UPDATE counter SET value = value + ? WHERE id = 1 AND value + ? BETWEEN ? AND ? RETURNING value',
      delta, delta, MIN, MAX,
    ).toArray();
    return rows[0]?.value ?? null;
  }

  setCount(value: number): number {
    return this.ctx.storage.sql.exec<{ value: number }>(
      'UPDATE counter SET value = ? WHERE id = 1 RETURNING value', value,
    ).one().value;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/' || path === '/health') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (path === '/health') return json({ ok: true, marker: MARKER });
      return json({
        pattern: 'SQLite-backed named counters', runtime: 'TypeScript', marker: MARKER,
        endpoints: ['GET /counter/{name}', 'POST /counter/{name}/increment',
          'POST /counter/{name}/decrement', 'POST /counter/{name}/reset', 'POST /counter/{name}/set'],
        limits: { min: MIN, max: MAX, name: '1–40 ASCII letters, numbers, hyphens, or underscores' },
        note: 'Each name has independent, persistent storage. Demo names are public; use a unique name.',
      });
    }

    const match = /^\/counter\/([^/]+)(?:\/(increment|decrement|reset|set))?$/.exec(path);
    if (!match) return json({ error: 'Not found' }, 404);
    const [, name, operation] = match;
    if (!NAME.test(name)) return json({ error: 'Name must be 1–40 ASCII letters, numbers, hyphens, or underscores.' }, 400);
    if (request.method !== (operation ? 'POST' : 'GET')) return json({ error: 'Method not allowed' }, 405);

    let value: number | undefined;
    if (operation === 'set') {
      const parsed = await parseSetValue(request);
      if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
      value = parsed.value;
    }

    const stub = env.COUNTER.getByName(name);
    let count: number | null;
    if (!operation) count = await stub.read();
    else if (operation === 'increment') count = await stub.change(1);
    else if (operation === 'decrement') count = await stub.change(-1);
    else count = await stub.setCount(operation === 'reset' ? 0 : value!);
    if (count === null) return json({ error: `Counter must stay between ${MIN} and ${MAX}.` }, 409);
    return json({ name, count, ...(operation ? { operation } : {}), marker: MARKER });
  },
};

type ParsedValue = { ok: true; value: number } | { ok: false; status: number; error: string };

async function parseSetValue(request: Request): Promise<ParsedValue> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return { ok: false, status: 400, error: 'Send a JSON object with one integer value.' };
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'JSON body exceeds 1024 bytes.' };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: 'Send a JSON object with one integer value.' };
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413, error: 'JSON body exceeds 1024 bytes.' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Object.hasOwn(body, 'value')) throw new Error('Invalid shape');
    const value = (body as { value: unknown }).value;
    if (!Number.isSafeInteger(value) || (value as number) < MIN || (value as number) > MAX) throw new Error('Invalid value');
    return { ok: true, value: value as number };
  } catch {
    return { ok: false, status: 400, error: `Value must be an integer between ${MIN} and ${MAX}.` };
  }
}

function json(data: Record<string, unknown>, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}
