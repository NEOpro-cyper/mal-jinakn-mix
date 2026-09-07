// All config reads from .env
// Add new endpoints' config here

export const PROXY = {
  // Empty values disable the proxy (direct fetch is used).
  host: process.env.PROXY_HOST || '',
  port: parseInt(process.env.PROXY_PORT || '80'),
  user: process.env.PROXY_USER || '',
  pass: process.env.PROXY_PASS || '',
  get url() {
    return `http://${this.user}:${this.pass}@${this.host}:${this.port}`;
  },
};

// Official MyAnimeList API v2 — requires a free Client ID from
// https://myanimelist.net/apiconfig (passed as `X-MAL-Client-ID` header).
export const MAL_API_URL = (process.env.MAL_API_URL || 'https://api.myanimelist.net/v2').replace(/\/$/, '');
export const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID || '';

// AniList GraphQL — public, no auth. Used as a fallback for:
// 1. Characters/voice actors (MAL API v2 doesn't expose these)
// 2. MAL ID → AniList ID resolution (needed by Miruro, which only accepts AniList IDs)
export const ANILIST_URL = process.env.ANILIST_URL || 'https://graphql.anilist.co';

// Miruro episodes/servers API (still uses AniList IDs internally)
export const MIRURO_URL = (process.env.MIRURO_URL || 'https://miruro-api-theta.vercel.app').replace(/\/$/, '');

// Jikan — unofficial MAL scraper API, public, no auth.
// Used as a fallback/enrichment source for things the official MAL API v2
// doesn't expose (e.g. `streaming` — MAL-reported LEGAL platform links like
// Crunchyroll/Netflix, distinct from Miruro). Strict rate limit: 3 req/s,
// 60 req/min — treat as secondary, not primary.
export const JIKAN_URL = (process.env.JIKAN_URL || 'https://api.jikan.moe/v4').replace(/\/$/, '');

export const ITEMS_PER_PAGE = parseInt(process.env.ITEMS_PER_PAGE || '20');
export const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);
export const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;
