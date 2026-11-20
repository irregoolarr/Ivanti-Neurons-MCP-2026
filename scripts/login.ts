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

  console.log("\n> Looking up Ivanti sign-in endpoints…");
  const ivanti = await getIvantiAuth();
  console.log(`  ${ivanti.authorizationEndpoint}`);

  // PKCE + local callback server
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  let resolveCode!: (v: { code: string; iss?: string | null }) => void;
  let rejectCode!: (e: Error) => void;
  const codePromise = new Promise<{ code: string; iss?: string | null }>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    const html = (msg: string) =>
      res.writeHead(200, { "Content-Type": "text/html" }).end(`<body style="font-family:system-ui;padding:40px"><h2>${msg}</h2>You can close this tab.</body>`);
    if (url.searchParams.get("state") !== state) {
      html("Sign-in failed: state mismatch.");
      return rejectCode(new Error("State mismatch"));
    }
    const error = url.searchParams.get("error");
    if (error) {
      html(`Sign-in failed: ${error}`);
      return rejectCode(new Error(`${error}: ${url.searchParams.get("error_description") ?? ""}`));
    }
    html("Signed in to Ivanti ✔");
    resolveCode({ code: url.searchParams.get("code") ?? "", iss: url.searchParams.get("iss") });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  const scope = ivanti.scopes.length ? ivanti.scopes.join(" ") : "mcp.read offline_access";
  const authUrl = new URL(ivanti.authorizationEndpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    authUrl.searchParams.set(k, v);

  console.log("\n> Opening Ivanti sign-in in your browser. If it doesn't open, visit:\n");
  console.log(`  ${authUrl.toString()}\n`);
  if (!process.argv.includes("--no-browser")) openBrowser(authUrl.toString());

  const timeout = setTimeout(() => rejectCode(new Error("Timed out after 5 minutes")), 5 * 60_000);
  const { code, iss } = await codePromise.finally(() => {
    clearTimeout(timeout);
    server.close();
  });
  if (iss && ivanti.issuer && iss !== ivanti.issuer) throw new Error(`Unexpected issuer ${iss}`);

  console.log("> Exchanging code for tokens…");
  let tokens = await tokenRequest(ivanti.tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
  if (!tokens.refresh_token) throw new Error("Ivanti returned no refresh token (offline_access not granted?)");
  let refreshToken = tokens.refresh_token;

  console.log("> Checking which Ivanti MCP domains accept the sign-in…");
  const catalog: Record<string, unknown> = {};
  const failed: string[] = [];
  for (const d of cfg.domains) {
    try {
      const tools = await withClient(d, tokens.access_token, 30_000, async (c) => (await c.listTools()).tools);
      catalog[d.id] = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));
      console.log(`  ✔ ${d.id.padEnd(22)} ${tools.length} tools`);
    } catch (err) {
      failed.push(d.id);
      console.log(`  ✖ ${d.id.padEnd(22)} ${err instanceof UpstreamAuthError ? "token rejected" : (err as Error).message.slice(0, 80)}`);
    }
  }

  let mode: "shared" | "per-resource" = "shared";
  if (failed.length) {
    console.log("> Retrying rejected domains with a domain-specific token…");
    let fixed = 0;
    for (const id of failed) {
      const d = cfg.domains.find((x) => x.id === id)!;
      try {
        const t = await tokenRequest(ivanti.tokenEndpoint, {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: cfg.clientId,
          resource: domainUrl(d),
        });
        refreshToken = t.refresh_token ?? refreshToken;
        const tools = await withClient(d, t.access_token, 30_000, async (c) => (await c.listTools()).tools);
        catalog[d.id] = tools.map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema, annotations: x.annotations }));
        console.log(`  ✔ ${d.id.padEnd(22)} ${tools.length} tools`);
        fixed++;
      } catch (err) {
        console.log(`  ✖ ${d.id.padEnd(22)} ${(err as Error).message.slice(0, 100)} (not enabled or not licensed?)`);
      }
    }
    if (fixed > 0) mode = "per-resource";
  }

  writeFileSync("ivanti-tools.local.json", JSON.stringify(catalog, null, 2));
  console.log("  Tool list saved to ivanti-tools.local.json");

  console.log(`> Uploading sign-in to ${app} …`);
  const res = await fetch(`${app}/api/admin/ivanti-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
    body: JSON.stringify({ refreshToken, mode }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${body}`);
  console.log(`\n✅ Done. The dashboard is connected to Ivanti (${mode} token). Open ${app}\n`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
