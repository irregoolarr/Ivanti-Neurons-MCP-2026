/**
 * Talks to Ivanti's hosted MCP servers (one per domain) with the user's Ivanti access token.
 */
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { domainUrl, getConfig, type Domain } from "./config.js";

/** The Ivanti token was rejected; the MCP client must sign in again. */
export class UpstreamAuthError extends Error {}

const LIST_TIMEOUT_MS = 25_000;
const CALL_TIMEOUT_MS = 240_000;
const CACHE_TTL_MS = 5 * 60_000;

const SEP = "__";

export function exposedToolName(domain: Domain, name: string): string {
  return `${domain.prefix}${SEP}${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export function statusOf(err: unknown): number | undefined {
  if (err instanceof StreamableHTTPError) return err.code;
  const m = err instanceof Error ? err.message.match(/HTTP (\d{3})/) : null;
  return m ? Number(m[1]) : undefined;
}

export async function withClient<T>(domain: Domain, token: string, timeout: number, fn: (c: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(domainUrl(domain)), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "ivanti-neurons-gateway", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout });
    return await fn(client);
  } catch (err) {
    if (statusOf(err) === 401) throw new UpstreamAuthError(`Ivanti rejected the access token (${domain.id})`);
    throw err;
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

/* ------------------------------ tool listing ------------------------------ */

const toolCache = new Map<string, { tools: Tool[]; expires: number }>();
const tokenKey = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 32);

async function listDomainTools(domain: Domain, token: string): Promise<Tool[]> {
  const key = `${tokenKey(token)}:${domain.id}`;
  const hit = toolCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.tools;

  const tools = await withClient(domain, token, LIST_TIMEOUT_MS, async (client) => {
    const all: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: LIST_TIMEOUT_MS });
      all.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  });

  if (toolCache.size > 500) toolCache.clear();
  toolCache.set(key, { tools, expires: Date.now() + CACHE_TTL_MS });
  return tools;
}

export interface DomainStatus {
  domain: string;
  url: string;
  ok: boolean;
  toolCount?: number;
  error?: string;
}

export async function listAllTools(token: string): Promise<{ tools: Tool[]; status: DomainStatus[] }> {
  const { domains } = getConfig();
  const results = await Promise.allSettled(domains.map((d) => listDomainTools(d, token)));

  const tools: Tool[] = [];
  const status: DomainStatus[] = [];
  results.forEach((r, i) => {
    const d = domains[i];
    if (r.status === "fulfilled") {
      status.push({ domain: d.id, url: domainUrl(d), ok: true, toolCount: r.value.length });
      for (const t of r.value) {
        tools.push({
          ...t,
          name: exposedToolName(d, t.name),
          title: t.title ? `${t.title} (${d.label})` : undefined,
          description: `[Ivanti ${d.label}] ${t.description ?? ""}`.trim(),
        });
      }
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      status.push({ domain: d.id, url: domainUrl(d), ok: false, error: reason });
      console.warn(`[ivanti-gateway] domain ${d.id} unavailable: ${reason}`);
    }
  });

  // Every domain rejected the token -> make the client sign in again.
  if (results.every((r) => r.status === "rejected") && results.some((r) => r.status === "rejected" && r.reason instanceof UpstreamAuthError)) {
    throw new UpstreamAuthError("Ivanti rejected the access token");
  }
  return { tools, status };
}

/* ------------------------------- tool calls ------------------------------- */

export async function callTool(token: string, exposedName: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const { domains } = getConfig();
  const domain = domains.find((d) => exposedName.startsWith(`${d.prefix}${SEP}`));
  if (!domain) {
    return { content: [{ type: "text", text: `Unknown tool: ${exposedName}` }], isError: true };
  }

  // Map the exposed name back to Ivanti's name (exposed names may be sanitized/truncated).
  let originalName = exposedName.slice(domain.prefix.length + SEP.length);
  try {
    const match = (await listDomainTools(domain, token)).find((t) => exposedToolName(domain, t.name) === exposedName);
    if (match) originalName = match.name;
  } catch (err) {
    if (err instanceof UpstreamAuthError) throw err;
  }

  try {
    return (await withClient(domain, token, CALL_TIMEOUT_MS, (client) =>
      client.callTool({ name: originalName, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS }),
    )) as CallToolResult;
  } catch (err) {
    if (err instanceof UpstreamAuthError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Ivanti ${domain.label} MCP server error: ${msg}` }], isError: true };
  }
}
