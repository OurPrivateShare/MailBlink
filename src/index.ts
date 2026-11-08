import { ensureSchema, getSettings, isMissingTable } from "./db";
import { handleIncomingEmail } from "./mail";
import { type Ctx, Router } from "./router";
import * as admin from "./routes/admin";
import { getConfig, getMessage, listMessages } from "./routes/public";
import * as user from "./routes/user";
import { type Env, HttpError, json, normalizeAddress } from "./util";

const router = new Router()
  .on("GET", "/api/config", getConfig)
  .on("GET", "/api/public/:addr/messages", (c) => listMessages(c, c.params[0], c.url.searchParams.has("refresh")))
  .on("GET", "/api/public/:addr/messages/:id", (c) => getMessage(c, c.params[0], Number(c.params[1])))
  .on("GET", "/api/me", user.me)
  .on("POST", "/api/auth/register", user.register)
  .on("POST", "/api/auth/login", user.login)
  .on("POST", "/api/auth/logout", user.logout)
  .on("POST", "/api/auth/password", user.changePassword)
  .on("GET", "/api/mailboxes", user.listMailboxes)
  .on("POST", "/api/mailboxes", user.createMailbox)
  .on("PATCH", "/api/mailboxes/:id", user.setMailboxPublic)
  .on("DELETE", "/api/mailboxes/:id", user.deleteMailbox)
  .on("GET", "/api/mailboxes/:id/messages", user.listOwnMessages)
  .on("GET", "/api/mailboxes/:id/messages/:mid", user.getOwnMessage)
  .on("DELETE", "/api/mailboxes/:id/messages", user.clearMessages)
  .on("DELETE", "/api/mailboxes/:id/messages/:mid", user.deleteMessage)
  .on("POST", "/api/admin/login", admin.login)
  .on("POST", "/api/admin/logout", admin.logout)
  .on("GET", "/api/admin/session", admin.session)
  .on("GET", "/api/admin/stats", admin.stats)
  .on("GET", "/api/admin/settings", admin.getSettingsRoute)
  .on("PUT", "/api/admin/settings", admin.updateSettings)
  .on("GET", "/api/admin/domains", admin.listDomains)
  .on("POST", "/api/admin/domains", admin.addDomain)
  .on("PATCH", "/api/admin/domains/:name", admin.updateDomain)
  .on("DELETE", "/api/admin/domains/:name", admin.deleteDomain)
  .on("GET", "/api/admin/users", admin.listUsers)
  .on("GET", "/api/admin/users/:id/mailboxes", admin.userMailboxes)
  .on("POST", "/api/admin/users/:id/ban", admin.banUser)
  .on("POST", "/api/admin/users/:id/password", admin.resetPassword)
  .on("DELETE", "/api/admin/users/:id", admin.deleteUser)
  .on("DELETE", "/api/admin/users", admin.deleteFilteredUsers);

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000",
};

function withHeaders(res: Response) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

async function handleApi(ctx: Ctx): Promise<Response> {
  const { req, url } = ctx;
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "跨站请求被拒绝");
  }
  const match = router.match(req.method, url.pathname);
  if (!match) throw new HttpError(404, "接口不存在");
  if (match === "method") throw new HttpError(405, "请求方法不支持");
  ctx.params = match.params;
  try {
    return await match.handler(ctx);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    await ensureSchema(ctx.env);
    return match.handler(ctx);
  }
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const ctx: Ctx = { req, env, exec, url, params: [] };

    try {
      if (url.pathname.startsWith("/api/")) return withHeaders(await handleApi(ctx));

      // Non-asset path reached the Worker. `/{address}` from scripts/curl returns JSON;
      // browsers get the SPA shell which renders the public mailbox view.
      const address = normalizeAddress(url.pathname.slice(1));
      const accept = req.headers.get("accept") || "";
      if (address && !accept.includes("text/html")) {
        return withHeaders(await handleApi({ ...ctx, url: new URL(`/api/public/${address}/messages`, url) }));
      }
      const shell = await env.ASSETS.fetch(new Request(new URL("/", url), req));
      return new Response(shell.body, { status: address ? 200 : 404, headers: shell.headers });
    } catch (err) {
      if (err instanceof HttpError) return withHeaders(json({ error: err.message, ...err.extra }, err.status));
      console.error(err);
      return withHeaders(json({ error: "服务器内部错误" }, 500));
    }
  },

  async email(message: ForwardableEmailMessage, env: Env, exec: ExecutionContext) {
    try {
      await handleIncomingEmail(message, env, await getSettings(env));
    } catch (err) {
      if (isMissingTable(err)) {
        await ensureSchema(env);
        await handleIncomingEmail(message, env, await getSettings(env));
        return;
      }
      console.error("email handler failed", err);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
