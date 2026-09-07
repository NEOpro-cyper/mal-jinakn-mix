import { NextRequest, NextResponse } from 'next/server';
import { malFetch, transformDetail, MAL_DETAIL_FIELDS, parseSlug, getCached, setCache } from '@/lib/mal';
import { getStreamingLinks, getDetailFallback } from '@/lib/jikan';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

// Resolve ID from various input formats:
//   ?id=16498 (numeric)          → MAL ID
//   ?malId=16498                 → MAL ID
//   ?anilistId=16498             → legacy: treated as MAL ID with a different cache key
//   ?id=attack-on-titan-16498    → parse MAL ID from slug
function resolveId(searchParams: URLSearchParams): { malId: number; cacheKey: string } | null {
  const raw = searchParams.get('id') || searchParams.get('malId') || searchParams.get('anilistId') || '';
  if (!raw) return null;

  if (searchParams.has('anilistId')) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return { malId: n, cacheKey: `detail:al:${n}` };
    return null;
  }

  if (searchParams.has('malId')) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return { malId: n, cacheKey: `detail:mal:${n}` };
    return null;
  }

  // id param — could be slug or number
  const parsed = parseSlug(raw);
  if (parsed) return { malId: parsed.malId, cacheKey: `detail:slug:${raw}` };

  const n = parseInt(raw, 10);
  if (!isNaN(n) && n > 0) return { malId: n, cacheKey: `detail:num:${n}` };

  return null;
}

// GET /api/details?id=attack-on-titan-16498
// GET /api/details?malId=16498
// GET /api/details?id=16498
//
// MAL API v2: GET /anime/{id}?fields={detail_fields}
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const resolved = resolveId(searchParams);

  if (!resolved) {
    return NextResponse.json({ success: false, error: 'Missing or invalid id parameter' }, { status: 400, headers: corsHeaders });
  }

  const cached = await getCached(resolved.cacheKey);
  if (cached) return NextResponse.json(cached);

  // --- Try MAL first (primary source) ---
  let anime: any = null;
  let usedFallback = false;

  try {
    const media = await malFetch<any>(`/anime/${resolved.malId}`, {
      fields: MAL_DETAIL_FIELDS,
    });

    if (!media || !media.id) {
      return NextResponse.json({ success: false, error: 'Anime not found' }, { status: 404, headers: corsHeaders });
    }

    anime = transformDetail(media);

    // Streaming links are always Jikan-sourced regardless of which path served
    // the main data — a failure here never fails the whole response.
    const streamingLinks = await getStreamingLinks(resolved.malId).catch((err) => {
      console.warn('[details] streaming links unavailable:', err instanceof Error ? err.message : err);
      return [];
    });
    anime = { ...anime, streamingLinks };
  } catch (malErr) {
    console.warn(
      '[details] MAL failed, falling back to Jikan:',
      malErr instanceof Error ? malErr.message : malErr
    );

    // --- MAL failed — fall back to Jikan's /anime/{id}/full ---
    try {
      anime = await getDetailFallback(resolved.malId);
      usedFallback = true;
    } catch (jikanErr) {
      console.error(
        '[details] Jikan fallback also failed:',
        jikanErr instanceof Error ? jikanErr.message : jikanErr
      );
      // Both sources failed — this is a real 500, nothing left to fall back to.
      return NextResponse.json(
        {
          success: false,
          error: 'Both MAL and Jikan failed to return details',
          debug: {
            malError: malErr instanceof Error ? malErr.message : String(malErr),
            jikanError: jikanErr instanceof Error ? jikanErr.message : String(jikanErr),
          },
        },
        { status: 502, headers: { 'Cache-Control': 'no-store', ...corsHeaders } }
      );
    }
  }

  const body = { success: true, anime };

  // Shorter cache TTL for fallback data (12h vs 48h) — once MAL recovers we
  // want to pick that back up sooner rather than serving stale Jikan data
  // for two full days.
  await setCache(resolved.cacheKey, [], body, usedFallback ? 43200 : 172800);

  return NextResponse.json(body, {
    headers: {
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200',
      'X-Data-Source': usedFallback ? 'jikan-fallback' : 'mal',
      ...corsHeaders,
    },
  });
}
