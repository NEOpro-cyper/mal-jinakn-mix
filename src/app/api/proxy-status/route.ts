import { NextResponse } from 'next/server';
import https from 'node:https';
import {
  getProxyAgent,
  getDirectAgent,
  PROXY_ENABLED,
  PROXY_FALLBACK_DIRECT,
  proxyLabel,
} from '@/lib/proxy';
import { PROXY } from '@/lib/config';
import { malFetch, MAL_RESOLVED_INTERVAL_MS } from '@/lib/mal';
import { anilistQuery, ANILIST_RESOLVED_INTERVAL_MS } from '@/lib/anilist';
import { jikanFetch, JIKAN_RESOLVED_INTERVAL_MS } from '@/lib/jikan';

// ============================================================
// GET /api/proxy-status
//
// Live verification that the Webshare rotating proxy is actually in the
// request path. Samples the public exit IP three times THROUGH the proxy
// (should return 3 different IPs in rotate-per-request mode), once
// directly (your server's real IP), and pings MAL + AniList + Jikan
// through the proxy end-to-end. No caching — always fresh.
// ============================================================

export const dynamic = 'force-dynamic';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

/** GET https://api.ipify.org/?format=json over a specific agent → the public IP. */
function fetchPublicIp(agent: https.Agent, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      hostname: 'api.ipify.org',
      port: 443,
      path: '/?format=json',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'cine-mal-api/1.0',
      },
      family: 4,
      ALPNProtocols: ['http/1.1'],
      agent,
      timeout: timeoutMs,
    } as https.RequestOptions;
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => {
        try {
          resolve(String(JSON.parse(body).ip));
        } catch {
          reject(new Error(`unexpected ipify response: ${body.slice(0, 120)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

function settledValue(r: PromiseSettledResult<string>): string {
  return r.status === 'fulfilled' ? r.value : `error: ${(r.reason as Error)?.message || 'unknown'}`;
}

export async function GET() {
  const proxyAgent = getProxyAgent();

  // Server IP + three exit-IP samples through the rotating proxy, in parallel.
  const [directRes, exit1, exit2, exit3] = await Promise.allSettled([
    fetchPublicIp(getDirectAgent()),
    proxyAgent
      ? fetchPublicIp(proxyAgent)
      : Promise.reject(new Error('proxy disabled — add PROXY_HOST/USER/PASS to .env')),
    proxyAgent
      ? fetchPublicIp(proxyAgent)
      : Promise.reject(new Error('proxy disabled')),
    proxyAgent
      ? fetchPublicIp(proxyAgent)
      : Promise.reject(new Error('proxy disabled')),
  ]);

  const exitIps = [exit1, exit2, exit3].map(settledValue);
  const successfulExits = exitIps.filter((ip) => !ip.startsWith('error:'));

  // End-to-end checks through the proxy for all three proxied sources
  // (bypasses Redis because these call the lib functions directly, below
  // the route-level cache layer).
  let malApiCheck: { ok: boolean; latencyMs?: number; error?: string };
  const t0 = Date.now();
  try {
    await malFetch('/anime', { q: 'naruto', limit: 1, fields: 'id' });
    malApiCheck = { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    malApiCheck = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }

  let anilistApiCheck: { ok: boolean; latencyMs?: number; error?: string };
  const t1 = Date.now();
  try {
    // Minimal identity query — cheap and touches the full transport path.
    await anilistQuery('query { Media(id: 16498, type: ANIME) { id } }');
    anilistApiCheck = { ok: true, latencyMs: Date.now() - t1 };
  } catch (err) {
    anilistApiCheck = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }

  let jikanApiCheck: { ok: boolean; latencyMs?: number; error?: string };
  const t2 = Date.now();
  try {
    await jikanFetch('/anime/16498', {}, 10000); // Monster — tiny, stable entry
    jikanApiCheck = { ok: true, latencyMs: Date.now() - t2 };
  } catch (err) {
    jikanApiCheck = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }

  const body = {
    proxy: {
      enabled: PROXY_ENABLED,
      label: proxyLabel(),
      endpoint: PROXY_ENABLED ? `${PROXY.host}:${PROXY.port}` : null,
      user: PROXY.user || null,
      mode: PROXY_ENABLED ? 'rotate-per-request (fresh exit IP per request)' : 'direct',
      fallbackToDirect: PROXY_FALLBACK_DIRECT,
      notProxied: ['miruro (episodes/servers — direct by design)'],
    },
    pacing: {
      mal: {
        intervalMs: MAL_RESOLVED_INTERVAL_MS,
        approxReqPerSec: Math.round((1000 / MAL_RESOLVED_INTERVAL_MS) * 10) / 10,
      },
      anilist: {
        intervalMs: ANILIST_RESOLVED_INTERVAL_MS,
        approxReqPerSec: Math.round((1000 / ANILIST_RESOLVED_INTERVAL_MS) * 10) / 10,
      },
      jikan: {
        intervalMs: JIKAN_RESOLVED_INTERVAL_MS,
        approxReqPerSec: Math.round((1000 / JIKAN_RESOLVED_INTERVAL_MS) * 10) / 10,
      },
    },
    serverIp: settledValue(directRes),
    proxyExitIps: exitIps,
    uniqueExitIps: new Set(successfulExits).size,
    rotating: PROXY_ENABLED && new Set(successfulExits).size > 1,
    malApiThroughProxy: malApiCheck,
    anilistApiThroughProxy: anilistApiCheck,
    jikanApiThroughProxy: jikanApiCheck,
    checkedAt: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store', ...corsHeaders },
  });
}
