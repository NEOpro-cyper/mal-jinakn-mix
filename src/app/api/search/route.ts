import { NextRequest, NextResponse } from 'next/server';
import { ITEMS_PER_PAGE } from '@/lib/config';
import { malFetch, transformMedia, MAL_LIST_FIELDS, getCached, setCache } from '@/lib/mal';

// Empty response helper (reused for no-results & errors)
const emptyResponse = (page: number) => ({
  success: true as const,
  results: {
    data: [],
    pagination: { total: 0, currentPage: page, lastPage: 1, hasNextPage: false, perPage: ITEMS_PER_PAGE },
  },
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

// GET /api/search?keyword=naruto&page=1
//
// MAL API v2: GET /anime?q={keyword}&limit=20&offset={(page-1)*20}&fields={list}
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const keyword = (searchParams.get('keyword') || '').trim();
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);

  if (!keyword) {
    return NextResponse.json(emptyResponse(page), {
      headers: { 'Cache-Control': 'public, s-maxage=300', ...corsHeaders },
    });
  }

  // Check cache
  const cached = await getCached('search', keyword, String(page));
  if (cached) return NextResponse.json(cached);

  try {
    const offset = (page - 1) * ITEMS_PER_PAGE;
    const res = await malFetch<{
      data: Array<{ node: any }>;
      paging?: { next?: string };
    }>('/anime', {
      q: keyword,
      limit: ITEMS_PER_PAGE,
      offset,
      fields: MAL_LIST_FIELDS,
      nsfw: 'false',
    });

    const items = res.data || [];
    if (!items.length) {
      return NextResponse.json(emptyResponse(page), { headers: corsHeaders });
    }

    // MAL doesn't return total — derive hasNextPage from the paging.next URL.
    const hasNextPage = !!res.paging?.next;

    const body = {
      success: true,
      results: {
        data: items.map((item) => transformMedia(item.node)),
        pagination: {
          total: hasNextPage ? (page + 1) * ITEMS_PER_PAGE : page * ITEMS_PER_PAGE, // estimate
          currentPage: page,
          lastPage: hasNextPage ? page + 1 : page, // estimate
          hasNextPage,
          perPage: ITEMS_PER_PAGE,
        },
      },
    };

    await setCache('search', [keyword, String(page)], body, 86400); // 24 hours

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600', ...corsHeaders },
    });
  } catch (err) {
    console.error('Search error:', err);
    return NextResponse.json(
      { ...emptyResponse(page), success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500, headers: { 'Cache-Control': 'no-store', ...corsHeaders } }
    );
  }
}
