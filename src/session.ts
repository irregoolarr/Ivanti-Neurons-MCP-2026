/**
 * Dashboard password protection: a signed, HttpOnly session cookie.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Req } from "./util.js";

const COOKIE = "ivanti_dash";
const MAX_AGE_S = 7 * 24 * 3600;

export function dashboardPassword(): string | undefined {
  return process.env.DASHBOARD_PASSWORD?.trim() || undefined;
}

function key(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim() || `session:${dashboardPassword() ?? ""}`;
  return createHash("sha256").update(secret).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function checkPassword(candidate: string | null | undefined): boolean {
  const pw = dashboardPassword();
  return !!pw && !!candidate && safeEqual(candidate, pw);
}

/** Bearer header with the dashboard password (used by `npm run login` and scripts). */
export function hasAdminBearer(req: Req): boolean {
  const h = req.headers.authorization;
  return !!h && h.toLowerCase().startsWith("bearer ") && checkPassword(h.slice(7).trim());
}

function cookies(req: Req): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isLoggedIn(req: Req): boolean {
  if (!dashboardPassword()) return false;
  const value = cookies(req)[COOKIE];
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(exp));
}

function secureFlag(req: Req): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "";
  return proto.includes("https") || process.env.VERCEL ? "; Secure" : "";
}

export function setLoginCookie(req: Req, res: ServerResponse) {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  res.setHeader("Set-Cookie", `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secureFlag(req)}`);
}

export function clearLoginCookie(req: Req, res: ServerResponse) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}`);
}
