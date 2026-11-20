/**
 * One-time Ivanti sign-in for the dashboard.
 *
 *   npm run login -- --app https://your-app.vercel.app
 *
 * 1. Opens Ivanti's sign-in page in your browser (Ivanti allows http://127.0.0.1 redirects).
 * 2. Exchanges the code for tokens and checks which MCP domains accept them.
 * 3. Uploads the refresh token to the dashboard (authenticated with DASHBOARD_PASSWORD).
 * Also writes ivanti-tools.local.json: the tools each domain offers (no data, no tokens).
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline/promises";

for (const file of [".env.local", ".env.secrets.local", ".env"]) if (existsSync(file)) process.loadEnvFile(file);

const { getConfig, domainUrl } = await import("../src/config.js");
const { getIvantiAuth } = await import("../src/discovery.js");
const { withClient, UpstreamAuthError } = await import("../src/upstream.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* printed below anyway */
  }
}

const b64url = (buf: Buffer) => buf.toString("base64url");

async function tokenRequest(tokenEndpoint: string, params: Record<string, string>) {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, string | number | undefined>;
  if (!res.ok || !json.access_token) throw new Error(`Token request failed: ${json.error_description ?? json.error ?? res.status}`);
  return json as { access_token: string; refresh_token?: string; expires_in?: number };
}

async function main() {
  const cfg = getConfig();
  const app = (arg("app") ?? process.env.DASHBOARD_URL ?? (await ask("Dashboard URL (e.g. https://your-app.vercel.app): "))).replace(/\/+$/, "");
  const password = process.env.DASHBOARD_PASSWORD ?? (await ask("Dashboard password (DASHBOARD_PASSWORD): "));

  const only = arg("domains")?.split(",").map((s) => s.trim());
  const domains = only ? cfg.domains.filter((d) => only.includes(d.id)) : cfg.domains;

  console.log("\n> Looking up Ivanti sign-in endpoints…");
  const ivanti = await getIvantiAuth();
  console.log(`  ${ivanti.authorizationEndpoint}`);
  const scope = ivanti.scopes.length ? ivanti.scopes.join(" ") : "mcp.read offline_access";

  // One local callback server for all sign-ins; each sign-in has its own state.
  const pending = new Map<string, { resolve: (code: string) => void; reject: (e: Error) => void }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    const html = (msg: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<body style="font-family:system-ui;padding:40px"><h2>${msg}</h2>You can close this tab.<script>setTimeout(()=>window.close(),800)</script></body>`);
    const p = pending.get(url.searchParams.get("state") ?? "");
    if (!p) return html("Unknown or expired sign-in request.");
    const error = url.searchParams.get("error");
    if (error) {
      html(`Sign-in failed: ${error}`);
      return p.reject(new Error(`${error}: ${url.searchParams.get("error_description") ?? ""}`));
    }
    const iss = url.searchParams.get("iss");
    if (iss && ivanti.issuer && iss !== ivanti.issuer) {
      html("Sign-in failed: unexpected issuer.");
      return p.reject(new Error(`Unexpected issuer ${iss}`));
    }
    html("Signed in to Ivanti ✔");
    p.resolve(url.searchParams.get("code") ?? "");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  /** Ivanti ties each sign-in to one MCP server, so sign in once per domain. */
  async function signIn(resource: string, label: string) {
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const authUrl = new URL(ivanti.authorizationEndpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      resource,
    }))
      authUrl.searchParams.set(k, v);

    const code = await new Promise<string>((resolve, reject) => {
      pending.set(state, { resolve, reject });
      console.log(`\n> Signing in for ${label}. If no browser tab opens, visit:\n  ${authUrl}\n`);
      if (!process.argv.includes("--no-browser")) openBrowser(authUrl.toString());
      setTimeout(() => reject(new Error("Timed out after 5 minutes")), 5 * 60_000).unref();
    }).finally(() => pending.delete(state));

    return tokenRequest(ivanti.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      code_verifier: verifier,
      resource,
    });
  }

  const refreshTokens: Record<string, string> = {};
  const catalog: Record<string, unknown> = {};
  console.log(`> ${domains.length} domains. After the first sign-in, Ivanti should remember you and the rest finish by themselves.`);
  for (const d of domains) {
    try {
      const t = await signIn(domainUrl(d), d.id);
      if (!t.refresh_token) throw new Error("no refresh token returned (offline_access not granted?)");
      const tools = await withClient(d, t.access_token, 30_000, async (c) => (await c.listTools()).tools);
      refreshTokens[d.id] = t.refresh_token;
      catalog[d.id] = tools.map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema, annotations: x.annotations }));
      console.log(`  ✔ ${d.id.padEnd(22)} ${tools.length} tools`);
    } catch (err) {
      const msg = err instanceof UpstreamAuthError ? "token rejected" : (err as Error).message.slice(0, 120);
      console.log(`  ✖ ${d.id.padEnd(22)} ${msg} (not enabled or not licensed?)`);
    }
  }
  server.close();

  const working = Object.keys(refreshTokens).length;
  if (working === 0) throw new Error("No Ivanti MCP domain accepted the sign-in, so nothing was uploaded. See the messages above.");

  writeFileSync("ivanti-tools.local.json", JSON.stringify(catalog, null, 2));
  console.log("\n  Tool list saved to ivanti-tools.local.json");

  console.log(`> Uploading ${working} sign-in(s) to ${app} …`);
  const res = await fetch(`${app}/api/admin/ivanti-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
    body: JSON.stringify({ refreshTokens }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${body}`);
  console.log(`\n✅ Done. ${working}/${domains.length} domains connected. Open ${app}\n`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
