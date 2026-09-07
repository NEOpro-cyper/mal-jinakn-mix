import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'node:https';
import { PROXY } from './config';

// ============================================================
// WEBSHARE ROTATING PROXY — shared agents + fallback logic
//
// All outbound requests to MAL API v2, AniList GraphQL AND Jikan are
// routed through the Webshare rotating endpoint (p.webshare.io). With
// the `-rotate` username, Webshare assigns a FRESH EXIT IP to every
// CONNECT tunnel — so every request looks like it comes from a
// different visitor and the per-IP rate limits stop applying to a
// single address:
//   - MAL API v2:  ~2-3 req/s per IP   → effectively lifted
//   - AniList:     ~90 req/min per IP  → effectively lifted
//   - Jikan:       3 req/s + 60/min per IP → effectively lifted
//
// keepAlive is intentionally FALSE on the proxy agent: a pooled/reused
// tunnel would pin consecutive requests to one exit IP. With keepAlive
// off, every request opens a brand-new tunnel and therefore gets a
// brand-new IP (rotate-per-request mode). The direct fallback agent
// keeps keepAlive ON — there are no rotation semantics there.
//
// Resilience: if the proxy itself is unreachable or rejects our
// credentials, requests fall back to ONE direct attempt instead of
// failing (see isProxyConnectError + the routed wrappers in mal.ts /
// anilist.ts / jikan.ts). Disable with PROXY_FALLBACK_DIRECT=false.
//
// Miruro is intentionally NOT proxied (streaming provider, direct by design).
// ============================================================

// Set PROXY_ENABLED=false to force direct mode without clearing credentials.
export const PROXY_ENABLED =
  !!(PROXY.host && PROXY.user && PROXY.pass) &&
  (process.env.PROXY_ENABLED || 'true').toLowerCase() !== 'false';

// On proxy-side failure, retry the request once without the proxy.
export const PROXY_FALLBACK_DIRECT =
  (process.env.PROXY_FALLBACK_DIRECT || 'true').toLowerCase() !== 'false';

let proxyAgent: HttpsProxyAgent<string> | undefined;
let directAgent: https.Agent | undefined;

/**
 * Agent routing every request through the Webshare rotating proxy.
 * keepAlive: false → one new CONNECT tunnel per request → one new exit
 * IP per request (Webshare rotates per tunnel in `-rotate` mode).
 */
export function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  if (!PROXY_ENABLED) return undefined;
  if (!proxyAgent) {
    // The URL is typed as `http://${string}` so the options below type-check
    // against net.TcpNetConnectOpts (keepAlive/timeout) in https-proxy-agent v9.
    const proxyUrl = PROXY.url as `http://${string}`;
    proxyAgent = new HttpsProxyAgent(proxyUrl, {
      keepAlive: false, // fresh tunnel per request = fresh exit IP
      timeout: 15000,   // socket idle timeout for tunnel establishment
    });
    console.log(
      `[proxy] ON — routing requests through ${PROXY.host}:${PROXY.port} (exit IP rotates per request)`
    );
  }
  return proxyAgent;
}

/**
 * Direct (non-proxied) agent. Used when the proxy is disabled entirely,
 * or for the one-shot fallback when a proxied connect attempt fails.
 * Same tuning as the old per-client SHARED_HTTPS_AGENT.
 */
export function getDirectAgent(): https.Agent {
  if (!directAgent) {
    directAgent = new https.Agent({
      keepAlive: true,
      family: 4,                   // IPv4 only — IPv6 routing is often unavailable on VPS/sandboxes
      ALPNProtocols: ['http/1.1'], // MAL/AniList/Jikan TLS endpoints don't speak h2
    });
  }
  return directAgent;
}

// Errnos that mean "we could not establish or use the proxy tunnel" —
// as opposed to "the origin API answered with an error status".
const PROXY_CONNECT_ERRNOS = new Set([
  'ECONNREFUSED', // proxy down / port closed
  'ECONNRESET',   // tunnel dropped mid-handshake
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',    // proxy never answered
  'ENOTFOUND',    // proxy hostname unresolvable
  'EAI_AGAIN',    // transient DNS failure resolving the proxy host
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPROTO',       // TLS mismatch talking to the proxy
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * True when an error looks like a proxy-side failure (unreachable proxy,
 * dropped tunnel, TLS error to the proxy). Origin API responses
 * (HTTP 4xx/5xx from MAL/AniList/Jikan) do NOT match — those are business
 * as usual and are handled by the per-client retry/backoff logic.
 */
export function isProxyConnectError(err: unknown): boolean {
  if (!err) return false;
  const e = err as NodeJS.ErrnoException;
  if (e.code && PROXY_CONNECT_ERRNOS.has(e.code)) return true;
  const msg = (e.message || '').toLowerCase();
  return msg.includes('proxy') || msg.includes('407') || msg.includes('tunnel');
}

/** Human-readable proxy state for logs and /api/proxy-status. */
export function proxyLabel(): string {
  if (!PROXY_ENABLED) return 'direct';
  const maskedUser = PROXY.user ? `${PROXY.user.split('-')[0]}-***@` : '';
  return `${maskedUser}${PROXY.host}:${PROXY.port}`;
}

/**
 * Resolve the per-client throttle interval: an explicit env override wins,
 * otherwise pick a pacing matched to whether we're rotating exit IPs
 * (proxied) or pinned to the server's own IP (direct).
 */
export function resolveThrottleMs(envName: string, proxiedMs: number, directMs: number): number {
  const raw = process.env[envName];
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  return PROXY_ENABLED ? proxiedMs : directMs;
}
