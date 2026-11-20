/**
 * OAuth facade so MCP clients can sign in to Ivanti through this gateway.
 *
 * The gateway advertises itself as the authorization server, but every step is delegated to Ivanti:
 *  - /oauth/register  returns your AI Agent Client ID (no real client registration happens)
 *  - /oauth/authorize redirects the browser to Ivanti's sign-in page
 *  - /oauth/token     forwards the code / refresh-token exchange to Ivanti
 * The resulting Ivanti access token goes straight back to the MCP client; the gateway stores nothing.
 */
import type { ServerResponse } from "node:http";
import { getConfig } from "./config.js";
import { getIvantiAuth } from "./discovery.js";
import { readFormBody, readRawBody, sendJson, type Req } from "./util.js";

export function protectedResourceMetadata(base: string, scopes: string[]) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
    resource_name: "Ivanti Neurons (all MCP domains)",
  };
}

export function authorizationServerMetadata(base: string, scopes: string[]) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: scopes,
  };
}

/** Rewrites client-supplied OAuth params for Ivanti: fixed client_id, Ivanti-appropriate resource. */
function adaptParams(params: URLSearchParams, resources: string[]) {
  const cfg = getConfig();
  params.set("client_id", cfg.clientId);
  params.delete("client_secret");
  params.delete("resource"); // the client's resource is this gateway's URL, which Ivanti doesn't know
  const mode = cfg.resourceMode.toLowerCase();
  const values = mode === "none" ? [] : mode === "auto" ? resources : cfg.resourceMode.split(",").map((s) => s.trim());
  for (const v of values.filter(Boolean)) params.append("resource", v);
}

export async function handleRegister(req: Req, res: ServerResponse) {
  let body: Record<string, unknown> = {};
  try {
    const raw = await readRawBody(req);
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    /* ignore malformed metadata */
  }
  sendJson(res, 201, {
    client_id: getConfig().clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: body.client_name,
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

export async function handleAuthorize(req: Req, res: ServerResponse, query: URLSearchParams) {
  const ivanti = await getIvantiAuth();
  const params = new URLSearchParams(query);
  if (!params.get("redirect_uri") || params.get("response_type") !== "code") {
    sendJson(res, 400, { error: "invalid_request", error_description: "response_type=code and redirect_uri are required" });
    return;
  }
  adaptParams(params, ivanti.resources);
  if (!params.get("scope") && ivanti.scopes.length) params.set("scope", ivanti.scopes.join(" "));

  const target = new URL(ivanti.authorizationEndpoint);
  for (const [k, v] of params) target.searchParams.append(k, v);
  res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" }).end();
}

export async function handleToken(req: Req, res: ServerResponse) {
  const ivanti = await getIvantiAuth();
  const params = await readFormBody(req);
  adaptParams(params, ivanti.resources);

  let upstream: Response;
  try {
    upstream = await fetch(ivanti.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    sendJson(res, 502, { error: "temporarily_unavailable", error_description: `Ivanti token endpoint unreachable: ${String(err)}` });
    return;
  }
  const text = await upstream.text();
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });
  res.end(text);
}
