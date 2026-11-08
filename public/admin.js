import { $, $$, api, confirmDialog, esc, fmtTime, icon, infoDialog, promptDialog, timeAgo, toast } from "./common.js";

const root = $("#root");
const actions = $("#topbar-actions");
const ROUTING_LINK = "https://dash.cloudflare.com/?to=/:account/:zone/email/routing/routes";

const PAGES = [
  { id: "overview", label: "概览", icon: "chart" },
  { id: "mail", label: "收信配置", icon: "mail" },
  { id: "domains", label: "域名管理", icon: "globe" },
  { id: "users", label: "用户管理", icon: "users" },
  { id: "system", label: "系统设置", icon: "settings" },
];

let settings = null;

async function init() {
  try {
    await api("/api/admin/session");
    renderShell();
  } catch (err) {
    if (err.status === 503) {
      root.innerHTML = `<div class="center-screen"><div class="notice notice-danger">${icon("info")}<span>${esc(err.message)}。请在 Cloudflare 中为 Worker 添加 <code>ADMIN_PASSWORD</code> 密钥。</span></div></div>`;
      return;
    }
    renderLogin();
  }
}

function renderLogin() {
  actions.innerHTML = "";
  root.innerHTML = `
    <div class="center-screen">
      <form id="login" class="card card-pad stack" style="width:min(360px,100%)">
        <h1 class="page-title">管理员登录</h1>
        <label class="field"><span class="label">管理员密码</span>
          <input class="input" type="password" name="password" required autocomplete="current-password" />
        </label>
        <button class="btn btn-primary btn-block" type="submit">登录</button>
        <p class="hint" style="margin:0">密码为部署时设置的 <code>ADMIN_PASSWORD</code> 密钥。</p>
      </form>
    </div>`;
  const form = $("#login");
  form.password.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/login", { method: "POST", body: { password: form.password.value } });
      renderShell();
    } catch (err) {
      toast(err.message, "error");
    }
  };
}

function renderShell() {
  actions.innerHTML = `<button type="button" class="btn btn-sm" id="admin-logout">${icon("logout")}退出</button>`;
  $("#admin-logout").onclick = async () => {
    await api("/api/admin/logout", { method: "POST" }).catch(() => undefined);
    renderLogin();
  };
  root.innerHTML = `
    <div class="admin">
      <nav class="admin-nav" aria-label="后台导航">
        ${PAGES.map((p) => `<button type="button" data-page="${p.id}">${icon(p.icon)}${p.label}</button>`).join("")}
      </nav>
      <div class="admin-main" id="page"></div>
    </div>`;
  $$("[data-page]").forEach((b) => (b.onclick = () => go(b.dataset.page)));
  go(location.hash.slice(1) || "overview");
}

