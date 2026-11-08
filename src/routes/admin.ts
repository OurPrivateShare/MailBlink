import { adminLogin, hashPassword, requireAdmin, validateCredentials } from "../auth";
import { type Settings, getDomains, getSettings, invalidateCache, saveSettings } from "../db";
import type { Ctx } from "../router";
import { ADMIN_COOKIE } from "../auth";
import { DOMAIN_RE, HttpError, clampInt, json, readJson, setCookie } from "../util";

export async function login(ctx: Ctx) {
  const body = await readJson<{ password?: string }>(ctx.req);
  return json({ ok: true }, 200, { "set-cookie": await adminLogin(ctx.env, body.password) });
}

export async function logout() {
  return json({ ok: true }, 200, { "set-cookie": setCookie(ADMIN_COOKIE, "", 0) });
}

export async function session(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  return json({ ok: true });
}

export async function stats(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  const dayAgo = Date.now() - 86400_000;
  const row = await ctx.env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE banned = 1) AS banned,
      (SELECT COUNT(*) FROM mailboxes) AS mailboxes,
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM messages WHERE received_at > ?) AS messages24h`,
  )
    .bind(dayAgo)
    .first();
  const settings = await getSettings(ctx.env);
  const domains = await getDomains(ctx.env);
  return json({ ...row, domains: domains.length, forwardTo: settings.forward_to });
}

export async function getSettingsRoute(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  return json(await getSettings(ctx.env));
}

export async function updateSettings(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  const body = await readJson<Record<string, unknown>>(ctx.req);
  const current = await getSettings(ctx.env);
  const patch: Partial<Record<keyof Settings, string | number | boolean>> = {};

  if (body.site_name !== undefined) patch.site_name = String(body.site_name).trim().slice(0, 40) || "MailBlink";
  if (body.min_prefix !== undefined) patch.min_prefix = clampInt(body.min_prefix, 1, 32, current.min_prefix);
  if (body.max_prefix !== undefined) patch.max_prefix = clampInt(body.max_prefix, 4, 64, current.max_prefix);
  const minP = Number(patch.min_prefix ?? current.min_prefix);
  const maxP = Number(patch.max_prefix ?? current.max_prefix);
  if (minP > maxP) throw new HttpError(400, "最少字符数不能大于最多字符数");
  if (body.allow_register !== undefined) patch.allow_register = Boolean(body.allow_register);
  if (body.max_mailboxes !== undefined) patch.max_mailboxes = clampInt(body.max_mailboxes, 1, 1000, current.max_mailboxes);
  if (body.cache_ttl !== undefined) patch.cache_ttl = clampInt(body.cache_ttl, 0, 300, current.cache_ttl);
  if (body.forward_to !== undefined) {
    const v = String(body.forward_to).trim().toLowerCase();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, "转发邮箱格式不正确");
    patch.forward_to = v;
  }
  await saveSettings(ctx.env, patch);
  return json(await getSettings(ctx.env));
}

export async function listDomains(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  const { results } = await ctx.env.DB.prepare(
    "SELECT d.name, d.enabled, d.created_at, (SELECT COUNT(*) FROM mailboxes b WHERE b.address LIKE '%@' || d.name) AS mailboxes FROM domains d ORDER BY d.id",
  ).all();
  return json({ domains: results });
}

export async function addDomain(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  const body = await readJson<{ name?: string }>(ctx.req);
  const name = String(body.name || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
  if (!DOMAIN_RE.test(name)) throw new HttpError(400, "域名格式不正确");
  const res = await ctx.env.DB.prepare("INSERT OR IGNORE INTO domains (name, created_at) VALUES (?, ?)")
    .bind(name, Date.now())
    .run();
  if (!res.meta.changes) throw new HttpError(409, "域名已存在");
  invalidateCache();
  return listDomains(ctx);
}

export async function updateDomain(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  const body = await readJson<{ enabled?: boolean }>(ctx.req);
  await ctx.env.DB.prepare("UPDATE domains SET enabled = ? WHERE name = ?")
    .bind(body.enabled ? 1 : 0, ctx.params[0].toLowerCase())
    .run();
  invalidateCache();
  return listDomains(ctx);
}

export async function deleteDomain(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  await ctx.env.DB.prepare("DELETE FROM domains WHERE name = ?").bind(ctx.params[0].toLowerCase()).run();
  invalidateCache();
  return listDomains(ctx);
}

const PAGE_SIZE = 20;

const DEFAULT_INACTIVE_MS = 90 * 86400_000;

function userFilter(params: URLSearchParams): { filter: string; clause: string; binds: unknown[] } {
  const filter = params.get("filter") || "all";
  const where: string[] = [];
  const binds: unknown[] = [];
  switch (filter) {
    case "all":
      break;
    case "banned":
      where.push("u.banned = 1");
      break;
    case "empty":
      where.push("NOT EXISTS (SELECT 1 FROM mailboxes b WHERE b.user_id = u.id)");
      break;
    case "inactive":
      where.push("u.last_active_at < ?");
      binds.push(Number(params.get("before")) || Date.now() - DEFAULT_INACTIVE_MS);
      break;
    default:
      throw new HttpError(400, "未知的过滤条件");
  }
  const q = (params.get("q") || "").trim().replace(/[%_\\]/g, "").slice(0, 64);
  if (q) {
    where.push("u.username LIKE ?");
    binds.push(`%${q}%`);
  }
  return { filter, clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

export async function listUsers(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  const page = clampInt(ctx.url.searchParams.get("page"), 1, 10_000, 1);
  const { clause, binds } = userFilter(ctx.url.searchParams);
  const [list, total] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `SELECT u.id, u.username, u.banned, u.created_at, u.last_active_at, (SELECT COUNT(*) FROM mailboxes b WHERE b.user_id = u.id) AS mailboxes FROM users u ${clause} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${clause}`).bind(...binds),
  ]);
  return json({
    users: list.results,
    total: (total.results[0] as { n: number }).n,
    page,
    pageSize: PAGE_SIZE,
  });
}

export async function userMailboxes(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  const { results } = await ctx.env.DB.prepare(
    "SELECT b.id, b.address, b.is_public, b.created_at, b.last_mail_at, (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = b.id) AS messages FROM mailboxes b WHERE b.user_id = ? ORDER BY b.id DESC",
  )
    .bind(Number(ctx.params[0]))
    .all();
  return json({ mailboxes: results });
}

export async function banUser(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  const body = await readJson<{ banned?: boolean }>(ctx.req);
  const id = Number(ctx.params[0]);
  const stmts = [ctx.env.DB.prepare("UPDATE users SET banned = ? WHERE id = ?").bind(body.banned ? 1 : 0, id)];
  if (body.banned) stmts.push(ctx.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
  await ctx.env.DB.batch(stmts);
  return json({ ok: true });
}

export async function resetPassword(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  const body = await readJson<{ password?: string }>(ctx.req);
  const id = Number(ctx.params[0]);
  const { password } = validateCredentials("placeholder", body.password);
  const { hash, salt } = await hashPassword(password);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?").bind(hash, salt, id),
    ctx.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
  ]);
  return json({ ok: true });
}

export async function deleteUser(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  await ctx.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(Number(ctx.params[0])).run();
  return json({ ok: true });
}

export async function deleteFilteredUsers(ctx: Ctx) {
  await requireAdmin(ctx.env, ctx.req);
  const { filter, clause, binds } = userFilter(ctx.url.searchParams);
  if (filter === "all") throw new HttpError(400, "不支持删除全部用户");
  const res = await ctx.env.DB.prepare(`DELETE FROM users WHERE id IN (SELECT u.id FROM users u ${clause})`)
    .bind(...binds)
    .run();
  return json({ count: res.meta.changes });
}
