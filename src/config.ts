/**
 * Runtime configuration from environment variables.
 * On Vercel: Project Settings -> Environment Variables.
 */

export interface Domain {
  /** Path segment in https://<host>/mcp/<id>/v1 */
  id: string;
  /** Prefix for tool names exposed by this gateway (tool names must match ^[A-Za-z0-9_-]{1,64}$). */
  prefix: string;
  label: string;
}

export const ALL_DOMAINS: Domain[] = [
  { id: "device", prefix: "device", label: "Device" },
  { id: "dataservices", prefix: "dataservices", label: "Data Services" },
  { id: "patch", prefix: "patch", label: "Patch" },
  { id: "exposures", prefix: "exposures", label: "Exposures" },
  { id: "software-inventory", prefix: "swinventory", label: "Software Inventory" },
  { id: "software-distribution", prefix: "swdist", label: "Software Distribution" },
  { id: "reporting", prefix: "reporting", label: "Reporting" },
];

export interface Config {
  /** Neurons Auth URL from the AI Agent app registration (trailing slash and /connect/token removed). */
  authUrl: string;
  clientId: string;
  /** Base that /mcp/<domain>/v1 is appended to. */
  mcpBaseUrl: string;
  domains: Domain[];
  /** Optional overrides when Ivanti's OAuth metadata can't be discovered. */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** Space-separated scopes to request from Ivanti; default = whatever Ivanti advertises. */
  scopes?: string;
  /**
   * What to send to Ivanti as the OAuth `resource` parameter:
   *   unset / "none" -> strip it (default)
   *   "auto"         -> the resource value(s) Ivanti's MCP servers advertise
   *   anything else  -> comma-separated explicit value(s)
   */
  resourceMode: string;
  /** Public origin of this deployment, e.g. https://my-app.vercel.app (auto-detected if unset). */
  publicBaseUrl?: string;
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

const stripSlash = (s: string) => s.replace(/\/+$/, "");

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;

  const authUrlRaw = env("NEURONS_AUTH_URL");
  const clientId = env("NEURONS_CLIENT_ID");
  const missing = [!authUrlRaw && "NEURONS_AUTH_URL", !clientId && "NEURONS_CLIENT_ID"].filter(Boolean);
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);

  const authUrl = stripSlash(stripSlash(new URL(authUrlRaw!).toString()).replace(/\/connect\/token$/i, ""));

  const wanted = env("NEURONS_MCP_DOMAINS")
    ?.split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const domains = wanted ? ALL_DOMAINS.filter((d) => wanted.includes(d.id)) : ALL_DOMAINS;
  if (domains.length === 0) throw new Error("NEURONS_MCP_DOMAINS matched no known domain");

  // The Neurons Auth URL looks like https://<landscape>.ivanticloud.com/<tenant-host>, e.g.
  // https://nvuprd-sfc.ivanticloud.com/acme.ivanticloud.com — the hosted MCP servers live on the
  // tenant host (https://acme.ivanticloud.com/mcp/<domain>/v1), so use it when present.
  const tenantHost = new URL(authUrl).pathname.split("/").filter(Boolean)[0];
  const defaultMcpBase = tenantHost && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(tenantHost) ? `https://${tenantHost}` : authUrl;

  cached = {
    authUrl,
    clientId: clientId!,
    mcpBaseUrl: stripSlash(env("NEURONS_MCP_BASE_URL") ?? defaultMcpBase),
    domains,
    authorizationEndpoint: env("NEURONS_AUTHORIZATION_ENDPOINT"),
    tokenEndpoint: env("NEURONS_TOKEN_ENDPOINT"),
    scopes: env("NEURONS_OAUTH_SCOPES"),
    resourceMode: env("NEURONS_OAUTH_RESOURCE") ?? "none",
    publicBaseUrl: env("PUBLIC_BASE_URL") ? stripSlash(env("PUBLIC_BASE_URL")!) : undefined,
  };
  return cached;
}

export function domainUrl(domain: Domain): string {
  return `${getConfig().mcpBaseUrl}/mcp/${domain.id}/v1`;
}
