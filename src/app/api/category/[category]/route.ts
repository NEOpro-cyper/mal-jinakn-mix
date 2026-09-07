import { NextRequest, NextResponse } from 'next/server';
import { malFetch, transformMedia, MAL_LIST_FIELDS, MAL_GENRE_IDS, type MalRankingType, getCached, setCache } from '@/lib/mal';
import { fetchAnilistMediaList, transformAnilistMedia } from '@/lib/anilist';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PER_PAGE = 12;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

// ============================================================
// Category config
// ============================================================
//
// MAL's `/anime` (list) endpoint requires a `q` (search query) parameter —
// the `genres`, `media_type`, and `status` filters only work *in combination
// with* a search term, not standalone. So we split the categories into two
// groups:
//
// GROUP A — supported by MAL directly:
//   - popular, trending, airing, upcoming, tv, movie, ova, special
//     → /anime/ranking?ranking_type=...
//   - spring-2025, fall-2026, etc.
//     → /anime/season/{year}/{season}
//
// GROUP B — NOT supported by MAL (require `q`):
//   - completed (status=finished_airing)
//   - recent (order_by=start_date)
//   - ona, music, tvshort, cm, pv (no ranking_type for these)
//   - all genres (action, comedy, drama, romance, ...)
//   → fall back to AniList GraphQL `Page.media` with the equivalent filter
// ============================================================

const RANKING_CATEGORIES: Record<string, MalRankingType> = {
  popular: 'bypopularity',
  trending: 'favorite',
  upcoming: 'upcoming',
  airing: 'airing',
  movie: 'movie',
  tv: 'tv',
  ova: 'ova',
  special: 'special',
};

const SEASON_REGEX = /^(spring|summer|fall|winter)-(\d{4})$/i;

// Categories that fall back to AniList because MAL `/anime` requires `q`.
// The values are AniList GraphQL filter options.
const ANILIST_FALLBACK: Record<string, {
  genre?: string;
  format?: 'TV' | 'TV_SHORT' | 'MOVIE' | 'SPECIAL' | 'OVA' | 'ONA' | 'MUSIC';
  status?: 'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED';
  sort?: string[];
}> = {
  // Status-based
  completed: { status: 'FINISHED', sort: ['POPULARITY_DESC'] },
  airing:    { status: 'RELEASING', sort: ['POPULARITY_DESC'] }, // backup if ranking_type=airing ever breaks
  upcoming:  { status: 'NOT_YET_RELEASED', sort: ['POPULARITY_DESC'] },

  // Recent — newest by start date
  recent: { sort: ['START_DATE_DESC'] },

  // Media types not covered by /anime/ranking
  ona:     { format: 'ONA',     sort: ['POPULARITY_DESC'] },
  music:   { format: 'MUSIC',   sort: ['POPULARITY_DESC'] },
  tvshort: { format: 'TV_SHORT', sort: ['POPULARITY_DESC'] },
  cm:      { format: 'TV_SHORT', sort: ['POPULARITY_DESC'] },
  pv:      { format: 'TV_SHORT', sort: ['POPULARITY_DESC'] },
};

