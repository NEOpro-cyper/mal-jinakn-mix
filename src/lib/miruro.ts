import { CACHE_TTL_MS } from './config';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

// ============================================================
// MIRURO — Episodes API client (kiwi & hop providers)
// https://miruro-api-theta.vercel.app/episodes/{anilistId}
// ============================================================

export const MIRURO_BASE = process.env.MIRURO_URL || 'https://miruro-api-theta.vercel.app';
const PROVIDERS = ['kiwi', 'hop'] as const;
type Provider = (typeof PROVIDERS)[number];

// --- In-memory cache (separate from anilist cache) ---
const miruroCache = new Map<string, { data: unknown; ts: number }>();

function getMiruroCached(key: string): unknown | null {
  const entry = miruroCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  if (entry) miruroCache.delete(key);
  return null;
}

function setMiruroCache(key: string, data: unknown): void {
  if (miruroCache.size > 200) {
    const oldest = miruroCache.keys().next().value;
    if (oldest) miruroCache.delete(oldest);
  }
  miruroCache.set(key, { data, ts: Date.now() });
}

// --- Miruro API types ---

interface MiruroEpisode {
  id: string;
  number: number;
  title: string | null;
  airDate: string | null;
  duration: number;
  audio: string;
  description: string | null;
  filler: boolean;
  uncensored: boolean;
  image: string | null;
  url?: string;
}

interface MiruroProvider {
  meta: {
    id: string;
    title: string;
    japanese?: string;
    image?: string;
    type: string;
    description?: string;
    genre?: string;
    released?: string;
    status?: string;
    totalEpisodes?: number;
    currentEpisode?: number;
  };
  episodes: {
    sub?: MiruroEpisode[];
    dub?: MiruroEpisode[];
    [lang: string]: MiruroEpisode[] | undefined;
  };
}

interface MiruroResponse {
  mappings?: Record<string, unknown>;
  providers?: Record<string, MiruroProvider>;
  [provider: string]: unknown;
}

// --- Fetch episodes from Miruro ---
//
// Miruro expects an AniList ID, but our app now uses MAL IDs as the
// primary key. Callers should pass the AniList ID when known; if only a
// MAL ID is available, the caller must look up the AniList ID via Jikan's
// /anime/{malId}/external endpoint first.

export async function fetchMiruroEpisodes(anilistId: string | number): Promise<Record<string, unknown>> {
  const cacheKey = `miruro:eps:${anilistId}`;
  const cached = getMiruroCached(cacheKey);
  if (cached) return cached as MiruroResponse;

  const target = new URL(`${MIRURO_BASE}/episodes/${anilistId}`);
  const lib = target.protocol === 'https:' ? https : http;

  // Use https.request directly — same reasoning as malFetch: undici fetch's
  // happy-eyeballs connect fails on hosts that resolve to an IPv6 address
  // (which the sandbox can't route) within ~250ms. Miruro is hosted on Vercel
  // which uses both IPv4 and IPv6.
  const body = await new Promise<string>((resolve, reject) => {
    const opts = {
      method: 'GET',
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      family: 4,                  // IPv4 only — sandbox has no IPv6 route
      ALPNProtocols: ['http/1.1'],
      timeout: 15000,
    } as https.RequestOptions;
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c.toString('utf8')));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Miruro request timeout')));
    req.end();
  });

  let raw: MiruroResponse;
  try {
    raw = JSON.parse(body) as MiruroResponse;
  } catch {
    throw new Error(`Miruro returned non-JSON response: ${body.slice(0, 200)}`);
  }
  // Miruro wraps providers under a "providers" key now
  const data = raw.providers || raw;
  setMiruroCache(cacheKey, data);
  return data;
}

// --- Extract providers (kiwi, hop) ---

export function extractProviders(data: Record<string, unknown>) {
  const result: Record<Provider, MiruroProvider | null> = {
    kiwi: null,
    hop: null,
  };

  for (const provider of PROVIDERS) {
    if (data[provider]) {
      result[provider] = data[provider] as MiruroProvider;
    }
  }

  return result;
}

// --- Build server list in server.php format ---
// Returns { success, sub: [{serverName, serverId, episodes}], dub: [...], multi: [] }

interface ServerEntry {
  serverName: string;
  serverId: string;
  episodes: MiruroEpisode[];
}

// Filter episodes to a specific episode number
export function filterByEpisode(
  result: { success: boolean; results: ServerResultEntry[] },
  ep: number
): { success: boolean; results: ServerResultEntry[] } {
  if (!ep || ep < 1) return result;
  return {
    success: true,
    results: result.results.map(s => ({
      ...s,
      episodes: s.episodes.filter(e => e.number === ep),
    })),
  };
}

export function buildServerList(
  data: Record<string, unknown>
): { success: boolean; results: ServerResultEntry[] } {
  const providers = extractProviders(data);

  const sub: ServerEntry[] = [];
  const dub: ServerEntry[] = [];
  const results: ServerResultEntry[] = [];

  for (const [providerName, provider] of Object.entries(providers)) {
    if (!provider) continue;

    // Sub episodes
    const subEps = provider.episodes?.sub;
    if (subEps && subEps.length > 0) {
      sub.push({
        serverName: capitalize(providerName),
        serverId: providerName,
        episodes: subEps,
      });
      results.push({
        type: 'sub',
        serverName: capitalize(providerName),
        server_id: providerName,
        episodes: subEps,
      });
    }

    // Dub episodes
    const dubEps = provider.episodes?.dub;
    if (dubEps && dubEps.length > 0) {
      dub.push({
        serverName: capitalize(providerName),
        serverId: providerName,
        episodes: dubEps,
      });
      results.push({
        type: 'dub',
        serverName: capitalize(providerName),
        server_id: providerName,
        episodes: dubEps,
      });
    }
  }

  // Sort all by name
  sub.sort((a, b) => a.serverName.localeCompare(b.serverName));
  dub.sort((a, b) => a.serverName.localeCompare(b.serverName));
  results.sort((a, b) => a.serverName.localeCompare(b.serverName));

  return { success: true, results };
}

interface ServerResultEntry {
  type: string;
  serverName: string;
  server_id: string;
  episodes: MiruroEpisode[];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
