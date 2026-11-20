/**
 * Stateless MCP endpoint (Streamable HTTP, JSON responses) that merges the tools of all
 * Ivanti MCP domains. JSON-RPC is handled directly so that an expired Ivanti token can be
 * reported as HTTP 401, which tells the MCP client to sign the user in again.
 */
import type { ServerResponse } from "node:http";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "./config.js";
import { UpstreamAuthError, callTool, listAllTools } from "./upstream.js";
import { readRawBody, sendJson, type Req } from "./util.js";

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const STATUS_TOOL: Tool = {
  name: "ivanti_connection_status",
  title: "Ivanti connection status",
  description:
    "Shows which Ivanti Neurons MCP domains (device, dataservices, patch, exposures, software-inventory, " +
    "software-distribution, reporting) are reachable with your sign-in, and how many tools each provides.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

function instructions(): string {
  const names = getConfig()
    .domains.map((d) => `${d.prefix}__* = ${d.label}`)
    .join(", ");
  return (
    "This server combines all Ivanti Neurons MCP servers. Tool names are prefixed by domain: " +
    `${names}. If a domain's tools are missing, call ivanti_connection_status.`
  );
}

const rpcResult = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleMessage(msg: RpcMessage, token: string) {
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ivanti-neurons-gateway", title: "Ivanti Neurons", version: "1.0.0" },
        instructions: instructions(),
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list": {
      const { tools } = await listAllTools(token);
      return rpcResult(msg.id, { tools: [...tools, STATUS_TOOL] });
    }
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === STATUS_TOOL.name) {
        const { status } = await listAllTools(token);
        return rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] });
      }
      return rpcResult(msg.id, await callTool(token, name, args));
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(req: Req, res: ServerResponse, base: string) {
  const resourceMetadata = `${base}/.well-known/oauth-protected-resource`;

  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
    sendJson(res, 405, rpcError(null, -32000, "Method not allowed"), { Allow: "POST, OPTIONS" });
    return;
  }

  const auth = req.headers.authorization;
  const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    sendJson(res, 401, rpcError(null, -32001, "Sign in to Ivanti Neurons required"), {
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
    });
    return;
  }

  let body: unknown;
  try {
    const raw = await readRawBody(req);
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, "Parse error"));
    return;
  }
  if (!body || typeof body !== "object") {
    sendJson(res, 400, rpcError(null, -32600, "Invalid request"));
    return;
  }

  const messages = (Array.isArray(body) ? body : [body]) as RpcMessage[];
  const responses: unknown[] = [];
  try {
    for (const msg of messages) {
      if (msg.id === undefined || msg.id === null) continue; // notification or response: no reply
      responses.push(await handleMessage(msg, token));
    }
  } catch (err) {
    if (err instanceof UpstreamAuthError) {
      sendJson(res, 401, rpcError(null, -32001, "Ivanti sign-in expired or invalid"), {
        "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${resourceMetadata}"`,
      });
      return;
    }
    console.error("[ivanti-gateway] request failed", err);
    sendJson(res, 500, rpcError(null, -32603, err instanceof Error ? err.message : "Internal error"));
    return;
  }

  if (responses.length === 0) {
    res.writeHead(202).end();
    return;
  }
  sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
}
