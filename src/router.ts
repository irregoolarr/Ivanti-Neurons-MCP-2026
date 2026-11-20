/**
 * Single request router used by both the Vercel function (api/index.ts) and the local dev server.
 */
import type { ServerResponse } from "node:http";
import { getConfig } from "./config.js";
import { getIvantiAuth } from "./discovery.js";
import { handleMcp } from "./mcp.js";
import { authorizationServerMetadata, handleAuthorize, handleRegister, handleToken, protectedResourceMetadata } from "./oauth.js";
import { publicBaseUrl, sendJson, type Req } from "./util.js";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate",
};

export async function route(req: Req, res: ServerResponse): Promise<void> {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  // vercel.json rewrites every path to /api/index?__path=<original path>.
  const rewritten = url.searchParams.get("__path");
  url.searchParams.delete("__path");
  const path = (rewritten !== null ? `/${rewritten.replace(/^\/+/, "")}` : url.pathname).replace(/\/+$/, "") || "/";

  try {
    getConfig(); // fail fast with a clear message if env vars are missing
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const base = publicBaseUrl(req);

  try {
    switch (path) {
      case "/mcp":
        return await handleMcp(req, res, base);

      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return sendJson(res, 200, protectedResourceMetadata(base, (await getIvantiAuth()).scopes));

      case "/.well-known/oauth-authorization-server":
      case "/.well-known/oauth-authorization-server/mcp":
      case "/.well-known/openid-configuration":
      case "/.well-known/openid-configuration/mcp":
        return sendJson(res, 200, authorizationServerMetadata(base, (await getIvantiAuth()).scopes));

      case "/oauth/register":
        return req.method === "POST" ? await handleRegister(req, res) : sendJson(res, 405, { error: "method_not_allowed" });
      case "/oauth/authorize":
        return await handleAuthorize(req, res, url.searchParams);
      case "/oauth/token":
        return req.method === "POST" ? await handleToken(req, res) : sendJson(res, 405, { error: "method_not_allowed" });

      case "/":
      case "/health": {
        const cfg = getConfig();
        const out: Record<string, unknown> = {
          ok: true,
          name: "ivanti-neurons-gateway",
          mcpUrl: `${base}/mcp`,
          domains: cfg.domains.map((d) => d.id),
        };
        // /health?probe=1 shows what was discovered about Ivanti's OAuth and MCP endpoints (no secrets involved).
        if (url.searchParams.get("probe") === "1") out.ivanti = await getIvantiAuth();
        return sendJson(res, 200, out);
      }

      default:
        return sendJson(res, 404, { error: "not_found", path });
    }
  } catch (err) {
    console.error("[ivanti-gateway]", path, err);
    if (!res.headersSent) sendJson(res, 500, { error: "server_error", error_description: err instanceof Error ? err.message : String(err) });
  }
}
