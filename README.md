# Anime API — Official MAL v2 + AniList

A Next.js API backend that returns anime data in the format your existing PHP HTML pages expect — using the **official MyAnimeList API v2** (no Jikan, no scraping) as the primary source, with **AniList GraphQL** as a fallback for the data MAL doesn't expose.

## Data Sources

- **MyAnimeList Official API v2** (`https://api.myanimelist.net/v2`) — search, details, category (ranking + seasonal), episodes, schedule. Requires a free `MAL_CLIENT_ID`.
- **AniList GraphQL** (`https://graphql.anilist.co`) — characters & voice actors (MAL removed its characters endpoint in 2019), MAL→AniList ID resolution (needed by Miruro), and category fallbacks for genre/status filters that MAL's `/anime` endpoint requires `q` for.
- **Miruro API** (`https://miruro-api-theta.vercel.app`) — episodes & streaming servers (Kiwi, Hop providers). Still uses AniList IDs internally; resolved from MAL via AniList GraphQL.

## Quick Start

```bash
# Install dependencies
bun install   # or npm install

# Set your MAL Client ID (free at https://myanimelist.net/apiconfig)
# Edit .env and fill in MAL_CLIENT_ID

# Development
bun run dev   # or npm run dev

# Production
bun run build && bun start
```

## Environment Variables

Create a `.env` file in the project root:

```env
# === MyAnimeList Official API v2 ===
MAL_API_URL=https://api.myanimelist.net/v2
MAL_CLIENT_ID=your-client-id-here   # free at https://myanimelist.net/apiconfig

# === AniList GraphQL (no auth needed) ===
ANILIST_URL=https://graphql.anilist.co

# === Miruro API (episodes & servers) ===
MIRURO_URL=https://miruro-api-theta.vercel.app

# === App ===
ITEMS_PER_PAGE=20
CACHE_TTL_SECONDS=300

# === Redis Cache (optional — falls back to no cache if unavailable) ===
# REDIS_URL=redis://default:password@host:6379/0

# === Webshare Rotating Proxy (optional) ===
# PROXY_HOST=
# PROXY_PORT=80
# PROXY_USER=
# PROXY_PASS=
```

## Project Structure

```
src/
├── lib/
│   ├── config.ts          # Reads .env values
│   ├── mal.ts            # MAL API v2 REST client + transforms
│   ├── anilist.ts        # AniList GraphQL client (characters, MAL→AniList lookup, category fallback)
│   ├── miruro.ts         # Miruro API client (episodes & servers)
│   ├── proxy.ts          # Webshare proxy agent (optional, defaults to direct fetch)
│   ├── redis.ts          # Redis cache with graceful fallback
│   ├── db.ts             # Prisma client (unused by API but kept for future)
│   └── utils.ts          # Shared utilities
├── app/
│   ├── page.tsx          # Built-in API test UI
│   └── api/
│       ├── search/route.ts            # MAL /anime?q=
│       ├── details/route.ts           # MAL /anime/{id}?fields=...
│       ├── characters/route.ts       # AniList GraphQL (Media.idMal)
│       ├── episodes/route.ts          # MAL /anime/{id}?fields=num_episodes
│       ├── schedule/route.ts          # MAL /anime/{id}?fields=status,broadcast
│       ├── category/[category]/route.ts # MAL /ranking + /season + AniList fallback
│       ├── servers/route.ts           # AniList MAL→AniList ID + Miruro
│       └── servers/[id]/route.ts      # Path-based version of servers
public/
.env
package.json
next.config.ts
tsconfig.json
```

## API Endpoints

### Search
```
GET /api/search?keyword=naruto&page=1
```
Search anime by keyword via MAL API v2 `/anime?q=`. Returns 20 results per page.

### Category
```
GET /api/category/{category}?page=1
```

Browse by category. Returns 12 results per page.

**Categories backed by MAL** (use `/anime/ranking`):
- `popular`, `trending`, `airing`, `upcoming`, `tv`, `movie`, `ova`, `special`

**Categories backed by MAL** (use `/anime/season`):
- `spring-2025`, `summer-2025`, `fall-2025`, `winter-2025` (any season-year combo)

