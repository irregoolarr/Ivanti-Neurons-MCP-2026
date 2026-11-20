/**
 * Server-side Ivanti sign-in for the dashboard.
 *
 * Ivanti ties each sign-in (grant) to exactly one MCP server (RFC 8707 resource indicator), so
 * `npm run login` signs in once per domain and uploads one refresh token per domain. The dashboard
 * trades each for access tokens as needed. Ivanti rotates refresh tokens, so each new one is saved
 * back (one key per domain, under a per-domain lock, so concurrent refreshes can't clobber each other).
 */
import { getConfig } from "./config.js";
import { getIvantiAuth } from "./discovery.js";
import { getStore } from "./store.js";

const META_KEY = "ivanti:auth:v2";
const RT_PREFIX = "ivanti:rt:";
const LOCK_PREFIX = "ivanti:auth:lock:";
const AT_PREFIX = "ivanti:at:";

export interface StoredAuth {
  /** Domains that have a stored sign-in. */
  domains: string[];
  signedInAt: string;
}

interface StoredAccessToken {
  token: string;
  expiresAt: number;
}

export class SignInRequiredError extends Error {
  constructor(message = "Ivanti sign-in required. Run `npm run login` to connect the dashboard.") {
    super(message);
  }
}

export async function getStoredAuth(): Promise<StoredAuth | null> {
  return getStore().get<StoredAuth>(META_KEY);
}

export async function saveSignIn(refreshTokens: Record<string, string>) {
  const store = getStore();
  for (const d of getConfig().domains) {
    await store.del(AT_PREFIX + d.id);
    if (refreshTokens[d.id]) await store.set(RT_PREFIX + d.id, refreshTokens[d.id]);
    else await store.del(RT_PREFIX + d.id);
  }
  await store.set(META_KEY, { domains: Object.keys(refreshTokens), signedInAt: new Date().toISOString() } satisfies StoredAuth);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Calls Ivanti's token endpoint with a refresh token for one resource. */
export async function refreshWithIvanti(refreshToken: string, resource: string): Promise<TokenResponse> {
  const { tokenEndpoint } = await getIvantiAuth();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: getConfig().clientId,
    resource,
  });
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    const reason = json.error_description ?? json.error ?? `HTTP ${res.status}`;
    if (json.error === "invalid_grant") throw new SignInRequiredError(`Ivanti sign-in expired (${reason}). Run \`npm run login\` again.`);
    throw new Error(`Ivanti token refresh failed: ${reason}`);
  }
  return json;
}

/** Returns an access token for `domainId`'s MCP server (`domainUrl`). */
export async function getAccessToken(domainId: string, domainUrl: string): Promise<string> {
  const store = getStore();
  const cacheKey = AT_PREFIX + domainId;

  const cached = await store.get<StoredAccessToken>(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  // One refresh per domain at a time: rotated refresh tokens are single-use.
  const lockKey = LOCK_PREFIX + domainId;
  for (let waited = 0; ; waited += 300) {
    if (await store.setNx(lockKey, "1", 20_000)) break;
    if (waited > 20_000) throw new Error("Timed out waiting for another Ivanti token refresh");
    await sleep(300);
    const again = await store.get<StoredAccessToken>(cacheKey);
    if (again && again.expiresAt > Date.now() + 60_000) return again.token;
  }

  try {
    const refreshToken = await store.get<string>(RT_PREFIX + domainId);
    if (!refreshToken) throw new SignInRequiredError(`Not signed in to the ${domainId} domain. Run \`npm run login\`.`);
    const t = await refreshWithIvanti(refreshToken, domainUrl);
    const ttl = Math.max((t.expires_in ?? 3600) - 60, 60);
    await store.set(cacheKey, { token: t.access_token, expiresAt: Date.now() + ttl * 1000 } satisfies StoredAccessToken, {
      ttlSeconds: ttl,
    });
    if (t.refresh_token && t.refresh_token !== refreshToken) await store.set(RT_PREFIX + domainId, t.refresh_token);
    return t.access_token;
  } finally {
    await store.del(lockKey);
  }
}
