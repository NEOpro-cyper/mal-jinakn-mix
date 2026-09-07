import { NextRequest, NextResponse } from 'next/server';
import { malFetch, parseSlug, getCached, setCache } from '@/lib/mal';

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
    return (!isNaN(n) && n > 0) ? { malId: n, cacheKey: `sched:mal:${n}` } : null;
  }
  if (searchParams.has('anilistId')) {
    const n = parseInt(raw, 10);
    return (!isNaN(n) && n > 0) ? { malId: n, cacheKey: `sched:al:${n}` } : null;
  }

  const parsed = parseSlug(raw);
  if (parsed) return { malId: parsed.malId, cacheKey: `sched:slug:${raw}` };

  const n = parseInt(raw, 10);
  return (!isNaN(n) && n > 0) ? { malId: n, cacheKey: `sched:num:${n}` } : null;
}

// MAL API v2 returns broadcast as:
//   { day_of_the_week: "saturday", start_time: "01:35" }
// The time is in JST (UTC+9). We compute the next airing time in UTC.

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function nextAiringUtcJST(dayOfWeek: number, hour: number, minute: number): string | null {
  // JST = UTC+9
  const nowUtc = new Date();
  const nowJst = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000);
  const target = new Date(nowJst);
  target.setUTCHours(hour, minute, 0, 0);

  // Walk day-by-day until we hit the target weekday
  let diffDays = (dayOfWeek - nowJst.getUTCDay() + 7) % 7;
  if (diffDays === 0) {
    // Same weekday — check if the time has already passed in JST
    if (target.getTime() <= nowJst.getTime()) {
      diffDays = 7;
    }
  }
  target.setUTCDate(target.getUTCDate() + diffDays);

  // Convert back from JST to UTC
  const utcDate = new Date(target.getTime() - 9 * 60 * 60 * 1000);
  return utcDate.toISOString();
}

// GET /api/schedule?id=attack-on-titan-16498
// GET /api/schedule?malId=16498
//
// MAL API v2: GET /anime/{id}?fields=status,broadcast
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const resolved = resolveId(searchParams);

  if (!resolved) {
    return NextResponse.json({ success: false, error: 'Missing or invalid id parameter' }, { status: 400, headers: corsHeaders });
  }

  const cached = await getCached(resolved.cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const media = await malFetch<any>(`/anime/${resolved.malId}`, {
      fields: 'id,status,broadcast',
    });

    if (!media || !media.id) {
      return NextResponse.json({ success: false, error: 'Anime not found' }, { status: 404, headers: corsHeaders });
    }

    // Only compute a schedule when the anime is currently airing.
    const status = (media.status as string) || '';
    const broadcast = media.broadcast as { day_of_the_week?: string; start_time?: string } | null;
    let nextEpisodeSchedule: string | null = null;

    if (status === 'currently_airing' && broadcast?.day_of_the_week && broadcast?.start_time) {
      const dayOfWeek = DAY_INDEX[broadcast.day_of_the_week.toLowerCase()];
      if (dayOfWeek !== undefined) {
        const [hourStr, minuteStr] = broadcast.start_time.split(':');
        const hour = parseInt(hourStr, 10);
        const minute = parseInt(minuteStr, 10);
        if (!isNaN(hour) && !isNaN(minute)) {
          nextEpisodeSchedule = nextAiringUtcJST(dayOfWeek, hour, minute);
        }
      }
    }

    const body = { success: true, results: { nextEpisodeSchedule } };

    await setCache(resolved.cacheKey, [], body, 43200); // 12 hours

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600', ...corsHeaders },
    });
  } catch (err) {
    console.error('Schedule error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500, headers: { 'Cache-Control': 'no-store', ...corsHeaders } }
    );
  }
}
