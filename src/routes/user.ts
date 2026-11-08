import {
  createSession,
  destroySession,
  getUser,
  hashPassword,
  requireUser,
  validateCredentials,
  verifyPassword,
} from "../auth";
import { getSettings, isEnabledDomain } from "../db";
import type { Ctx } from "../router";
import { HttpError, PREFIX_RE, json, randomPrefix, readJson } from "../util";
import { purgeMailboxCache, queryMessage, queryMessageList } from "./public";

const RESERVED = new Set([
  "admin", "administrator", "root", "postmaster", "hostmaster", "webmaster", "abuse", "security",
  "noreply", "no-reply", "mailer-daemon", "support", "info", "system",
]);

async function listUserMailboxes(ctx: Ctx, userId: number) {
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, address, is_public, created_at, last_mail_at FROM mailboxes WHERE user_id = ? ORDER BY id DESC",
  )
    .bind(userId)
    .all<{ id: number; address: string; is_public: number; created_at: number; last_mail_at: number }>();
  return results.map((r) => ({ ...r, is_public: Boolean(r.is_public) }));
}

export async function me(ctx: Ctx) {
  const user = await getUser(ctx.env, ctx.req, ctx.exec);
  if (!user) return json({ user: null, mailboxes: [] });
  return json({ user: { id: user.id, username: user.username }, mailboxes: await listUserMailboxes(ctx, user.id) });
}

export async function register(ctx: Ctx) {
  const settings = await getSettings(ctx.env);
  if (!settings.allow_register) throw new HttpError(403, "管理员已关闭注册");
  const body = await readJson<{ username?: string; password?: string }>(ctx.req);
  const { username, password } = validateCredentials(body.username, body.password);
  const { hash, salt } = await hashPassword(password);
  const now = Date.now();
  const row = await ctx.env.DB.prepare(
    "INSERT INTO users (username, pass_hash, salt, created_at, last_active_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO NOTHING RETURNING id",
  )
    .bind(username, hash, salt, now, now)
    .first<{ id: number }>();
  if (!row) throw new HttpError(409, "用户名已被占用");
  return json({ user: { id: row.id, username }, mailboxes: [] }, 201, {
    "set-cookie": await createSession(ctx.env, row.id),
  });
}

export async function login(ctx: Ctx) {
  const body = await readJson<{ username?: string; password?: string }>(ctx.req);
  if (typeof body.username !== "string" || typeof body.password !== "string") throw new HttpError(400, "请输入用户名和密码");
  const user = await ctx.env.DB.prepare("SELECT id, username, pass_hash, salt, banned FROM users WHERE username = ?")
    .bind(body.username.trim())
    .first<{ id: number; username: string; pass_hash: string; salt: string; banned: number }>();
  if (!user || !(await verifyPassword(body.password, user.pass_hash, user.salt))) {
    throw new HttpError(401, "用户名或密码错误");
  }
  if (user.banned) throw new HttpError(403, "该账号已被封禁，请联系管理员");
  ctx.exec.waitUntil(
    ctx.env.DB.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").bind(Date.now(), user.id).run(),
  );
  return json(
    { user: { id: user.id, username: user.username }, mailboxes: await listUserMailboxes(ctx, user.id) },
    200,
    { "set-cookie": await createSession(ctx.env, user.id) },
  );
}

export async function logout(ctx: Ctx) {
  return json({ ok: true }, 200, { "set-cookie": await destroySession(ctx.env, ctx.req) });
}

export async function changePassword(ctx: Ctx) {
  const user = await requireUser(ctx.env, ctx.req, ctx.exec);
  const body = await readJson<{ oldPassword?: string; newPassword?: string }>(ctx.req);
  const row = await ctx.env.DB.prepare("SELECT pass_hash, salt FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ pass_hash: string; salt: string }>();
  if (!row || typeof body.oldPassword !== "string" || !(await verifyPassword(body.oldPassword, row.pass_hash, row.salt))) {
    throw new HttpError(401, "原密码错误");
  }
  const { password } = validateCredentials(user.username, body.newPassword);
  const { hash, salt } = await hashPassword(password);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?").bind(hash, salt, user.id),
    ctx.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
  ]);
  return json({ ok: true }, 200, { "set-cookie": await createSession(ctx.env, user.id) });
}

export async function listMailboxes(ctx: Ctx) {
  const user = await requireUser(ctx.env, ctx.req, ctx.exec);
  return json({ mailboxes: await listUserMailboxes(ctx, user.id) });
}

