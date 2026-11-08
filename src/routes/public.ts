import { getEnabledDomains, getSettings, isEnabledDomain } from "../db";
import { type Env, HttpError, json, normalizeAddress, splitAddress } from "../util";
import type { Ctx } from "../router";

const LIST_LIMIT = 50;
const NOT_PUBLIC = "邮箱不存在或未公开";

function listCacheKey(origin: string, address: string) {
  return new Request(`${origin}/__cache/list/${encodeURIComponent(address)}`);
}

export async function purgeMailboxCache(origin: string, address: string) {
  await caches.default.delete(listCacheKey(origin, address));
}

export async function queryMessageList(env: Env, mailboxId: number) {
  const { results } = await env.DB.prepare(
    "SELECT id, from_addr, from_name, subject, preview, otp, received_at FROM messages WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT ?",
  )
    .bind(mailboxId, LIST_LIMIT)
    .all();
  return results;
}

export async function queryMessage(env: Env, mailboxId: number, id: number) {
  const row = await env.DB.prepare(
    "SELECT id, from_addr, from_name, subject, otp, text_body, html_body, size, received_at FROM messages WHERE mailbox_id = ? AND id = ?",
  )
    .bind(mailboxId, id)
    .first();
  if (!row) throw new HttpError(404, "邮件不存在或已删除");
  return row;
}

async function publicMailbox(env: Env, raw: string) {
  const address = normalizeAddress(raw);
  if (!address) throw new HttpError(400, "邮箱地址格式不正确");
  if (!(await isEnabledDomain(env, splitAddress(address)[1]))) throw new HttpError(404, "该域名不在本站服务范围内");
  const mailbox = await env.DB.prepare("SELECT id FROM mailboxes WHERE address = ? AND is_public = 1")
    .bind(address)
    .first<{ id: number }>();
  if (!mailbox) throw new HttpError(404, NOT_PUBLIC);
  return { address, id: mailbox.id };
}

export async function getConfig({ env }: Ctx) {
  const [settings, domains] = await Promise.all([getSettings(env), getEnabledDomains(env)]);
  return json(
    {
      siteName: settings.site_name,
      domains,
      minPrefix: settings.min_prefix,
      maxPrefix: settings.max_prefix,
      allowRegister: settings.allow_register,
      maxMailboxes: settings.max_mailboxes,
    },
    200,
    { "cache-control": "public, max-age=60" },
  );
}

export async function listMessages(ctx: Ctx, rawAddress: string, forceRefresh: boolean) {
  const { env, url, exec } = ctx;
  const normalized = normalizeAddress(rawAddress);
  const key = normalized ? listCacheKey(url.origin, normalized) : null;
  const cache = caches.default;

  if (key && !forceRefresh) {
    const hit = await cache.match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("x-mailblink-cache", "HIT");
      res.headers.set("cache-control", "no-store");
      return res;
    }
  }

  const mailbox = await publicMailbox(env, rawAddress);
  const messages = await queryMessageList(env, mailbox.id);
  const body = JSON.stringify({ address: mailbox.address, messages, fetchedAt: Date.now() });

  const ttl = Math.max(0, (await getSettings(env)).cache_ttl);
  if (key && ttl > 0) {
    exec.waitUntil(
      cache.put(
        key,
        new Response(body, {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${ttl}` },
        }),
      ),
    );
  }
  return new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-mailblink-cache": "MISS" },
  });
}

export async function getMessage(ctx: Ctx, rawAddress: string, id: number) {
  const mailbox = await publicMailbox(ctx.env, rawAddress);
  return json(await queryMessage(ctx.env, mailbox.id, id), 200, { "cache-control": "no-store" });
}
