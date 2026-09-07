import { HttpsProxyAgent } from 'https-proxy-agent';
import { PROXY } from './config';

// Single proxy agent instance — reused across all API calls.
// When PROXY_HOST is empty/unset, no proxy is used (direct fetch).
let agent: HttpsProxyAgent<string> | undefined;
let initialized = false;

function makeAgent(): HttpsProxyAgent<string> | undefined {
  if (!PROXY.host || !PROXY.user || !PROXY.pass) {
    return undefined;
  }
  return new HttpsProxyAgent(PROXY.url);
}

export function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  if (!initialized) {
    agent = makeAgent();
    initialized = true;
    if (agent) {
      console.log(`[proxy] routing fetches through ${PROXY.host}:${PROXY.port}`);
    } else {
      console.log('[proxy] no proxy configured — using direct fetch');
    }
  }
  return agent;
}