async function fetchCategory(
  category: string,
  page: number
): Promise<{ data: any[]; hasNextPage: boolean; backend: 'mal' | 'anilist' } | null> {
  const slug = category.toLowerCase();
  const offset = (page - 1) * PER_PAGE;

  // --- GROUP A: MAL ranking endpoint ---
  if (RANKING_CATEGORIES[slug]) {
    const res = await malFetch<{ data: Array<{ node: any }>; paging?: { next?: string } }>(
      '/anime/ranking',
      {
        ranking_type: RANKING_CATEGORIES[slug],
        limit: PER_PAGE,
        offset,
        fields: MAL_LIST_FIELDS,
        nsfw: 'false',
      },
      15000
    );
    return {
      data: (res.data || []).map((i) => i.node),
      hasNextPage: !!res.paging?.next,
      backend: 'mal',
    };
  }

  // --- GROUP A: MAL seasonal endpoint ---
  const seasonMatch = slug.match(SEASON_REGEX);
  if (seasonMatch) {
    const season = seasonMatch[1].toLowerCase();
    const year = parseInt(seasonMatch[2], 10);
    const res = await malFetch<{ data: Array<{ node: any }>; paging?: { next?: string } }>(
      `/anime/season/${year}/${season}`,
      {
        limit: PER_PAGE,
        offset,
        fields: MAL_LIST_FIELDS,
        nsfw: 'false',
      },
      15000
    );
    return {
      data: (res.data || []).map((i) => i.node),
      hasNextPage: !!res.paging?.next,
      backend: 'mal',
    };
  }

  // --- GROUP B: AniList fallback for status / recent / unsupported media types ---
  if (ANILIST_FALLBACK[slug]) {
    const f = ANILIST_FALLBACK[slug];
    const result = await fetchAnilistMediaList({
      page,
      perPage: PER_PAGE,
      genre: f.genre,
      format: f.format,
      status: f.status,
      sort: f.sort,
    });
    return {
      data: result.media.map(transformAnilistMedia),
      hasNextPage: result.pageInfo.hasNextPage,
      backend: 'anilist',
    };
  }

  // --- GROUP B: genre-based categories (action, comedy, drama, romance, ...) ---
  // The slug maps to a MAL genre ID via MAL_GENRE_IDS, but we use AniList
  // because MAL's `/anime?genres=` requires a `q` parameter.
  const slugNoDash = slug.replace(/-/g, '');
  const malGenreId = MAL_GENRE_IDS[slugNoDash];
  if (malGenreId) {
    // Capitalize the slug for AniList (e.g. "scifi" → "Sci-Fi", "sliceoflife" → "Slice of Life")
    const genreName = ANILIST_GENRE_NAMES[slugNoDash] || slug.charAt(0).toUpperCase() + slug.slice(1);
    const result = await fetchAnilistMediaList({
      page,
      perPage: PER_PAGE,
      genre: genreName,
      sort: ['POPULARITY_DESC'],
    });
    return {
      data: result.media.map(transformAnilistMedia),
      hasNextPage: result.pageInfo.hasNextPage,
      backend: 'anilist',
    };
  }

  return null;
}

// Map our slug names to AniList's exact genre strings.
// (AniList is case-sensitive and uses spaces in some genre names.)
const ANILIST_GENRE_NAMES: Record<string, string> = {
  action: 'Action',
  adventure: 'Adventure',
  avantgarde: 'Avant Garde',
  awardwinning: 'Award Winning',
  boyslove: 'Boys Love',
  comedy: 'Comedy',
  drama: 'Drama',
  fantasy: 'Fantasy',
  girlslove: 'Girls Love',
  gourmet: 'Gourmet',
  horror: 'Horror',
  mystery: 'Mystery',
  romance: 'Romance',
  scifi: 'Sci-Fi',
  sliceoflife: 'Slice of Life',
  sports: 'Sports',
  supernatural: 'Supernatural',
  suspense: 'Suspense',
  ecchi: 'Ecchi',
  erotica: 'Erotica',
  hentai: 'Hentai',
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ category: string }> }
) {
  const { category } = await params;
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);

  if (!category) {
    return NextResponse.json(
      { success: false, error: 'Missing category' },
      { status: 400, headers: corsHeaders }
    );
  }

  const cacheKey = `cat:${category}:${page}`;
  const cached = await getCached(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const result = await fetchCategory(category, page);

    if (result === null) {
      return NextResponse.json(
        { success: false, error: `Unknown category: ${category}` },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!result.data.length) {
      const body = { success: true, results: { data: [], totalPages: 1 } };
      return NextResponse.json(body, { headers: corsHeaders });
    }

    const totalPages = result.hasNextPage ? page + 1 : page;

    const body = {
      success: true,
      results: {
        data: result.data,
        totalPages,
        // Surface which backend was used — useful for debugging.
        backend: result.backend,
      },
    };

    await setCache(cacheKey, [], body, 86400); // 24 hours

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600', ...corsHeaders },
    });
  } catch (err) {
    console.error('Category error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500, headers: { 'Cache-Control': 'no-store', ...corsHeaders } }
    );
  }
}