**Categories backed by AniList** (MAL requires `q` for these):
- Status: `completed`, `recent`
- Media types: `ona`, `music`, `tvshort`, `cm`, `pv`
- Genres: `action`, `adventure`, `comedy`, `drama`, `fantasy`, `horror`, `mystery`, `romance`, `scifi`, `sports`, `supernatural`, `suspense`, `sliceoflife`, `ecchi`, `boyslove`, `girlslove`, `gourmet`, `avantgarde`

The response includes a `backend` field (`"mal"` or `"anilist"`) so you can see which backend served the request.

### Details
```
GET /api/details?malId=16498
GET /api/details?id=attack-on-titan-16498
GET /api/details?id=16498
```

Full anime details via MAL API v2 `/anime/{id}?fields=...`. Includes relations, recommendations, studios.

### Characters
```
GET /api/characters?malId=16498&page=1
```

Paginated character list with Japanese voice actors. Uses AniList GraphQL `Media(idMal:)` because the official MAL API removed its characters endpoint in 2019. 25 per page (client-side pagination).

### Episodes
```
GET /api/episodes?malId=16498
```

Episode list generated from MAL `num_episodes` field.

### Schedule
```
GET /api/schedule?malId=52991
```

Next episode air time. Computed from MAL `broadcast.day_of_the_week` + `broadcast.start_time` (JST → UTC) for currently-airing anime.

### Servers (Streaming)
```
GET /api/servers?malId=16498
GET /api/servers/16498
GET /api/servers/16498?ep=3
GET /api/servers?anilistId=147105   (legacy passthrough)
```

Streaming servers from Miruro. MAL ID is resolved to AniList ID via AniList GraphQL `Media(idMal:)` (cached for 30 days), then passed to Miruro.

## Slug Format

Every anime `id` field uses the format: `{anime-name}-{malId}`

Examples:
- `naruto-20`
- `attack-on-titan-16498`
- `frieren-beyond-journeys-end-52991`

All detail-dependent endpoints accept:
- Slug: `?id=attack-on-titan-16498`
- MAL ID: `?malId=16498`
- Raw number: `?id=16498`
- AniList ID (legacy): `?anilistId=147105`

## ID Fields in Responses

| Field | Description |
|-------|-------------|
| `id` | Slug format (`attack-on-titan-16498`) — used for URLs |
| `malId` | MyAnimeList numeric ID — primary key |
| `anilistId` | AniList numeric ID — populated by AniList-backed endpoints; null for MAL-only responses |

## Architecture Notes

### Why two backends?

The official MAL API v2 doesn't expose characters/voice actors (the endpoint was removed in 2019). We use AniList GraphQL with `Media(idMal:)` instead — AniList is free, requires no auth, has cross-references to both MAL and AniList IDs, and is reliable (no scraping).

AniList is also used for category fallbacks because MAL's `/anime` (list) endpoint requires a `q` parameter even though the docs say it's optional. The `genres`, `media_type`, and `status` filters only work *combined with* a search query, not standalone. So genre browsing, status-based "completed/recent", and media types without a ranking endpoint (ONA, music, TV shorts) route through AniList instead.

### IPv4-only + HTTP/1.1 ALPN

The HTTP client uses `node:https.request` directly (not `fetch`) with `family: 4` (IPv4-only) and `ALPNProtocols: ['http/1.1']`. This is necessary in sandboxed environments without IPv6 routing, and because both MAL and AniList TLS endpoints don't support HTTP/2 — Node's default `fetch` (undici) hangs for ~5s during ALPN negotiation before giving up.

### AniList 403 workaround

AniList returns HTTP 403 ("API temporarily disabled") for anonymous requests without browser-like `User-Agent`, `Origin`, and `Referer` headers. The AniList client sends these explicitly.

### Rate limiting

- MAL API v2: throttled to ~3 req/s, retry with exponential backoff on 429/5xx
- AniList: throttled to ~4 req/s, no retries needed (rarely fails)
- Miruro: per-host, no throttling

## Caching

- Redis cache (optional, falls back to no cache if unavailable)
- All responses include `Cache-Control` headers for CDN caching
- MAL→AniList ID mappings cached for 30 days (rarely change)
- Search results cached for 24 hours
- Details cached for 48 hours
- Episodes cached for 12 hours
- Schedule cached for 12 hours
- Category cached for 24 hours

## Technologies

- Next.js 16 (App Router, API Routes)
- TypeScript
- MyAnimeList Official API v2
- AniList GraphQL
- Miruro API
- ioredis (Redis cache)
- https-proxy-agent (optional Webshare proxy)
