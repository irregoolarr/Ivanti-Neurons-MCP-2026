/**
 * Dashboard routes: password login, page assets, data API, sign-in upload, cron refresh.
 */
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { getSnapshot } from "./collector.js";
import { SignInRequiredError, getAccessToken, saveSignIn } from "./ivantiAuth.js";
import { domainUrl, getConfig } from "./config.js";
import { checkPassword, clearLoginCookie, dashboardPassword, hasAdminBearer, isLoggedIn, safeEqual, setLoginCookie } from "./session.js";
import { getStore } from "./store.js";
import { readFormBody, readRawBody, sendJson, type Req } from "./util.js";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

const assetCache = new Map<string, string>();
function asset(name: string): string {
  let v = assetCache.get(name);
  if (v === undefined) {
    v = readFileSync(join(process.cwd(), "dashboard", name), "utf8");
    if (process.env.VERCEL) assetCache.set(name, v);
  }
  return v;
}

/** Cache-busting token for asset URLs: the deployed commit, or the process start time locally. */
const VERSION = (process.env.VERCEL_GIT_COMMIT_SHA ?? String(Date.now())).slice(0, 12);

function sendAsset(res: ServerResponse, name: string, replacements: Record<string, string> = {}) {
  let body = asset(name);
  for (const [k, v] of Object.entries({ VERSION, ...replacements })) body = body.replaceAll(`{{${k}}}`, v);
  res.writeHead(200, {
    "Content-Type": TYPES[name.split(".").pop() ?? "html"],
    "Cache-Control": name.endsWith(".html") ? "no-store" : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function redirect(res: ServerResponse, to: string) {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store" }).end();
}

/** Returns true if handled. */
export async function handleDashboard(req: Req, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  switch (path) {
    case "/": {
      if (req.method !== "GET" && req.method !== "HEAD") return false; // POST / is MCP
      if (!dashboardPassword()) {
        sendAsset(res, "login.html", { ERROR: "Set the DASHBOARD_PASSWORD environment variable in Vercel, then redeploy.", DISABLED: "disabled" });
        return true;
      }
      if (!isLoggedIn(req)) return redirect(res, "/login"), true;
      sendAsset(res, "index.html");
      return true;
    }

    case "/login": {
      if (req.method === "POST") {
        const form = await readFormBody(req);
        if (checkPassword(form.get("password"))) {
          setLoginCookie(req, res);
          return redirect(res, "/"), true;
        }
        await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
        sendAsset(res, "login.html", { ERROR: "Wrong password.", DISABLED: "" });
        return true;
      }
      if (isLoggedIn(req)) return redirect(res, "/"), true;
      sendAsset(res, "login.html", {
        ERROR: dashboardPassword() ? "" : escapeHtml("Set DASHBOARD_PASSWORD in Vercel, then redeploy."),
        DISABLED: dashboardPassword() ? "" : "disabled",
      });
      return true;
    }

    case "/logout":
      clearLoginCookie(req, res);
      return redirect(res, "/login"), true;

    case "/assets/app.js":
      sendAsset(res, "app.js");
      return true;
    case "/assets/app.css":
      sendAsset(res, "app.css");
      return true;

    case "/api/data": {
      if (!isLoggedIn(req) && !hasAdminBearer(req)) {
        sendJson(res, 401, { error: "login_required" });
        return true;
      }
      try {
        const { snapshot, cached } = await getSnapshot(query.get("refresh") === "1");
        sendJson(res, 200, {
          ...snapshot,
          cached,
          persistentStore: getStore().persistent,
          tenantHost: new URL(getConfig().mcpBaseUrl).host,
        });
      } catch (err) {
        if (err instanceof SignInRequiredError) {
          sendJson(res, 409, { error: "ivanti_sign_in_required", message: err.message, persistentStore: getStore().persistent });
        } else {
          console.error("[dashboard] /api/data", err);
          sendJson(res, 500, { error: "collect_failed", message: err instanceof Error ? err.message : String(err) });
        }
      }
      return true;
    }

    case "/api/admin/ivanti-token": {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" }), true;
      if (!hasAdminBearer(req)) return sendJson(res, 401, { error: "unauthorized" }), true;
      let body: { refreshTokens?: Record<string, unknown> };
      try {
        body = JSON.parse(await readRawBody(req));
      } catch {
        return sendJson(res, 400, { error: "invalid_json" }), true;
      }
      const known = new Set(getConfig().domains.map((d) => d.id));
      const tokens = Object.fromEntries(
        Object.entries(body.refreshTokens ?? {}).filter(([k, v]) => known.has(k) && typeof v === "string" && v.length > 0),
      ) as Record<string, string>;
      if (Object.keys(tokens).length === 0) return sendJson(res, 400, { error: "refreshTokens required" }), true;
      await saveSignIn(tokens);
      await getStore().del("ivanti:snapshot");
      // Prove each works now (this also rotates the refresh tokens into the store).
      const results: Record<string, string> = {};
      for (const id of Object.keys(tokens)) {
        const d = getConfig().domains.find((x) => x.id === id)!;
        try {
          await getAccessToken(d.id, domainUrl(d));
          results[id] = "ok";
        } catch (err) {
          results[id] = err instanceof Error ? err.message : String(err);
        }
      }
      const okCount = Object.values(results).filter((r) => r === "ok").length;
      sendJson(res, okCount ? 200 : 400, { ok: okCount > 0, results, persistentStore: getStore().persistent });
      return true;
    }

    case "/api/cron/refresh": {
      // Vercel Cron sends "Authorization: Bearer $CRON_SECRET". Keeps data fresh and the sign-in alive.
      const secret = process.env.CRON_SECRET?.trim();
      const h = req.headers.authorization ?? "";
      if (!secret || !safeEqual(h, `Bearer ${secret}`)) return sendJson(res, 401, { error: "unauthorized" }), true;
      try {
        const { snapshot } = await getSnapshot(true);
        sendJson(res, 200, { ok: true, generatedAt: snapshot.generatedAt, durationMs: snapshot.durationMs });
      } catch (err) {
        sendJson(res, 500, { ok: false, message: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
  }
  return false;
}
