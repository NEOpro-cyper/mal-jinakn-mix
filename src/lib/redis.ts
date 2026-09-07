import Redis from 'ioredis';

// ============================================================
// REDIS — singleton client with graceful fallback
// If Redis is unavailable the app keeps running without cache
// ============================================================

let client: Redis | null = null;
let connectionFailed = false;

function getClient(): Redis | null {
  if (connectionFailed) return null;
  if (client) return client;

  const url = process.env.REDIS_URL; // e.g. redis://127.0.0.1:6379
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;

  try {
    client = url
      ? new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false })
      : new Redis({ host, port, password, lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });

    client.on('error', (err) => {
      // Log once, then stop retrying so the app stays healthy
      if (!connectionFailed) {
        console.warn('[redis] connection error — falling back to no cache:', err.message);
        connectionFailed = true;
        client?.disconnect();
        client = null;
      }
    });
  } catch (err) {
    console.warn('[redis] init error:', err);
    connectionFailed = true;
    client = null;
  }

  return client;
}

/** Store a value in Redis with TTL (seconds). Only called on successful API responses. */
export async function redisSet(key: string, data: unknown, ttlSeconds: number): Promise<void> {
  const r = getClient();
  if (!r) return;
  try {
    await r.set(`cine:${key}`, JSON.stringify(data), 'EX', ttlSeconds);
  } catch (err) {
    console.warn('[redis] set error:', err);
  }
}

/** Retrieve a cached value from Redis. Returns null on miss or error. */
export async function redisGet(key: string): Promise<unknown | null> {
  const r = getClient();
  if (!r) return null;
  try {
    const raw = await r.get(`cine:${key}`);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch (err) {
    console.warn('[redis] get error:', err);
    return null;
  }
}
