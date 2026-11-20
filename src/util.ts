import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfig } from "./config.js";

/** Vercel adds a parsed `body`; the local dev server doesn't. */
export type Req = IncomingMessage & { body?: unknown };

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export async function readRawBody(req: Req): Promise<string> {
  // On Vercel, `req.body` is a lazy getter that may already have consumed the stream.
  let parsed: unknown;
  try {
    parsed = req.body;
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    if (typeof parsed === "string") return parsed;
    if (Buffer.isBuffer(parsed)) return parsed.toString("utf8");
    return JSON.stringify(parsed);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads an x-www-form-urlencoded (or JSON) body as URLSearchParams. */
export async function readFormBody(req: Req): Promise<URLSearchParams> {
  let parsed: unknown;
  try {
    parsed = req.body;
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Buffer.isBuffer(parsed)) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
      else if (v !== undefined && v !== null) p.set(k, String(v));
    }
    return p;
  }
  const raw = await readRawBody(req);
  const type = req.headers["content-type"] ?? "";
  if (type.includes("json") && raw) {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)]));
  }
  return new URLSearchParams(raw);
}

/** Public origin of this deployment, e.g. https://my-app.vercel.app */
export function publicBaseUrl(req: Req): string {
  const fromEnv = getConfig().publicBaseUrl;
  if (fromEnv) return fromEnv;
  const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.split(",")[0]?.trim();
  const host = first(req.headers["x-forwarded-host"]) ?? first(req.headers.host) ?? "localhost";
  const proto =
    first(req.headers["x-forwarded-proto"]) ?? (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}
