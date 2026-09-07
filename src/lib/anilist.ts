import https from 'node:https';
import { URL } from 'node:url';
import { ANILIST_URL, CACHE_TTL_SECONDS } from './config';
import { redisGet, redisSet } from './redis';
import { getProxyAgent, getDirectAgent, isProxyConnectError, resolveThrottleMs, PROXY_FALLBACK_DIRECT } from './proxy';

// ============================================================
// ANILIST GraphQL — used as a fallback for:
//  1. Characters & voice actors (MAL API v2 doesn't expose them)
//  2. MAL ID → AniList ID resolution (Miruro requires AniList IDs)
//
// AniList is public (no auth). Rate limit: ~90 req/min per IP. All
// requests go through the Webshare ROTATING proxy (fresh exit IP per
// request) when configured, which lifts the per-IP cap; pacing is
// tightened accordingly and remains overridable via ANILIST_THROTTLE_MS.
// Retries: 3 attempts on 429/5xx/network errors, honoring Retry-After.
// This is more reliable than Jikan for the things the official MAL API
// can't return.
// ============================================================

function buildKey(prefix: string, ...parts: string[]): string {
  return parts.length ? `${prefix}:${parts.join(':')}` : prefix;
}

export async function getCached(prefix: string, ...parts: string[]): Promise<unknown | null> {
  return redisGet(buildKey(prefix, ...parts));
}

export async function setCache(prefix: string, parts: string[], data: unknown, ttl = CACHE_TTL_SECONDS): Promise<void> {
  await redisSet(buildKey(prefix, ...parts), data, ttl);
}

// Pacing: 120ms (~8.3 req/s) across rotating exit IPs, 250ms (~4 req/s)
// when pinned to the server's own IP (still under the 90 req/min cap).
// ANILIST_THROTTLE_MS overrides both.
export const ANILIST_RESOLVED_INTERVAL_MS = resolveThrottleMs('ANILIST_THROTTLE_MS', 120, 250);

let lastReqAt = 0;

async function throttle() {
  const now = Date.now();
  const wait = ANILIST_RESOLVED_INTERVAL_MS - (now - lastReqAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReqAt = Date.now();
}

/**
 * One HTTPS POST attempt through the given agent.
 * Returns status + headers + body so the retry loop can honor Retry-After.
 */
function httpsPostOnce(url: URL, bodyStr: string, timeoutMs: number, agent: https.Agent): Promise<{ status: number; retryAfter: number | null; body: string }> {
  return new Promise((resolve, reject) => {
    // Cast to RequestOptions — older Node typings don't include ALPNProtocols.
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // AniList returns 403 ("API temporarily disabled") when these are
        // missing — they filter anonymous requests without a browser-like UA.
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Origin: 'https://anilist.co',
        Referer: 'https://anilist.co/',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      ALPNProtocols: ['http/1.1'],
      agent,
      timeout: timeoutMs,
    } as https.RequestOptions;
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c.toString('utf8')));
      res.on('end', () => {
        const raHeader = res.headers['retry-after'];
        const retryAfter = raHeader ? parseInt(Array.isArray(raHeader) ? raHeader[0] : raHeader, 10) : null;
        resolve({
          status: res.statusCode || 0,
          retryAfter: retryAfter !== null && !isNaN(retryAfter) ? retryAfter : null,
          body: data,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`AniList request timeout after ${timeoutMs}ms`)));
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Routed POST: through the rotating proxy first; on a proxy-side failure
 * (unreachable proxy, rejected credentials/407, dropped tunnel) retry ONCE
 * direct instead of failing the whole request. Origin API statuses are
 * returned as-is — the retry loop in anilistPost owns those.
 *
 * NOTE on 407: https-proxy-agent deliberately REPLAYS the proxy's 407
 * response as the request's HTTP response (so credentials never reach a
 * misbehaving proxy — see hackerone 541502). That means "proxy rejected
 * our credentials" shows up as res.status === 407, not as a thrown error,
 * and must be handled as a proxy-side failure here.
 */
async function anilistPostRaw(url: URL, bodyStr: string, timeoutMs: number): Promise<{ status: number; retryAfter: number | null; body: string }> {
  const proxyAgent = getProxyAgent();
  if (!proxyAgent) return httpsPostOnce(url, bodyStr, timeoutMs, getDirectAgent());

  let proxied: { status: number; retryAfter: number | null; body: string };
  try {
    proxied = await httpsPostOnce(url, bodyStr, timeoutMs, proxyAgent);
  } catch (err) {
    if (!PROXY_FALLBACK_DIRECT || !isProxyConnectError(err)) throw err;
    console.warn(
      `[anilist] proxy tunnel failed (${(err as Error).message}) — falling back to direct`
    );
    return httpsPostOnce(url, bodyStr, timeoutMs, getDirectAgent());
  }

  if (proxied.status === 407) {
    console.warn('[anilist] proxy rejected credentials (HTTP 407) — check PROXY_USER/PROXY_PASS in .env');
    if (!PROXY_FALLBACK_DIRECT) return proxied;
    return httpsPostOnce(url, bodyStr, timeoutMs, getDirectAgent());
  }

  return proxied;
}

/**
 * POST with retries: 3 attempts on 429/5xx and network errors, with
 * exponential backoff — or the server-provided Retry-After when present
 * (capped at 10s so a slow caller isn't stuck for minutes).
 */
async function anilistPost(url: URL, bodyStr: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  const MAX_RETRIES = 3;
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    try {
      const res = await anilistPostRaw(url, bodyStr, timeoutMs);

      if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
        const backoffMs = res.retryAfter !== null
          ? Math.min(res.retryAfter * 1000, 10000)
          : 1000 * Math.pow(2, attempt - 1);
        console.warn(
          `[anilist] returned ${res.status} on attempt ${attempt}/${MAX_RETRIES} — retrying in ${backoffMs}ms`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        lastReqAt = 0; // reset throttle so we don't double-wait
        continue;
      }

      return { status: res.status, body: res.body };
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      const retryable = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code || '');
      if (attempt < MAX_RETRIES && retryable) {
        const backoffMs = 500 * Math.pow(2, attempt - 1);
        console.warn(
          `[anilist] network error on attempt ${attempt}/${MAX_RETRIES}: ${code || (err as Error).message} — retrying in ${backoffMs}ms`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        lastReqAt = 0;
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('anilistPost: max retries exceeded');
}

/**
 * Run an AniList GraphQL query. Returns the `data` field of the GraphQL
 * response (already unwrapped). Throws on transport errors or GraphQL errors.
 */
export async function anilistQuery<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs = 15000
): Promise<T> {
  const url = new URL(ANILIST_URL);
  const bodyStr = JSON.stringify({ query, variables });

  const res = await anilistPost(url, bodyStr, timeoutMs);

  let parsed: { data?: T; errors?: Array<{ message: string }> };
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error(`AniList returned non-JSON response: ${res.body.slice(0, 200)}`);
  }

  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`AniList GraphQL error: ${parsed.errors.map((e) => e.message).join('; ')}`);
  }

  if (!parsed.data) {
    throw new Error('AniList returned no data');
  }

  return parsed.data;
}
// ============================================================
// GraphQL queries
// ============================================================