export async function createMailbox(ctx: Ctx) {
  const user = await requireUser(ctx.env, ctx.req, ctx.exec);
  const settings = await getSettings(ctx.env);
  const body = await readJson<{ prefix?: string; domain?: string }>(ctx.req);

  const domain = String(body.domain || "").toLowerCase();
  if (!(await isEnabledDomain(ctx.env, domain))) throw new HttpError(400, "请选择可用域名");

  const countRow = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = ?")
    .bind(user.id)
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) >= settings.max_mailboxes) {
    throw new HttpError(400, `每个账号最多 ${settings.max_mailboxes} 个邮箱，请先删除不用的邮箱`);
  }

  let prefix = String(body.prefix || "").trim().toLowerCase();
  const random = !prefix;
  if (!random) {
    if (prefix.length < settings.min_prefix || prefix.length > settings.max_prefix) {
      throw new HttpError(400, `邮箱前缀长度需为 ${settings.min_prefix}-${settings.max_prefix} 个字符`);
    }
    if (!PREFIX_RE.test(prefix) || /[._-]{2}/.test(prefix)) {
      throw new HttpError(400, "前缀仅支持小写字母、数字以及 . _ -，且不能以符号开头或结尾");
    }
    if (RESERVED.has(prefix)) throw new HttpError(400, "该前缀为系统保留，请换一个");
  }

  const now = Date.now();
  if (random) {
    const length = Math.max(settings.min_prefix, Math.min(settings.max_prefix, 10));
    for (let attempt = 0; attempt < 5; attempt++) {
      const address = `${randomPrefix(length)}@${domain}`;
      const row = await ctx.env.DB.prepare(
        "INSERT INTO mailboxes (address, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(address) DO NOTHING RETURNING id",
      )
        .bind(address, user.id, now)
        .first<{ id: number }>();
      if (row) return json({ mailbox: { id: row.id, address, is_public: false, created_at: now, last_mail_at: 0 } }, 201);
    }
    throw new HttpError(500, "随机邮箱生成失败，请重试");
  }

  const address = `${prefix}@${domain}`;
  const row = await ctx.env.DB.prepare(
    "INSERT INTO mailboxes (address, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(address) DO NOTHING RETURNING id",
  )
    .bind(address, user.id, now)
    .first<{ id: number }>();
  if (!row) {
    const owner = await ctx.env.DB.prepare("SELECT user_id FROM mailboxes WHERE address = ?")
      .bind(address)
      .first<{ user_id: number }>();
    throw new HttpError(409, owner?.user_id === user.id ? "该邮箱已在你的列表中" : "该邮箱已被占用，请换一个前缀");
  }
  return json({ mailbox: { id: row.id, address, is_public: false, created_at: now, last_mail_at: 0 } }, 201);
}

async function ownedMailbox(ctx: Ctx, userId: number, id: string) {
  const row = await ctx.env.DB.prepare("SELECT id, address FROM mailboxes WHERE id = ? AND user_id = ?")
    .bind(Number(id), userId)
    .first<{ id: number; address: string }>();
  if (!row) throw new HttpError(404, "邮箱不存在");
  return row;
}

export async function setMailboxPublic(ctx: Ctx) {
  const user = await requireUser(ctx.env, ctx.req, ctx.exec);
  const box = await ownedMailbox(ctx, user.id, ctx.params[0]);
  const body = await readJson<{ is_public?: boolean }>(ctx.req);
  if (typeof body.is_public !== "boolean") throw new HttpError(400, "参数错误");
  await ctx.env.DB.prepare("UPDATE mailboxes SET is_public = ? WHERE id = ?").bind(body.is_public ? 1 : 0, box.id).run();
  ctx.exec.waitUntil(purgeMailboxCache(ctx.url.origin, box.address));
  return json({ is_public: body.is_public });
}

export async function listOwnMessages(ctx: Ctx) {
  const user = await requireUser(ctx.env, ctx.req, ctx.exec);
  const box = await ownedMailbox(ctx, user.id, ctx.params[0]);
  return json(
    { address: box.address, messages: await queryMessageList(ctx.env, box.id), fetchedAt: Date.now() },
    200,
    { "cache-control": "no-store" },
  );
}

export async function getOwnMessage(ctx: Ctx) {
  const user = await requireUser(ctx.env, ctx.req, ctx.exec);
  const box = await ownedMailbox(ctx, user.id, ctx.params[0]);
  return json(await queryMessage(ctx.env, box.id, Number(ctx.params[1])), 200, { "cache-control": "no-store" });
}

export async function deleteMailbox(ctx: Ctx) {
  const user = await requireUser(ctx.env, ctx.req, ctx.exec);
  const box = await ownedMailbox(ctx, user.id, ctx.params[0]);
  await ctx.env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(box.id).run();
  ctx.exec.waitUntil(purgeMailboxCache(ctx.url.origin, box.address));
  return json({ ok: true });
}

export async function deleteMessage(ctx: Ctx) {
  const user = await requireUser(ctx.env, ctx.req, ctx.exec);
  const box = await ownedMailbox(ctx, user.id, ctx.params[0]);
  const messageId = Number(ctx.params[1]);
  await ctx.env.DB.prepare("DELETE FROM messages WHERE id = ? AND mailbox_id = ?").bind(messageId, box.id).run();
  ctx.exec.waitUntil(purgeMailboxCache(ctx.url.origin, box.address));
  return json({ ok: true });
}

export async function clearMessages(ctx: Ctx) {
  const user = await requireUser(ctx.env, ctx.req, ctx.exec);
  const box = await ownedMailbox(ctx, user.id, ctx.params[0]);
  const res = await ctx.env.DB.prepare("DELETE FROM messages WHERE mailbox_id = ?").bind(box.id).run();
  ctx.exec.waitUntil(purgeMailboxCache(ctx.url.origin, box.address));
  return json({ deleted: res.meta.changes });
}
