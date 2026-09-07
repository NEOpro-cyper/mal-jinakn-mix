import https from 'node:https';
import { URL } from 'node:url';
import { MAL_API_URL, MAL_CLIENT_ID, ITEMS_PER_PAGE, CACHE_TTL_SECONDS } from './config';
import { redisGet, redisSet } from './redis';
import { getProxyAgent, getDirectAgent, isProxyConnectError, resolveThrottleMs, PROXY_ENABLED, PROXY_FALLBACK_DIRECT, proxyLabel } from './proxy';

// ============================================================
// MAL Official API v2 — REST client + transforms
//
// Docs: https://myanimelist.net/apiconfig/references/api/v2
//
// Auth: requires `X-MAL-Client-ID` header (free, register at
// https://myanimelist.net/apiconfig). No OAuth flow needed for public
// read endpoints.
//
// Rate limit: ~2-3 req/s per IP. All requests go through the Webshare
// ROTATING proxy (fresh exit IP per request) when configured, which
// lifts the per-IP cap; pacing is tightened accordingly and remains
// overridable via MAL_THROTTLE_MS. See proxy.ts for the routing +
// direct-fallback semantics.
// ============================================================

// --- Redis cache helpers (re-exported for routes) ---

function buildKey(prefix: string, ...parts: string[]): string {
  return parts.length ? `${prefix}:${parts.join(':')}` : prefix;
}

export async function getCached(prefix: string, ...parts: string[]): Promise<unknown | null> {
  return redisGet(buildKey(prefix, ...parts));
}

export async function setCache(prefix: string, parts: string[], data: unknown, ttl = CACHE_TTL_SECONDS): Promise<void> {
  await redisSet(buildKey(prefix, ...parts), data, ttl);
}

// --- REST fetch ---
//
// Implementation notes (same as the Jikan version, since both APIs are HTTPS):
// 1. We use Node's native `https.request` (not `fetch`) because the sandbox
//    has no IPv6 route, and `fetch`'s "happy-eyeballs" connect gives up
//    after ~250ms when both IPv4 and IPv6 fail in parallel.
// 2. Force `ALPNProtocols: ['http/1.1']` to skip the slow h2 negotiation
//    that MAL's TLS endpoint doesn't support anyway.
// 3. Throttle to stay under MAL's free-tier limit (pacing auto-tightens
//    when the rotating proxy is active; override with MAL_THROTTLE_MS).
// 4. Retry on 429/5xx with exponential backoff.

// Pacing: 150ms (~6.7 req/s) across rotating exit IPs, 350ms (~2.9 req/s)
// when pinned to the server's own IP. MAL_THROTTLE_MS overrides both.
export const MAL_RESOLVED_INTERVAL_MS = resolveThrottleMs('MAL_THROTTLE_MS', 150, 350);

let lastReqAt = 0;