// Look up AniList ID by MAL ID. Returns null if no match.
const ID_LOOKUP_QUERY = `
query ($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) {
    id
  }
}
`;

/**
 * Resolve a MAL ID to an AniList ID via AniList's GraphQL API.
 * Result is cached for 30 days because MAL↔AniList mappings rarely change.
 * Returns null if AniList has no record of the given MAL ID.
 */
export async function resolveAnilistId(malId: number): Promise<number | null> {
  const cacheKey = `al:mal:${malId}`;
  const cached = (await redisGet(buildKey(cacheKey))) as string | null;
  if (cached === 'null') return null;
  if (cached) return parseInt(cached, 10);

  try {
    const data = await anilistQuery<{ Media: { id: number } | null }>(ID_LOOKUP_QUERY, { idMal: malId });
    const anilistId = data.Media?.id ?? null;
    // Cache both hits and misses
    await redisSet(buildKey(cacheKey), anilistId ? String(anilistId) : 'null', 30 * 86400);
    return anilistId;
  } catch (err) {
    console.warn(`[anilist] failed to resolve MAL ${malId}:`, err);
    return null;
  }
}

// Characters + voice actors for a given MAL ID.
const CHARACTERS_QUERY = `
query ($idMal: Int, $page: Int, $perPage: Int) {
  Media(idMal: $idMal, type: ANIME) {
    id
    characters(sort: ROLE, page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage perPage }
      edges {
        role
        node {
          id
          name { full native }
          image { large medium }
        }
        voiceActors(language: JAPANESE, sort: RELEVANCE) {
          id
          name { full native }
          image { large medium }
        }
      }
    }
  }
}
`;

export interface AnilistCharacterEdge {
  role: string;
  node: { id: number; name: { full: string; native: string | null }; image: { large: string; medium: string } };
  voiceActors: Array<{
    id: number;
    name: { full: string; native: string | null };
    image: { large: string; medium: string };
  }>;
}

export interface AnilistCharacterPage {
  pageInfo: { total: number; currentPage: number; lastPage: number; hasNextPage: boolean; perPage: number };
  edges: AnilistCharacterEdge[];
}

/**
 * Fetch paginated characters + Japanese voice actors for a MAL ID.
 * Returns null if the anime isn't on AniList (rare).
 */
export async function fetchCharactersByMalId(
  malId: number,
  page: number,
  perPage = 25
): Promise<{ pageInfo: AnilistCharacterPage['pageInfo']; edges: AnilistCharacterEdge[] } | null> {
  const data = await anilistQuery<{ Media: { characters: AnilistCharacterPage } | null }>(
    CHARACTERS_QUERY,
    { idMal: malId, page, perPage }
  );

  if (!data.Media) return null;

  return {
    pageInfo: data.Media.characters.pageInfo,
    edges: data.Media.characters.edges,
  };
}

// ============================================================
// AniList anime list query — used as a fallback for category browsing
// when MAL's `/anime` endpoint refuses to filter without a `q` parameter.
// ============================================================

