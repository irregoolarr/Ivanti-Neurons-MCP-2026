/**
 * Builds the dashboard snapshot by calling Ivanti's hosted MCP tools with the stored sign-in.
 * - Device domain: a curated set of tools (counts, breakdowns, organization score).
 * - Other domains: every read-only summary-style tool that needs no arguments, rendered generically.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { domainUrl, getConfig, type Domain } from "./config.js";
import { SignInRequiredError, getAccessToken, getStoredAuth } from "./ivantiAuth.js";
import { getStore } from "./store.js";
import { UpstreamAuthError, withClient } from "./upstream.js";

export interface ToolRun {
  tool: string;
  title?: string;
  description?: string;
  args?: Record<string, unknown>;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface DomainData {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
  toolCount?: number;
  runs: ToolRun[];
}

export interface Snapshot {
  generatedAt: string;
  durationMs: number;
  signedInAt?: string;
  domains: DomainData[];
}

const CALL_TIMEOUT_MS = 60_000;

/** Device tools the dashboard uses, with their arguments. */
const DEVICE_CALLS: [string, Record<string, unknown>?][] = [
  ["organization_score"],
  ["device_count"],
  ["device_managed_count"],
  ["device_neurons_manageable_count"],
  ["device_recent_discovery_count"],
  ["device_recent_updates_count"],
  ["device_stale_devices_count", { days_old: 30 }],
  ["device_old_startup_count", { days_old: 30 }],
  ["device_low_disk_space_count"],
  ["device_antivirus_disabled_count"],
  ["device_warranty_expired_count"],
  ["device_warranty_expiring_count", { months_ahead: 3 }],
  ["device_os_groups", { top: 12 }],
  ["device_manufacturer_groups", { top: 12 }],
  ["device_type_groups", { top: 12 }],
  ["device_provider_groups", { top: 10 }],
];

const SAFE_NAME = /(count|summary|group|score|stat|trend|overview|top|total|breakdown|distribution|history|list|report|eol|expir|risk|severity|latest|recent)/i;
/** Verbs that change something (or need free-text input). Matched as whole name tokens. */
const ACTION_VERBS = new Set(
  "create update delete remove deploy run execute trigger start stop assign install uninstall approve reject send write set add reboot restart cancel enable disable push apply ask query search".split(" "),
);
/** Endings that mark a read-only result even when a verb appears earlier (e.g. software_install_count). */
const READ_ONLY_ENDING = /(count|counts|groups?|summary|stats?|statistics|history|status|score|trend|trends|totals?|overview)$/i;

function isReadOnlyName(name: string): boolean {
  const tokens = name.split(/[_\-\s.]+|(?<=[a-z])(?=[A-Z])/).map((t) => t.toLowerCase());
  if (/^(ask|query|search)$/.test(tokens[0] ?? "")) return false;
  const hasVerb = tokens.some((t) => ACTION_VERBS.has(t));
  return !hasVerb || READ_ONLY_ENDING.test(name);
}

/** Read-only, argument-free summary tools of a non-device domain. */
function pickGenericTools(tools: Tool[]): Tool[] {
  return tools
    .filter((t) => {
      if (t.annotations?.destructiveHint === true || t.annotations?.readOnlyHint === false) return false;
      if (!isReadOnlyName(t.name) || !SAFE_NAME.test(t.name)) return false;
      const required = (t.inputSchema as { required?: string[] })?.required ?? [];
      return required.length === 0;
    })
    .slice(0, 12);
}

/** Keeps snapshots small enough for Redis: long arrays are cut to 50 entries. */
function trim(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => trim(v, depth + 1));
    return value.length > 50 ? [...items, { __truncated: value.length - 50 }] : items;
  }
  if (value && typeof value === "object" && depth < 6) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v, depth + 1)]));
  }
  if (typeof value === "string" && value.length > 4000) return value.slice(0, 4000) + "…";
  return value;
}

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  if (result.structuredContent !== undefined) return trim(result.structuredContent);
  const content = (result.content ?? []) as { type: string; text?: string }[];
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  try {
    return trim(JSON.parse(text));
  } catch {
    return trim(text);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function runTool(client: Client, tool: Tool | undefined, name: string, args?: Record<string, unknown>): Promise<ToolRun> {
  const run = { tool: name, title: tool?.title, description: tool?.description, args };
  if (!tool) return { ...run, ok: false, error: "Tool not offered by this domain" };
  // Only pass arguments the tool actually declares.
  const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {});
  const safeArgs = Object.fromEntries(Object.entries(args ?? {}).filter(([k]) => props.includes(k)));
  try {
    const result = await client.callTool({ name, arguments: safeArgs }, undefined, { timeout: CALL_TIMEOUT_MS });
    const data = parseResult(result);
    if (result.isError) return { ...run, ok: false, error: typeof data === "string" ? data : JSON.stringify(data) };
    return { ...run, ok: true, data };
  } catch (err) {
    return { ...run, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function collectDomain(domain: Domain): Promise<DomainData> {
  const base: DomainData = { id: domain.id, label: domain.label, ok: false, runs: [] };
  const url = domainUrl(domain);

  const attempt = async (forceResource: boolean) => {
    const token = await getAccessToken(domain.id, url, forceResource);
    return withClient(domain, token, CALL_TIMEOUT_MS, async (client) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: CALL_TIMEOUT_MS });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      const byName = new Map(tools.map((t) => [t.name, t]));

      const calls: [Tool | undefined, string, Record<string, unknown>?][] =
        domain.id === "device"
          ? DEVICE_CALLS.map(([n, a]) => [byName.get(n), n, a])
          : pickGenericTools(tools).map((t) => [t, t.name, undefined]);

      const runs = await mapLimit(calls, 4, ([t, n, a]) => runTool(client, t, n, a));
      return { ...base, ok: true, toolCount: tools.length, runs };
    });
  };

  try {
    try {
      return await attempt(false);
    } catch (err) {
      // A shared token may be rejected by some domains; retry with a token for this domain only.
      if (err instanceof UpstreamAuthError) return await attempt(true);
      throw err;
    }
  } catch (err) {
    if (err instanceof SignInRequiredError) throw err;
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function collectSnapshot(): Promise<Snapshot> {
  const started = Date.now();
  const auth = await getStoredAuth();
  if (!auth) throw new SignInRequiredError();
  const domains = await mapLimit(getConfig().domains, 3, collectDomain);
  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    signedInAt: auth.signedInAt,
    domains,
  };
}

/* ------------------------------- caching ------------------------------- */

const SNAPSHOT_KEY = "ivanti:snapshot";
let inflight: Promise<Snapshot> | undefined;

function maxAgeMs() {
  return Number(process.env.SNAPSHOT_TTL_MINUTES ?? 15) * 60_000;
}

export async function getSnapshot(force = false): Promise<{ snapshot: Snapshot; cached: boolean }> {
  const store = getStore();
  if (!force) {
    const cached = await store.get<Snapshot>(SNAPSHOT_KEY);
    if (cached && Date.now() - Date.parse(cached.generatedAt) < maxAgeMs()) return { snapshot: cached, cached: true };
  }
  inflight ??= collectSnapshot()
    .then(async (s) => {
      await store.set(SNAPSHOT_KEY, s, { ttlSeconds: 7 * 24 * 3600 });
      return s;
    })
    .finally(() => {
      inflight = undefined;
    });
  return { snapshot: await inflight, cached: false };
}

export async function getCachedSnapshot(): Promise<Snapshot | null> {
  return getStore().get<Snapshot>(SNAPSHOT_KEY);
}