async function throttle() {
  const now = Date.now();
  const wait = MAL_RESOLVED_INTERVAL_MS - (now - lastReqAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReqAt = Date.now();
}

/**
 * One HTTPS GET attempt through the given agent.
 * `agent` comes from proxy.ts: the rotating proxy agent (keepAlive: false,
 * fresh exit IP per call) or the shared direct agent.
 */
function httpsGetOnce(url: URL, headers: Record<string, string>, timeoutMs: number, agent: https.Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // Type-cast to `https.RequestOptions` because older Node typings don't
    // include `ALPNProtocols` (it does work at runtime).
    const opts = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers,
      ALPNProtocols: ['http/1.1'],
      agent,
      timeout: timeoutMs,
    } as https.RequestOptions;
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', (err: NodeJS.ErrnoException) => reject(err));
    req.on('timeout', () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

/**
 * Routed GET: through the rotating proxy first; on a proxy-side failure
 * (unreachable proxy, rejected credentials/407, dropped tunnel) retry ONCE
 * direct instead of failing the whole request. Origin API statuses
 * (4xx/5xx from MAL) are returned as-is — the retry loop below owns those.
 *
 * NOTE on 407: https-proxy-agent deliberately REPLAYS the proxy's 407
 * response as the request's HTTP response (so credentials never reach a
 * misbehaving proxy — see hackerone 541502). That means "proxy rejected
 * our credentials" shows up as res.status === 407, not as a thrown error,
 * and must be handled as a proxy-side failure here.
 */
async function rawHttpsGet(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
  const proxyAgent = getProxyAgent();
  if (!proxyAgent) return httpsGetOnce(url, headers, timeoutMs, getDirectAgent());

  let proxied: { status: number; body: string };
  try {
    proxied = await httpsGetOnce(url, headers, timeoutMs, proxyAgent);
  } catch (err) {
    if (!PROXY_FALLBACK_DIRECT || !isProxyConnectError(err)) throw err;
    console.warn(
      `[mal] proxy tunnel failed (${(err as Error).message}) — falling back to direct for ${url.pathname}`
    );
    return httpsGetOnce(url, headers, timeoutMs, getDirectAgent());
  }

  if (proxied.status === 407) {
    console.warn('[mal] proxy rejected credentials (HTTP 407) — check PROXY_USER/PROXY_PASS in .env');
    if (!PROXY_FALLBACK_DIRECT) return proxied;
    return httpsGetOnce(url, headers, timeoutMs, getDirectAgent());
  }

  return proxied;
}

/**
 * Fetch a MAL API v2 endpoint.
 *
 * @param path - Path under /v2, e.g. "/anime/16498" or "/anime/ranking"
 * @param params - Query string parameters (skipped if undefined/null/empty)
 * @param timeoutMs - Per-attempt timeout in milliseconds
 */
export async function malFetch<T = Record<string, unknown>>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  timeoutMs = 15000
): Promise<T> {
  if (!MAL_CLIENT_ID) {
    throw new Error(
      'MAL_CLIENT_ID is not set. Register for free at https://myanimelist.net/apiconfig and set it in .env'
    );
  }

  const url = new URL(`${MAL_API_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const MAX_RETRIES = 3;
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    try {
      const res = await rawHttpsGet(
        url,
        {
          Accept: 'application/json',
          'X-MAL-Client-ID': MAL_CLIENT_ID,
          'User-Agent': 'cine-mal-api/1.0',
        },
        timeoutMs
      );

      if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        console.warn(
          `[mal] ${url.pathname}${url.search} returned ${res.status} on attempt ${attempt}/${MAX_RETRIES} — retrying in ${backoffMs}ms`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        lastReqAt = 0; // reset throttle so we don't double-wait
        continue;
      }

      if (res.status >= 400) {
        // Tag with a code so the catch block below does NOT retry it —
        // retrying a 400/401/403 (bad query, rejected client ID) is pointless.
        const err = new Error(`MAL API HTTP ${res.status} — ${res.body.slice(0, 300)}`) as NodeJS.ErrnoException;
        err.code = 'EMALSTATUS';
        throw err;
      }

      try {
        return JSON.parse(res.body) as T;
      } catch {
        const err = new Error(`MAL API returned non-JSON response (status ${res.status}): ${res.body.slice(0, 200)}`) as NodeJS.ErrnoException;
        err.code = 'EJSONPARSE';
        throw err;
      }
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      const retryable = !code || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code);
      if (attempt < MAX_RETRIES && retryable) {
        const backoffMs = 500 * Math.pow(2, attempt - 1);
        console.warn(
          `[mal] ${url.pathname}${url.search} network error on attempt ${attempt}/${MAX_RETRIES}: ${code || (err as Error).message} — retrying in ${backoffMs}ms`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        lastReqAt = 0;
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('malFetch: max retries exceeded');
}

// ============================================================
// TYPES — MAL API v2 response shapes (only fields we use)
// ============================================================

interface MalPicture {
  large?: string;
  medium?: string;
}

interface MalMainPicture {
  large?: string;
  medium?: string;
}

interface MalGenre {
  id: number;
  name: string;
}

interface MalStudio {
  id: number;
  name: string;
}

interface MalRelatedAnimeNode {
  node: {
    id: number;
    title: string;
    main_picture?: MalMainPicture;
    media_type?: string;
    num_episodes?: number;
    status?: string;
    start_date?: string;
    mean?: number;
  };
  relation_type?: string;
  relation_type_formatted?: string;
}

interface MalRecommendationNode {
  node: {
    id: number;
    title: string;
    main_picture?: MalMainPicture;
    media_type?: string;
    num_episodes?: number;
    mean?: number;
  };
  num_recommendations?: number;
}

interface MalAnime {
  id: number;
  title: string;
  main_picture?: MalMainPicture;
  alternative_titles?: {
    synonyms?: string[];
    en?: string;
    ja?: string;
  };
  media_type?: string;
  status?: string;
  start_date?: string;
  end_date?: string;
  synopsis?: string;
  mean?: number;
  rank?: number;
  popularity?: number;
  num_list_users?: number;
  num_scoring_users?: number;
  nsfw?: boolean;
  genres?: MalGenre[];
  num_episodes?: number;
  start_season?: { year?: number; season?: string };
  broadcast?: { day_of_the_week?: string; start_time?: string };
  source?: string;
  average_episode_duration?: number;
  rating?: string;
  pictures?: MalPicture[];
  background?: string;
  related_anime?: MalRelatedAnimeNode[];
  recommendations?: MalRecommendationNode[];
  studios?: MalStudio[];
  created_at?: string;
  updated_at?: string;
}

interface MalListResponse<T> {
  data: Array<{ node: T }>;
  paging?: {
    next?: string;
    previous?: string;
  };
  // Ranking responses also include `ranking` labels per item, but we ignore them.
}

// ============================================================
// HELPERS
// ============================================================

export function slugify(title: string, malId: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `${slug}-${malId}`;
}

export function parseSlug(slug: string): { malId: number } | null {
  const match = slug.match(/-(\d+)$/);
  if (!match) return null;
  const malId = parseInt(match[1], 10);
  if (isNaN(malId) || malId < 1) return null;
  return { malId };
}

const FORMAT_MAP: Record<string, string> = {
  tv: 'TV',
  ova: 'OVA',
  ona: 'ONA',
  movie: 'Movie',
  special: 'Special',
  music: 'Music',
  tv_special: 'TV Special',
  cm: 'CM',
  pv: 'PV',
  tv_series: 'TV',
};

function normalizeType(type: string | null | undefined): string {
  if (!type) return 'TV';
  return FORMAT_MAP[type.toLowerCase()] || type;
}

const STATUS_MAP: Record<string, string> = {
  finished_airing: 'Finished Airing',
  currently_airing: 'Currently Airing',
  not_yet_aired: 'Not yet aired',
};

function mapStatus(status: string | null | undefined): string {
  if (!status) return 'Unknown';
  return STATUS_MAP[status.toLowerCase()] || status;
}

const SEASON_MAP: Record<string, string> = {
  winter: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Fall',
};

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function cleanDesc(html: string | null, max = 200): string {
  if (!html) return '';
  const t = html.replace(/<[^>]*>/g, '').replace(/\n/g, ' ').trim();
  return t.length > max ? t.substring(0, max) + '...' : t;
}

function deriveRating(genres: string[], demographics: string[]): string {
  if (genres.includes('Hentai')) return 'Rx';
  if (genres.includes('Erotica')) return 'R+';
  if (genres.includes('Ecchi')) return 'R+';
  if (genres.includes('Horror')) return 'R';
  if (demographics.includes('Seinen')) return 'R';
  return 'PG-13';
}

function parseIsoDate(iso: string | null | undefined): { year?: number; month?: number; day?: number } {
  if (!iso) return {};
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return {};
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
  };
}

function formatDateProp(d?: { year?: number; month?: number; day?: number }): string {
  if (!d || !d.year) return '';
  const m = d.month ? MONTH_NAMES[d.month] : '';
  if (m && d.day) return `${m} ${d.day}, ${d.year}`;
  if (m) return `${m} ${d.year}`;
  return `${d.year}`;
}

function pickMainPicture(pic?: MalMainPicture): string {
  return pic?.large || pic?.medium || '';
}

function pickStudios(studios: MalStudio[] | undefined): string[] {
  return (studios || []).map((s) => s.name).filter(Boolean);
}

// ============================================================
// TRANSFORMS
// ============================================================

const LIST_FIELDS = [
  'id',
  'title',
  'main_picture',
  'alternative_titles',
  'media_type',
  'status',
  'start_date',
  'synopsis',
  'mean',
  'rank',
  'popularity',
  'num_list_users',
  'num_episodes',
  'start_season',
  'nsfw',
  'genres',
  'studios',
].join(',');

export const MAL_LIST_FIELDS = LIST_FIELDS;

const DETAIL_FIELDS = [
  'id',
  'title',
  'main_picture',
  'alternative_titles',
  'media_type',
  'status',
  'start_date',
  'end_date',
  'synopsis',
  'mean',
  'rank',
  'popularity',
  'num_list_users',
  'num_scoring_users',
  'nsfw',
  'genres',
  'num_episodes',
  'start_season',
  'broadcast',
  'source',
  'average_episode_duration',
  'rating',
  'background',
  'related_anime',
  'recommendations',
  'studios',
  'pictures',
  'created_at',
  'updated_at',
].join(',');

export const MAL_DETAIL_FIELDS = DETAIL_FIELDS;

// --- Search/category list-item transform ---

export function transformMedia(m: MalAnime) {
  const alt = m.alternative_titles || {};
  const displayTitle = alt.en || m.title || alt.ja || 'Unknown Title';
  const malId = m.id;
  const episodes = m.num_episodes || 0;
  const genres = (m.genres || []).map((g) => g.name);
  const startSeason = m.start_season || {};

  return {
    id: slugify(displayTitle, malId),
    malId,
    anilistId: null, // Resolved lazily by /api/servers if needed
    title: displayTitle,
    japanese_title: alt.ja || m.title || '',
    poster: pickMainPicture(m.main_picture),
    banner: '',
    description: cleanDesc(m.synopsis || null),
    adultContent: !!m.nsfw,
    tvInfo: {
      showType: normalizeType(m.media_type),
      rating: deriveRating(genres, []),
      sub: episodes,
      dub: 0,
      duration: m.average_episode_duration
        ? `${Math.round(m.average_episode_duration / 60)} min`
        : '',
    },
    duration: m.average_episode_duration
      ? `${Math.round(m.average_episode_duration / 60)} min`
      : '',
    episodes,
    format: normalizeType(m.media_type),
    genres,
    averageScore: m.mean ? Math.round(m.mean * 10) : null, // MAL 0–10 → 0–100 scale
    popularity: m.num_list_users || 0,
    status: mapStatus(m.status),
    season: startSeason.season ? SEASON_MAP[startSeason.season.toLowerCase()] || startSeason.season : '',
    seasonYear: startSeason.year || null,
    siteUrl: `https://myanimelist.net/anime/${malId}`,
    studios: pickStudios(m.studios),
    nextAiringEpisode: null, // Not available in list responses — computed by /api/schedule
  };
}

// --- Detail page transform ---

export function transformDetail(m: MalAnime) {
  const alt = m.alternative_titles || {};
  const displayTitle = alt.en || m.title || alt.ja || 'Unknown Title';
  const malId = m.id;
  const episodes = m.num_episodes || 0;
  const genres = (m.genres || []).map((g) => g.name);
  const synonyms = alt.synonyms || [];
  const startSeason = m.start_season || {};
  const studios = pickStudios(m.studios);

  // Producers: not separately returned by MAL API v2 (studios field includes
  // both animation studios and producers in some cases). We approximate.
  const producers: string[] = [];

  // Aired date string
  const startStr = formatDateProp(parseIsoDate(m.start_date));
  const endStr = formatDateProp(parseIsoDate(m.end_date));
  const aired = startStr ? (endStr ? `${startStr} to ${endStr}` : startStr) : '';

  // Premiered
  const season = startSeason.season || '';
  const seasonYear = startSeason.year || null;
  const premiered = season && seasonYear
    ? `${SEASON_MAP[season.toLowerCase()] || season} ${seasonYear}`
    : '';

  // Trailer — MAL API v2 doesn't return a trailer; we use the `pictures` array
  // as a banner substitute. If a YouTube ID is desired, AniList provides it.
  const trailers: Array<{ title: string; thumbnail: string; source: string }> = [];

  // Related anime → seasons (sequels, prequels, parent stories, side stories, etc.)
  const seasonRelations = (m.related_anime || [])
    .filter((r) =>
      [
        'sequel',
        'prequel',
        'parent_story',
        'side_story',
        'alternative_version',
        'alternative_setting',
        'spin_off',
        'full_story',
        'summary',
      ].includes(r.relation_type || '')
    )
    .map((r) => {
      const node = r.node;
      return {
        id: slugify(node.title, node.id),
        malId: node.id,
        anilistId: null,
        title: node.title,
        name: node.title,
        poster: pickMainPicture(node.main_picture),
      };
    });

  const currentEntry = {
    id: slugify(displayTitle, malId),
    malId,
    anilistId: null,
    title: displayTitle,
    name: m.title || '',
    poster: pickMainPicture(m.main_picture),
  };
  const allSeasons = [currentEntry, ...seasonRelations];

  // MAL score (0-10)
  const malscore = m.mean ? m.mean.toFixed(2) : '';

  return {
    id: slugify(displayTitle, malId),
    malId,
    anilistId: null, // Resolved lazily by /api/servers
    title: displayTitle,
    jname: m.title || alt.ja || '',
    japanese: alt.ja || m.title || '',
    synonyms: synonyms.length ? synonyms.join(', ') : (m.title || ''),
    overview: m.synopsis || '',
    poster: pickMainPicture(m.main_picture),
    banner: '', // MAL doesn't expose a separate banner image
    rating: m.rating || deriveRating(genres, []),
    quality: 'HD',
    subEp: episodes,
    dubEp: 0,
    showType: normalizeType(m.media_type),
    duration: m.average_episode_duration
      ? `${Math.round(m.average_episode_duration / 60)} min`
      : '',
    aired,
    premiered,
    status: mapStatus(m.status),
    malscore,
    genres,
    studio: studios.join(', '),
    producer: producers,
    season: allSeasons,
    actors: [], // Loaded lazily via /api/characters (AniList fallback)
    trailers,
    recommendedAnimes: (m.recommendations || []).map((r) => {
      const node = r.node;
      return {
        id: slugify(node.title, node.id),
        malId: node.id,
        anilistId: null,
        name: node.title,
        title: node.title,
        poster: pickMainPicture(node.main_picture),
        type: normalizeType(node.media_type),
        duration: '',
        episodes: { sub: node.num_episodes || 0, dub: 0 },
      };
    }),
    adultContent: !!m.nsfw,
    siteUrl: `https://myanimelist.net/anime/${malId}`,
    averageScore: m.mean ? Math.round(m.mean * 10) : null,
    popularity: m.num_list_users || 0,
    nextAiringEpisode: null, // Computed by /api/schedule
  };
}

// --- Episode list transform (generates from episode count) ---

export function transformEpisodeList(media: {
  id: number;
  title: string;
  alternative_titles?: { en?: string; ja?: string };
  num_episodes?: number;
}): Array<{ id: string; episode_no: number; title: string; jname: string; filler: boolean }> {
  const totalEpisodes = media.num_episodes || 0;
  const malId = media.id;
  const alt = media.alternative_titles || {};
  const animeName = alt.en || media.title || alt.ja || '';
  const animeJname = alt.ja || media.title || '';
  const animeSlug = slugify(animeName, malId);

  const episodes: Array<{ id: string; episode_no: number; title: string; jname: string; filler: boolean }> = [];
  for (let i = 1; i <= totalEpisodes; i++) {
    episodes.push({
      id: `${animeSlug}:${i}`,
      episode_no: i,
      title: `Episode ${i}`,
      jname: `${animeJname} ${i}話`,
      filler: false,
    });
  }
  return episodes;
}

// ============================================================
// MAL genre IDs (for /anime?genres= filter)
// Reference: https://myanimelist.net/anime.php?action=genre
// ============================================================

export const MAL_GENRE_IDS: Record<string, number> = {
  action: 1,
  adventure: 2,
  avantgarde: 5,
  awardwinning: 46,
  boyslove: 28,
  comedy: 4,
  drama: 8,
  fantasy: 10,
  girlslove: 26,
  gourmet: 47,
  horror: 14,
  mystery: 7,
  romance: 22,
  scifi: 24,
  sliceoflife: 36,
  sports: 30,
  supernatural: 37,
  suspense: 41,
  ecchi: 9,
  erotica: 49,
  hentai: 12,
};

// ============================================================
// MAL ranking types (for /anime/ranking?ranking_type=)
// ============================================================

export type MalRankingType =
  | 'all'
  | 'airing'
  | 'upcoming'
  | 'tv'
  | 'movie'
  | 'ova'
  | 'special'
  | 'bypopularity'
  | 'favorite';

export { ITEMS_PER_PAGE };