function go(page) {
  if (!PAGES.some((p) => p.id === page)) page = "overview";
  history.replaceState(null, "", `#${page}`);
  $$("[data-page]").forEach((b) => (b.dataset.page === page ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  const el = $("#page");
  el.innerHTML = `<p class="muted">加载中…</p>`;
  const render = { overview, mail, domains, users, system }[page];
  render(el).catch((err) => {
    if (err.status === 401) return renderLogin();
    el.innerHTML = `<div class="notice notice-danger">${icon("info")}<span>${esc(err.message)}</span></div>`;
  });
}

async function loadSettings() {
  settings = await api("/api/admin/settings");
  return settings;
}

async function saveSettings(patch, btn) {
  if (btn) btn.disabled = true;
  try {
    settings = await api("/api/admin/settings", { method: "PUT", body: patch });
    toast("已保存", "success");
    return settings;
  } catch (err) {
    toast(err.message, "error");
    throw err;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- 概览 ---------- */
async function overview(el) {
  const s = await api("/api/admin/stats");
  const stat = (label, value) => `<div class="card stat"><div class="value">${value ?? 0}</div><div class="label">${label}</div></div>`;
  const check = (ok, text, action) =>
    `<li class="row" style="align-items:flex-start">${ok ? `<span class="badge badge-ok">${icon("shieldCheck")}已完成</span>` : `<span class="badge badge-warn">${icon("info")}待配置</span>`}<span class="grow">${text}${action ? ` · ${action}` : ""}</span></li>`;
  el.innerHTML = `
    <h1 class="page-title">概览</h1>
    <div class="stats">
      ${stat("注册用户", s.users)}${stat("封禁用户", s.banned)}${stat("邮箱总数", s.mailboxes)}
${stat("邮件总数", s.messages)}${stat("24 小时新邮件", s.messages24h)}
    </div>
    <section class="card">
      <div class="card-head"><h2 class="card-title">部署检查</h2></div>
      <ul class="card-pad stack" style="list-style:none;margin:0">
        ${check(s.domains > 0, `已添加 ${s.domains} 个域名`, `<a href="#domains" data-goto="domains">管理域名</a>`)}
        ${check(true, "Email Routing：域名 Catch-all 规则需指向本 Worker（推荐，实时收信）", `<a href="${ROUTING_LINK}" target="_blank" rel="noopener">打开 Email Routing</a>`)}
        ${check(Boolean(s.forwardTo), s.forwardTo ? `收到的邮件将同时备份转发到 ${esc(s.forwardTo)}` : "未设置备份转发邮箱（可选）", `<a href="#mail" data-goto="mail">设置</a>`)}
      </ul>
    </section>`;
  $$("[data-goto]", el).forEach((a) => (a.onclick = (e) => (e.preventDefault(), go(a.dataset.goto))));
}

/* ---------- 收信配置 ---------- */
async function mail(el) {
  const s = await loadSettings();
  el.innerHTML = `
    <h1 class="page-title">收信配置</h1>
    <section class="card">
      <div class="card-head"><h2 class="card-title">${icon("zap")} Email Worker 实时收信</h2></div>
      <form id="worker-form" class="card-pad stack">
        <div class="notice">${icon("info")}<span>在 Cloudflare Email Routing 中，把每个域名的 <strong>Catch-all</strong> 动作设为「发送到 Worker」并选择本 Worker，邮件到达即写入数据库。</span></div>
        <ol class="steps">
          <li>打开 <a href="${ROUTING_LINK}" target="_blank" rel="noopener">Email Routing → 路由规则</a>，选择域名</li>
          <li>在 <strong>Catch-all 地址</strong> 处点击编辑，动作选择 <strong>发送到 Worker</strong>，目标选择本 Worker 并启用</li>
          <li>如需保留副本，在下方填写备份邮箱（需先在 Email Routing「目标地址」中验证）</li>
        </ol>
        <div class="form-grid">
          <label class="field"><span class="label">备份转发邮箱（可选）</span>
            <input class="input" name="forward_to" type="email" value="${esc(s.forward_to)}" placeholder="backup@example.com" />
            <span class="hint">留空则不转发。</span>
          </label>
        </div>
        <div><button class="btn btn-primary" type="submit">保存</button></div>
      </form>
    </section>`;

  const wf = $("#worker-form");
  wf.onsubmit = (e) => {
    e.preventDefault();
    saveSettings({ forward_to: wf.forward_to.value }, $("[type=submit]", wf)).catch(() => undefined);
  };
}

/* ---------- 域名 ---------- */
async function domains(el) {
  const draw = (list) => {
    el.innerHTML = `
      <h1 class="page-title">域名管理</h1>
      <section class="card">
        <form id="domain-form" class="card-pad row wrap">
          <label class="field grow" style="min-width:220px"><span class="sr-only">新域名</span>
            <input class="input" name="name" placeholder="例如 example.com" required autocomplete="off" />
          </label>
          <button class="btn btn-primary" type="submit">${icon("plus")}添加域名</button>
        </form>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>域名</th><th>邮箱数</th><th>添加时间</th><th>启用</th><th><span class="sr-only">操作</span></th></tr></thead>
            <tbody>
              ${
                list.length
                  ? list
                      .map(
                        (d) => `<tr>
                          <td class="mono">${esc(d.name)}</td>
                          <td>${d.mailboxes}</td>
                          <td>${esc(fmtTime(d.created_at))}</td>
                          <td><label class="switch"><input type="checkbox" data-toggle="${esc(d.name)}" ${d.enabled ? "checked" : ""} aria-label="启用 ${esc(d.name)}" /></label></td>
                          <td><button type="button" class="icon-btn danger" data-del="${esc(d.name)}" aria-label="删除 ${esc(d.name)}">${icon("trash")}</button></td>
                        </tr>`,
                      )
                      .join("")
                  : `<tr><td colspan="5" class="muted">尚未添加域名</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </section>
      <div class="notice">${icon("info")}<span>每个域名都需在 Cloudflare 托管，并在 <a href="${ROUTING_LINK}" target="_blank" rel="noopener">Email Routing</a> 中启用路由、将 Catch-all 指向本 Worker。前缀最少字符数在「系统设置」中调整。</span></div>`;

    const form = $("#domain-form");
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api("/api/admin/domains", { method: "POST", body: { name: form.name.value } });
        toast("域名已添加", "success");
        draw(r.domains);
      } catch (err) {
        toast(err.message, "error");
      }
    };
    $$("[data-toggle]", el).forEach(
      (input) =>
        (input.onchange = async () => {
          try {
            const r = await api(`/api/admin/domains/${encodeURIComponent(input.dataset.toggle)}`, { method: "PATCH", body: { enabled: input.checked } });
            draw(r.domains);
          } catch (err) {
            toast(err.message, "error");
          }
        }),
    );
    $$("[data-del]", el).forEach(
      (btn) =>
        (btn.onclick = async () => {
          if (!(await confirmDialog(`删除域名 ${btn.dataset.del}？已有邮箱和邮件不会删除，但该域名将无法生成和查看。`, { danger: true, confirmText: "删除" }))) return;
          try {
            const r = await api(`/api/admin/domains/${encodeURIComponent(btn.dataset.del)}`, { method: "DELETE" });
            draw(r.domains);
          } catch (err) {
            toast(err.message, "error");
          }
        }),
    );
  };
  draw((await api("/api/admin/domains")).domains);
}

/* ---------- 用户 ---------- */
const USER_FILTERS = {
  all: { label: "全部用户" },
  banned: { label: "已封禁用户", action: "删除已封禁用户" },
  empty: { label: "无邮箱用户", action: "删除无邮箱用户" },
  inactive: { label: "不活跃用户", action: "删除不活跃用户" },
};

async function users(el) {
  const defaultDate = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const query = { q: "", filter: "all", before: defaultDate, page: 1, total: 0 };
  el.innerHTML = `
    <h1 class="page-title">用户管理</h1>
    <section class="card">
      <div id="user-filter" class="card-pad row wrap">
        <label class="grow" style="min-width:200px"><span class="sr-only">按用户名过滤</span>
          <input class="input" type="search" name="q" placeholder="输入用户名过滤" autocomplete="off" />
        </label>
        <label class="field-inline"><span class="label">过滤</span>
          <select class="select" name="filter">
            ${Object.entries(USER_FILTERS)
              .map(([value, f]) => `<option value="${value}">${f.label}</option>`)
              .join("")}
          </select>
        </label>
        <label class="field-inline hidden" data-before-field><span class="label">最后活跃早于</span>
          <input class="input" type="date" name="before" value="${defaultDate}" max="${new Date().toISOString().slice(0, 10)}" />
        </label>
        <button type="button" class="btn btn-danger-solid hidden" data-bulk-del>${icon("trash")}<span data-bulk-label></span></button>
      </div>
      <div class="table-wrap" id="user-table"></div>
      <div class="card-pad row" id="pager" style="border-top:1px solid var(--border)"></div>
    </section>`;

  const bar = $("#user-filter");
  const filterSelect = $("[name=filter]", bar);
  const beforeInput = $("[name=before]", bar);
  const bulkBtn = $("[data-bulk-del]", bar);

  const filterParams = () => {
    const params = new URLSearchParams({ filter: query.filter });
    if (query.q) params.set("q", query.q);
    if (query.filter === "inactive") params.set("before", String(new Date(`${query.before}T00:00:00`).getTime()));
    return params;
  };

  const renderBar = () => {
    const action = USER_FILTERS[query.filter].action;
    $("[data-before-field]", bar).classList.toggle("hidden", query.filter !== "inactive");
    bulkBtn.classList.toggle("hidden", !action);
    bulkBtn.disabled = !query.total;
    $("[data-bulk-label]", bulkBtn).textContent = action ? `${action}（${query.total}）` : "";
  };

  const load = async () => {
    const params = filterParams();
    params.set("page", String(query.page));
    const data = await api(`/api/admin/users?${params}`);
    query.total = data.total;
    renderBar();
    $("#user-table").innerHTML = `
      <table class="table">
        <thead><tr><th>用户名</th><th>邮箱数</th><th>注册时间</th><th>最后活跃</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          ${
            data.users.length
              ? data.users
                  .map(
                    (u) => `<tr>
                      <td><strong>${esc(u.username)}</strong></td>
                      <td><button type="button" class="btn btn-sm" data-boxes="${u.id}" data-name="${esc(u.username)}">${u.mailboxes}</button></td>
                      <td>${esc(fmtTime(u.created_at))}</td>
                      <td title="${esc(fmtTime(u.last_active_at))}">${esc(timeAgo(u.last_active_at))}</td>
                      <td>${u.banned ? `<span class="badge badge-danger">已封禁</span>` : `<span class="badge badge-ok">正常</span>`}</td>
                      <td class="row">
                        <button type="button" class="btn btn-sm" data-pass="${u.id}">改密码</button>
                        <button type="button" class="btn btn-sm" data-ban="${u.id}" data-banned="${u.banned}">${u.banned ? "解封" : "封禁"}</button>
                        <button type="button" class="btn btn-sm btn-danger" data-del="${u.id}" data-name="${esc(u.username)}">删除</button>
                      </td>
                    </tr>`,
                  )
                  .join("")
              : `<tr><td colspan="6" class="muted">没有匹配的用户</td></tr>`
          }
        </tbody>
      </table>`;
    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    $("#pager").innerHTML = `
      <span class="small muted grow">共 ${data.total} 个用户 · 第 ${data.page}/${pages} 页</span>
      <button type="button" class="btn btn-sm" data-prev ${data.page <= 1 ? "disabled" : ""}>上一页</button>
      <button type="button" class="btn btn-sm" data-next ${data.page >= pages ? "disabled" : ""}>下一页</button>`;
    $("[data-prev]").onclick = () => (query.page--, load());
    $("[data-next]").onclick = () => (query.page++, load());
  };

  const reload = () => load().catch((err) => toast(err.message, "error"));
  let qTimer;
  $("[name=q]", bar).oninput = (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      Object.assign(query, { q: e.target.value.trim(), page: 1 });
      reload();
    }, 300);
  };
  filterSelect.onchange = () => {
    Object.assign(query, { filter: filterSelect.value, page: 1 });
    reload();
  };
  beforeInput.onchange = () => {
    if (!beforeInput.value) return;
    Object.assign(query, { before: beforeInput.value, page: 1 });
    reload();
  };
  bulkBtn.onclick = async () => {
    const { label, action } = USER_FILTERS[query.filter];
    const scope =
      (query.filter === "inactive" ? `最后活跃早于 ${query.before} 的` : `所有「${label}」`) +
      (query.q ? `中用户名包含「${query.q}」的` : "");
    const ok = await confirmDialog(`将删除${scope}共 ${query.total} 个用户，其名下所有邮箱和邮件将一并删除，操作不可恢复。`, {
      title: action,
      danger: true,
      confirmText: "确认删除",
    });
    if (!ok) return;
    bulkBtn.disabled = true;
    try {
      const r = await api(`/api/admin/users?${filterParams()}`, { method: "DELETE" });
      toast(`已删除 ${r.count} 个用户`, "success");
      query.page = 1;
      await load();
    } catch (err) {
      toast(err.message, "error");
      bulkBtn.disabled = false;
    }
  };

  $("#user-table").onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    try {
      if (t.dataset.boxes) {
        const { mailboxes } = await api(`/api/admin/users/${t.dataset.boxes}/mailboxes`);
        const rows = mailboxes.length
          ? mailboxes
              .map(
                (b) => `<li class="row small">${b.is_public ? `<a class="mono grow truncate" href="/${esc(b.address)}" target="_blank" rel="noopener">${esc(b.address)}</a>` : `<span class="mono grow truncate">${esc(b.address)}</span>`}<span class="muted">${b.messages} 封</span>${b.is_public ? `<span class="badge badge-ok">公开</span>` : `<span class="badge badge-muted">私有</span>`}</li>`,
              )
              .join("")
          : `<li class="small muted">该用户没有邮箱</li>`;
        await infoDialog(`${t.dataset.name} 的邮箱`, `<ul class="stack" style="list-style:none;margin:0;padding:0;max-height:50vh;overflow:auto">${rows}</ul>`, {
          closeText: "关闭",
        });
        return;
      }
      if (t.dataset.pass) {
        const pw = await promptDialog("重置用户密码", { label: "新密码（至少 8 位）", type: "text", minLength: 8 });
        if (!pw) return;
        await api(`/api/admin/users/${t.dataset.pass}/password`, { method: "POST", body: { password: pw } });
        toast("密码已重置，用户需重新登录", "success");
      }
      if (t.dataset.ban) {
        const banned = t.dataset.banned !== "1";
        await api(`/api/admin/users/${t.dataset.ban}/ban`, { method: "POST", body: { banned } });
        toast(banned ? "已封禁" : "已解封", "success");
        await load();
      }
      if (t.dataset.del) {
        if (!(await confirmDialog(`删除用户 ${t.dataset.name}？其名下所有邮箱和邮件将一并删除。`, { danger: true, confirmText: "删除" }))) return;
        await api(`/api/admin/users/${t.dataset.del}`, { method: "DELETE" });
        toast("用户已删除", "success");
        await load();
      }
    } catch (err) {
      toast(err.message, "error");
    }
  };

  await load();
}

/* ---------- 系统设置 ---------- */
async function system(el) {
  const s = await loadSettings();
  el.innerHTML = `
    <h1 class="page-title">系统设置</h1>
    <form id="sys-form" class="card card-pad stack">
      <div class="form-grid">
        <label class="field"><span class="label">站点名称</span><input class="input" name="site_name" value="${esc(s.site_name)}" maxlength="40" /></label>
        <label class="field"><span class="label">邮箱前缀最少字符</span><input class="input" type="number" name="min_prefix" min="1" max="32" value="${s.min_prefix}" /><span class="hint">默认 5，随机生成的前缀也不会短于此值</span></label>
        <label class="field"><span class="label">邮箱前缀最多字符</span><input class="input" type="number" name="max_prefix" min="4" max="64" value="${s.max_prefix}" /></label>
        <label class="field"><span class="label">每个用户最多邮箱数</span><input class="input" type="number" name="max_mailboxes" min="1" max="1000" value="${s.max_mailboxes}" /></label>
        <label class="field"><span class="label">邮件列表边缘缓存（秒）</span><input class="input" type="number" name="cache_ttl" min="0" max="300" value="${s.cache_ttl}" /><span class="hint">同一邮箱短时间内被反复打开时直接返回缓存，0 为关闭（仅自定义域名生效）</span></label>
      </div>
      <label class="switch"><input type="checkbox" name="allow_register" ${s.allow_register ? "checked" : ""} /> 允许新用户注册</label>
      <div><button class="btn btn-primary" type="submit">保存设置</button></div>
    </form>`;
  const f = $("#sys-form");
  f.onsubmit = (e) => {
    e.preventDefault();
    saveSettings(
      {
        site_name: f.site_name.value,
        min_prefix: f.min_prefix.value,
        max_prefix: f.max_prefix.value,
        max_mailboxes: f.max_mailboxes.value,
        cache_ttl: f.cache_ttl.value,
        allow_register: f.allow_register.checked,
      },
      $("[type=submit]", f),
    ).catch(() => undefined);
  };
}

init();
