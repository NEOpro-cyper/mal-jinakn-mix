import { NextRequest, NextResponse } from 'next/server';
import { parseSlug } from '@/lib/mal';
import { fetchCharactersByMalId, getCached, setCache } from '@/lib/anilist';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

function resolveId(searchParams: URLSearchParams): { malId: number; cacheKey: string } | null {
  const raw = searchParams.get('id') || searchParams.get('malId') || searchParams.get('anilistId') || '';
  if (!raw) return null;

  if (searchParams.has('malId')) {
    const n = parseInt(raw, 10);
    return (!isNaN(n) && n > 0) ? { malId: n, cacheKey: `chars:mal:${n}` } : null;
  }
  if (searchParams.has('anilistId')) {
    const n = parseInt(raw, 10);
    return (!isNaN(n) && n > 0) ? { malId: n, cacheKey: `chars:al:${n}` } : null;
  }

  const parsed = parseSlug(raw);
  if (parsed) return { malId: parsed.malId, cacheKey: `chars:slug:${raw}` };

  const n = parseInt(raw, 10);
  return (!isNaN(n) && n > 0) ? { malId: n, cacheKey: `chars:num:${n}` } : null;
}

// GET /api/characters?id=attack-on-titan-16498&page=1
// GET /api/characters?malId=16498
//
// The official MAL API v2 doesn't expose characters/voice actors (the endpoint
// was removed in 2019). We use AniList GraphQL with `idMal: {malId}` instead —
// AniList is public (no auth), has cross-references to both MAL and AniList IDs,
// and is reliable (no scraping).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const resolved = resolveId(searchParams);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const PER_PAGE = 25;

  if (!resolved) {
    return NextResponse.json({ success: false, error: 'Missing or invalid id parameter' }, { status: 400, headers: corsHeaders });
  }

  const cacheKey = `${resolved.cacheKey}:${page}`;
  const cached = await getCached(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const result = await fetchCharactersByMalId(resolved.malId, page, PER_PAGE);

    if (!result) {
      // AniList has no record of this MAL ID
      return NextResponse.json({
        success: true,
        results: {
          data: [],
          pagination: { total: 0, currentPage: page, lastPage: 1, hasNextPage: false, perPage: PER_PAGE },
        },
      }, { headers: corsHeaders });
    }

    const body = {
      success: true,
      results: {
        data: result.edges.map((edge) => ({
          character: {
            id: edge.node.id,
            poster: edge.node.image?.large || edge.node.image?.medium || '',
            name: edge.node.name?.full || '',
            cast: edge.role || 'Supporting',
          },
          voiceActors: edge.voiceActors.map((va) => ({
            id: va.id,
            poster: va.image?.large || va.image?.medium || '',
            name: va.name?.full || '',
          })),
        })),
        pagination: {
          total: result.pageInfo.total,
          currentPage: result.pageInfo.currentPage,
          lastPage: result.pageInfo.lastPage,
          hasNextPage: result.pageInfo.hasNextPage,
          perPage: PER_PAGE,
        },
      },
    };

    await setCache(cacheKey, [], body);

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200', ...corsHeaders },
    });
  } catch (err) {
    console.error('Characters error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500, headers: { 'Cache-Control': 'no-store', ...corsHeaders } }
    );
  }
}
