/**
 * Discovers Ivanti's OAuth authorization server for the hosted MCP servers, following the MCP
 * authorization spec: unauthenticated request -> 401 + WWW-Authenticate resource_metadata ->
 * Protected Resource Metadata (RFC 9728) -> Authorization Server Metadata (RFC 8414 / OIDC).
 */
import { domainUrl, getConfig, type Domain } from "./config.js";

export interface DomainProbe {
  domain: string;
  url: string;
  unauthenticatedStatus?: number;
  resourceMetadataUrl?: string;
  resource?: string;
  authorizationServers?: string[];
  scopes?: string[];
  error?: string;
}

export interface IvantiAuth {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Where the endpoints came from: "env", "metadata:<url>", or "guessed". */
  source: string;
  issuer?: string;
  scopes: string[];
  resources: string[];
  probes: DomainProbe[];
}

const TIMEOUT_MS = 8000;

async function fetchJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const json = await res.json();
    return json && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseWwwAuthenticate(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const m of header.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function probeDomain(domain: Domain): Promise<DomainProbe> {
  const url = domainUrl(domain);
  const probe: DomainProbe = { domain: domain.id, url };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ivanti-gateway-probe", version: "1" } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    probe.unauthenticatedStatus = res.status;
    await res.body?.cancel().catch(() => {});
    const www = parseWwwAuthenticate(res.headers.get("www-authenticate"));
    if (www.scope) probe.scopes = www.scope.split(/\s+/).filter(Boolean);

    const u = new URL(url);
    const candidates = [
      www.resource_metadata,
      `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`,
      `${u.origin}/.well-known/oauth-protected-resource`,
    ].filter((c): c is string => !!c);

    for (const c of candidates) {
      const prm = await fetchJson(c);
      if (prm && Array.isArray(prm.authorization_servers)) {
        probe.resourceMetadataUrl = c;
        probe.resource = typeof prm.resource === "string" ? prm.resource : undefined;
        probe.authorizationServers = strArray(prm.authorization_servers);
        probe.scopes = [...new Set([...(probe.scopes ?? []), ...strArray(prm.scopes_supported)])];
        break;
      }
    }
  } catch (err) {
    probe.error = err instanceof Error ? err.message : String(err);
  }
  return probe;
}

async function fetchAuthServerMetadata(issuer: string): Promise<{ url: string; meta: Record<string, unknown> } | undefined> {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  const base = `${u.origin}${path}`;
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${base}/.well-known/openid-configuration`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${base}/.well-known/oauth-authorization-server`,
  ];
  for (const url of [...new Set(candidates)]) {
    const meta = await fetchJson(url);
    if (meta && typeof meta.authorization_endpoint === "string" && typeof meta.token_endpoint === "string") {
      return { url, meta };
    }
  }
  return undefined;
}

async function discover(): Promise<IvantiAuth> {
  const cfg = getConfig();
  const probes = await Promise.all(cfg.domains.map(probeDomain));

  const authServers = [...new Set(probes.flatMap((p) => p.authorizationServers ?? []))];
  const resources = [...new Set(probes.map((p) => p.resource).filter((r): r is string => !!r))];
  let scopes = [...new Set(probes.flatMap((p) => p.scopes ?? []))];

  let result: Omit<IvantiAuth, "scopes" | "resources" | "probes"> | undefined;

  if (cfg.authorizationEndpoint && cfg.tokenEndpoint) {
    result = { authorizationEndpoint: cfg.authorizationEndpoint, tokenEndpoint: cfg.tokenEndpoint, source: "env" };
  } else {
    for (const issuer of [...authServers, cfg.authUrl]) {
      const found = await fetchAuthServerMetadata(issuer);
      if (found) {
        result = {
          authorizationEndpoint: cfg.authorizationEndpoint ?? (found.meta.authorization_endpoint as string),
          tokenEndpoint: cfg.tokenEndpoint ?? (found.meta.token_endpoint as string),
          issuer: typeof found.meta.issuer === "string" ? found.meta.issuer : issuer,
          source: `metadata:${found.url}`,
        };
        // Ask for a refresh token when the server supports it, so users don't have to sign in again every hour.
        if (strArray(found.meta.scopes_supported).includes("offline_access") && scopes.length) {
          scopes = [...new Set([...scopes, "offline_access"])];
        }
        break;
      }
    }
  }

  // Last resort: IdentityServer-style endpoints under the Neurons Auth URL (matches the documented token URL).
  result ??= {
    authorizationEndpoint: cfg.authorizationEndpoint ?? `${cfg.authUrl}/connect/authorize`,
    tokenEndpoint: cfg.tokenEndpoint ?? `${cfg.authUrl}/connect/token`,
    source: "guessed",
  };

  if (cfg.scopes) scopes = cfg.scopes.split(/\s+/).filter(Boolean);
  return { ...result, scopes, resources, probes };
}

let cache: { value: Promise<IvantiAuth>; expires: number } | undefined;

/** Cached for 10 minutes per warm instance; failures are not cached. */
export function getIvantiAuth(): Promise<IvantiAuth> {
  if (cache && cache.expires > Date.now()) return cache.value;
  const value = discover();
  cache = { value, expires: Date.now() + 10 * 60_000 };
  value.catch(() => {
    cache = undefined;
  });
  return value;
}
