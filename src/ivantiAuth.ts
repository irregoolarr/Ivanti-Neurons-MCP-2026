/**
 * Server-side Ivanti sign-in for the dashboard.
 *
 * `npm run login` signs you in once on your computer (Ivanti allows localhost redirects) and uploads the
 * refresh token here. The dashboard then trades it for access tokens as needed. Ivanti rotates refresh
 * tokens, so every new one is saved back to the store, under a lock so two requests can't race.
 */
import { getConfig } from "./config.js";
import { getIvantiAuth } from "./discovery.js";
import { getStore } from "./store.js";

const AUTH_KEY = "ivanti:auth";
const LOCK_KEY = "ivanti:auth:lock";
const AT_PREFIX = "ivanti:at:";

export interface StoredAuth {
  refreshToken: string;
  /** "shared": one access token for every domain; "per-resource": one per domain URL. */
  mode: "shared" | "per-resource";
  updatedAt: string;
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
  return getStore().get<StoredAuth>(AUTH_KEY);
}

export async function saveSignIn(refreshToken: string, mode: StoredAuth["mode"]) {
  const now = new Date().toISOString();
  const store = getStore();
  await store.set(AUTH_KEY, { refreshToken, mode, updatedAt: now, signedInAt: now } satisfies StoredAuth);
  for (const key of await accessKeys()) await store.del(key);
}

export async function clearSignIn() {
  const store = getStore();
  await store.del(AUTH_KEY);
  for (const key of await accessKeys()) await store.del(key);
}

async function accessKeys(): Promise<string[]> {
  return ["default", ...getConfig().domains.map((d) => d.id)].map((k) => AT_PREFIX + k);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Calls Ivanti's token endpoint with a refresh token (optionally narrowed to one resource). */
export async function refreshWithIvanti(refreshToken: string, resource?: string): Promise<TokenResponse> {
  const { tokenEndpoint } = await getIvantiAuth();
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: getConfig().clientId });
  if (resource) body.set("resource", resource);
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

/**
 * Returns an access token usable for `domainId`'s MCP server (`domainUrl`).
 * `forceResource` asks for a token narrowed to that domain, used when a shared token was rejected.
 */
export async function getAccessToken(domainId: string, domainUrl: string, forceResource = false): Promise<string> {
  const store = getStore();
  const auth = await getStoredAuth();
  if (!auth) throw new SignInRequiredError();

  const perResource = forceResource || auth.mode === "per-resource";
  const cacheKey = AT_PREFIX + (perResource ? domainId : "default");

  const cached = await store.get<StoredAccessToken>(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  // Only one refresh at a time: rotated refresh tokens are single-use.
  for (let waited = 0; ; waited += 300) {
    if (await store.setNx(LOCK_KEY, "1", 20_000)) break;
    if (waited > 20_000) throw new Error("Timed out waiting for another Ivanti token refresh");
    await sleep(300);
    const again = await store.get<StoredAccessToken>(cacheKey);
    if (again && again.expiresAt > Date.now() + 60_000) return again.token;
  }

  try {
    const latest = (await getStoredAuth()) ?? auth;
    const t = await refreshWithIvanti(latest.refreshToken, perResource ? domainUrl : undefined);
    const ttl = Math.max((t.expires_in ?? 3600) - 60, 60);
    await store.set(cacheKey, { token: t.access_token, expiresAt: Date.now() + ttl * 1000 } satisfies StoredAccessToken, {
      ttlSeconds: ttl,
    });
    const mode = forceResource && auth.mode === "shared" ? "per-resource" : latest.mode;
    await store.set(AUTH_KEY, {
      ...latest,
      refreshToken: t.refresh_token ?? latest.refreshToken,
      mode,
      updatedAt: new Date().toISOString(),
    } satisfies StoredAuth);
    return t.access_token;
  } finally {
    await store.del(LOCK_KEY);
  }
}
