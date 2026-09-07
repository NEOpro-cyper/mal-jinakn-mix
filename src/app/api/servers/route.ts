import { NextRequest, NextResponse } from 'next/server';
import { fetchMiruroEpisodes, buildServerList, filterByEpisode } from '@/lib/miruro';
import { parseSlug } from '@/lib/mal';
import { resolveAnilistId, getCached, setCache } from '@/lib/anilist';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

// GET /api/servers?malId=16498
// GET /api/servers?anilistId=147105   (legacy — passed through to Miruro directly)
// GET /api/servers?aniId=147105        (legacy alias for anilistId)
// GET /api/servers?id=16498            (numeric → treated as MAL ID)
// GET /api/servers?id=attack-on-titan-16498  (slug → MAL ID extracted)
//
// Miruro requires an AniList ID. The official MAL API doesn't expose AniList
// cross-references, so we resolve MAL→AniList via AniList's GraphQL `Media(idMal:)`
// lookup. Result is cached for 30 days.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const malRaw = searchParams.get('malId') || searchParams.get('id');
  const anilistRaw = searchParams.get('anilistId') || searchParams.get('aniId');

  let anilistId: string | null = null;
  let malId: number | null = null;

  if (anilistRaw) {
    // Legacy: caller explicitly passed an AniList ID — pass straight through to Miruro
    const parsed = parseSlug(anilistRaw);
    anilistId = parsed ? String(parsed.malId) : (!isNaN(Number(anilistRaw)) ? anilistRaw : null);
  } else if (malRaw) {
    const parsed = parseSlug(malRaw);
    malId = parsed ? parsed.malId : (!isNaN(Number(malRaw)) ? Number(malRaw) : null);
  }

  if (!anilistId && malId === null) {
    return NextResponse.json(
      { success: false, error: 'Missing anime ID parameter (malId, anilistId, aniId, or id)' },
      { status: 400, headers: corsHeaders }
    );
  }

  // If we only have a MAL ID, resolve it to AniList ID via AniList GraphQL
  if (!anilistId && malId !== null) {
    const resolved = await resolveAnilistId(malId);
    if (!resolved) {
      return NextResponse.json(
        {
          success: false,
          error: 'No AniList ID found for this MAL ID. AniList has no record of this anime — Miruro (which requires AniList IDs) cannot be queried.',
          debug: { malId, note: 'AniList `Media(idMal: ...)` returned null.' },
        },
        { status: 404, headers: corsHeaders }
      );
    }
    anilistId = String(resolved);
  }

  if (!anilistId) {
    return NextResponse.json(
      { success: false, error: 'Invalid anime ID' },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    const epParam = searchParams.get('ep');
    const epNum = epParam ? parseInt(epParam, 10) : 0;

    const data = await fetchMiruroEpisodes(anilistId);
    const built = buildServerList(data);
    const result = epNum > 0 ? filterByEpisode(built, epNum) : built;

    if (!result.results || result.results.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'No servers available',
          debug: { anilistId, malId, note: 'Miruro returned data but no kiwi/hop episodes found' },
        },
        { status: 404, headers: corsHeaders }
      );
    }

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600', ...corsHeaders },
    });
  } catch (err) {
    console.error('Servers error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500, headers: { 'Cache-Control': 'no-store', ...corsHeaders } }
    );
  }
}