const ANILIST_MEDIA_LIST_QUERY = `
query ($page: Int, $perPage: Int, $genre: String, $format: MediaFormat, $status: MediaStatus, $sort: [MediaSort], $season: MediaSeason, $seasonYear: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(
      type: ANIME,
      genre: $genre,
      format: $format,
      status: $status,
      sort: $sort,
      season: $season,
      seasonYear: $seasonYear,
      isAdult: false
    ) {
      id
      idMal
      title { romaji english native }
      coverImage { extraLarge large medium }
      bannerImage
      format
      episodes
      duration
      genres
      averageScore
      popularity
      status
      season
      seasonYear
      startDate { year month day }
      studios { nodes { name } }
      nextAiringEpisode { airingAt timeUntilAiring episode }
      siteUrl
      description(asHtml: false)
    }
  }
}
`;

interface AnilistMediaListItem {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  coverImage: { extraLarge?: string; large?: string; medium?: string };
  bannerImage: string | null;
  format: string;
  episodes: number | null;
  duration: number | null;
  genres: string[];
  averageScore: number | null;
  popularity: number;
  status: string;
  season: string | null;
  seasonYear: number | null;
  startDate: { year: number | null; month: number | null; day: number | null } | null;
  studios: { nodes: Array<{ name: string }> };
  nextAiringEpisode: { airingAt: number; timeUntilAiring: number; episode: number } | null;
  siteUrl: string;
  description: string | null;
}

export interface AnilistMediaListResult {
  pageInfo: { total: number; currentPage: number; lastPage: number; hasNextPage: boolean; perPage: number };
  media: AnilistMediaListItem[];
}

/**
 * Fetch a paginated list of anime from AniList with optional filters.
 * Used as a fallback for category browsing when MAL's `/anime` endpoint
 * refuses to filter without a `q` parameter.
 */
export async function fetchAnilistMediaList(opts: {
  page: number;
  perPage: number;
  genre?: string;
  format?: 'TV' | 'TV_SHORT' | 'MOVIE' | 'SPECIAL' | 'OVA' | 'ONA' | 'MUSIC';
  status?: 'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS';
  sort?: string[]; // e.g. ['POPULARITY_DESC'], ['TRENDING_DESC'], ['START_DATE_DESC']
  season?: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
  seasonYear?: number;
}): Promise<AnilistMediaListResult> {
  const data = await anilistQuery<{ Page: AnilistMediaListResult }>(
    ANILIST_MEDIA_LIST_QUERY,
    {
      page: opts.page,
      perPage: opts.perPage,
      genre: opts.genre,
      format: opts.format,
      status: opts.status,
      sort: opts.sort,
      season: opts.season,
      seasonYear: opts.seasonYear,
    }
  );
  return data.Page;
}

/**
 * Convert an AniList media item to the same shape as MAL's `transformMedia`.
 * Imported lazily to avoid a circular dep on mal.ts.
 */
export function transformAnilistMedia(m: AnilistMediaListItem) {
  const title = m.title;
  const cover = m.coverImage;
  const displayTitle = title.english || title.romaji || title.native || 'Unknown Title';
  const malId = m.idMal ?? 0;
  const anilistId = m.id;
  const episodes = m.episodes || 0;
  const duration = m.duration || 0;
  const genres = m.genres || [];
  const studios = (m.studios?.nodes || []).map((s) => s.name);
  const format = m.format || 'TV';

  // If we have a real MAL ID, slugify with it. Otherwise use the AniList ID
  // (keeps the slug format consistent: title-{numericId}).
  const slugId = malId || anilistId;

  // AniList averageScore is 0-100; we keep it as-is (matches our internal scale).
  return {
    id: slugify(displayTitle, slugId),
    malId: malId || null,
    anilistId,
    title: displayTitle,
    japanese_title: title.native || title.romaji || '',
    poster: cover?.extraLarge || cover?.large || cover?.medium || '',
    banner: m.bannerImage || '',
    description: cleanDesc(m.description || null),
    adultContent: false,
    tvInfo: {
      showType: format,
      rating: 'PG-13',
      sub: episodes,
      dub: 0,
      duration: duration > 0 ? `${duration} min` : '',
    },
    duration: duration > 0 ? `${duration} min` : '',
    episodes,
    format,
    genres,
    averageScore: m.averageScore ?? null,
    popularity: m.popularity || 0,
    status: m.status || '',
    season: m.season || '',
    seasonYear: m.seasonYear ?? null,
    siteUrl: m.siteUrl || (malId ? `https://myanimelist.net/anime/${malId}` : `https://anilist.co/anime/${anilistId}`),
    studios,
    nextAiringEpisode: m.nextAiringEpisode || null,
  };
}

// Tiny local helpers (kept here to avoid pulling in mal.ts and creating a cycle)
function slugify(title: string, id: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `${slug}-${id}`;
}

function cleanDesc(html: string | null, max = 200): string {
  if (!html) return '';
  const t = html.replace(/<[^>]*>/g, '').replace(/\n/g, ' ').trim();
  return t.length > max ? t.substring(0, max) + '...' : t;
}
