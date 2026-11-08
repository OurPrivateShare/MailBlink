import { getSecret } from "./db";
import {
  type Env,
  HttpError,
  fromBase64,
  getCookie,
  randomBytes,
  randomToken,
  safeEqual,
  setCookie,
  sha256Hex,
  toBase64Url,
} from "./util";

const encoder = new TextEncoder();
// Kept moderate so a login stays inside the free plan's 10 ms CPU budget.
const PBKDF2_ITERATIONS = 20_000;
const SESSION_DAYS = 30;
const ADMIN_HOURS = 12;
const TOUCH_INTERVAL_MS = 6 * 3600_000;

export const USER_COOKIE = "mb_session";
export const ADMIN_COOKIE = "mb_admin";

export async function hashPassword(password: string, saltB64?: string) {
  const salt = saltB64 ? fromBase64(saltB64) : randomBytes(16);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: toBase64Url(new Uint8Array(bits)), salt: toBase64Url(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string) {
  const computed = await hashPassword(password, salt);
  return safeEqual(computed.hash, hash);
}

export function validateCredentials(username: unknown, password: unknown) {
  if (typeof username !== "string" || !/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    throw new HttpError(400, "用户名需为 3-24 位字母、数字或下划线");
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new HttpError(400, "密码长度需为 8-128 位");
  }
  return { username, password };
}

export async function createSession(env: Env, userId: number): Promise<string> {
  const token = randomToken(32);
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(userId, Date.now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(
      await sha256Hex(token),
      userId,
      expires,
    ),
  ]);
  return setCookie(USER_COOKIE, token, SESSION_DAYS * 86400);
}

export async function destroySession(env: Env, req: Request) {
  const token = getCookie(req, USER_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return setCookie(USER_COOKIE, "", 0);
}

export interface SessionUser {
  id: number;
  username: string;
  banned: number;
  last_active_at: number;
}

export async function getUser(env: Env, req: Request, ctx?: ExecutionContext): Promise<SessionUser | null> {
  const token = getCookie(req, USER_COOKIE);
  if (!token) return null;
  const user = await env.DB.prepare(
    "SELECT u.id, u.username, u.banned, u.last_active_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  )
    .bind(await sha256Hex(token), Date.now())
    .first<SessionUser>();
  if (!user) return null;
  if (user.banned) throw new HttpError(403, "该账号已被封禁，请联系管理员");
  // Throttled activity stamp: at most one write per user every few hours.
  if (Date.now() - user.last_active_at > TOUCH_INTERVAL_MS) {
    const touch = env.DB.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").bind(Date.now(), user.id).run();
    if (ctx) ctx.waitUntil(touch);
    else await touch;
  }
  return user;
}

export async function requireUser(env: Env, req: Request, ctx?: ExecutionContext) {
  const user = await getUser(env, req, ctx);
  if (!user) throw new HttpError(401, "请先登录");
  return user;
}

async function adminSignature(env: Env, payload: string) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, "未配置 ADMIN_PASSWORD，管理后台不可用");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${getSecret(env)}|${env.ADMIN_PASSWORD}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`admin:${payload}`));
  return toBase64Url(new Uint8Array(sig));
}

export async function adminLogin(env: Env, password: unknown): Promise<string> {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, "未配置 ADMIN_PASSWORD，管理后台不可用");
  if (typeof password !== "string" || !safeEqual(await sha256Hex(password), await sha256Hex(env.ADMIN_PASSWORD))) {
    throw new HttpError(401, "管理员密码错误");
  }
  const exp = String(Date.now() + ADMIN_HOURS * 3600_000);
  return setCookie(ADMIN_COOKIE, `${exp}.${await adminSignature(env, exp)}`, ADMIN_HOURS * 3600);
}

export async function requireAdmin(env: Env, req: Request) {
  const token = getCookie(req, ADMIN_COOKIE);
  const [exp, sig] = (token || "").split(".");
  if (!exp || !sig || Number(exp) < Date.now() || !safeEqual(sig, await adminSignature(env, exp))) {
    throw new HttpError(401, "管理员登录已失效");
  }
}
