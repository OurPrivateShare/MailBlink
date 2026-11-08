import { $, api, confirmDialog, copyText, esc, icon, promptDialog, timeAgo, toast } from "./common.js";
import { createViewer } from "./viewer.js";

const state = { config: null, user: null, mailboxes: [], selectedId: null, viewer: null };
const root = $("#root");
const actions = $("#topbar-actions");

const ADDRESS_PATH = /^\/([^/]+@[^/]+)$/;

async function init() {
  const pathMatch = decodeURIComponent(location.pathname).match(ADDRESS_PATH);
  try {
    const [config, me] = await Promise.all([api("/api/config"), pathMatch ? null : api("/api/me")]);
    state.config = config;
    document.querySelectorAll("[data-site-name]").forEach((el) => (el.textContent = config.siteName));
    if (pathMatch) return renderPublic(pathMatch[1].toLowerCase());
    if (location.pathname !== "/") history.replaceState(null, "", "/");
    state.user = me.user;
    state.mailboxes = me.mailboxes;
    state.user ? renderApp() : renderLanding();
  } catch (err) {
    root.innerHTML = `<div class="center-screen"><div class="empty">${icon("info")}<h3>加载失败</h3><p>${esc(err.message)}</p></div></div>`;
  }
}

/* ---------- Public mailbox page: /{address} ---------- */
function renderPublic(address) {
  document.title = `${address} - ${state.config.siteName}`;
  actions.innerHTML = `<a class="btn btn-sm" href="/">${icon("user")}我的邮箱</a>`;
  root.innerHTML = `
    <div class="app" style="flex-direction:column">
      <div class="notice">${icon("info")}<span>这是公开链接：任何知道此地址的人都可以查看邮件。</span></div>
      <div id="viewer" class="main"></div>
    </div>`;
  state.viewer = createViewer($("#viewer"), { address, onMissing: (message) => renderMissing(address, message) });
}

function renderMissing(address, message) {
  state.viewer?.destroy();
  state.viewer = null;
  root.innerHTML = `
    <div class="center-screen">
      <div class="empty">
        ${icon("info")}
        <h3>${esc(message)}</h3>
        <p><span class="mono">${esc(address)}</span> 不存在，或邮箱所有者未开启公开访问。</p>
        <a class="btn btn-primary" href="/">${icon("user")}登录 / 注册</a>
      </div>
    </div>`;
}

/* ---------- Landing (logged out) ---------- */
function renderLanding() {
  actions.innerHTML = "";
  const { domains, allowRegister } = state.config;
  root.innerHTML = `
    <div class="landing">
      <section class="landing-copy">
        <h1>即开即用的临时邮箱</h1>
        <p>注册账号后一键生成专属邮箱，换设备登录即可继续使用；也可通过公开链接直接查看已有邮箱的邮件。</p>
        <ul class="features">
          <li>${icon("zap")}<span><strong>实时收信</strong> · 邮件由 Cloudflare 边缘直接写入，打开即看，无需轮询</span></li>
          <li>${icon("user")}<span><strong>账号归属</strong> · 邮箱绑定到你的账号，地址全局唯一，不会被他人占用</span></li>
          <li>${icon("link")}<span><strong>API 链接</strong> · <code class="mono">/${esc("邮箱地址")}</code> 浏览器看网页，程序取 JSON</span></li>
          <li>${icon("lock")}<span><strong>默认私有</strong> · 邮件仅本人可见，可按需为单个邮箱开启公开链接</span></li>
        </ul>
        <form id="quick-open" class="stack" style="max-width:440px">
          <label class="field">
            <span class="label">快速查看邮箱</span>
            <div class="row">
              <input class="input" name="address" type="email" required placeholder="name@${esc(domains[0] || "example.com")}" autocomplete="off" />
              <button class="btn" type="submit">${icon("external")}打开</button>
            </div>
          </label>
        </form>
      </section>
      <section class="card auth-card" aria-label="账号">
        <div class="tabs" role="tablist">
          <button type="button" role="tab" aria-selected="true" data-tab="login">登录</button>
          ${allowRegister ? `<button type="button" role="tab" aria-selected="false" data-tab="register">注册</button>` : ""}
        </div>
        <form id="auth-form" class="card-pad stack">
          <label class="field"><span class="label">用户名</span>
            <input class="input" name="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" autocomplete="username" placeholder="3-24 位字母、数字或下划线" />
          </label>
          <label class="field"><span class="label">密码</span>
            <input class="input" name="password" type="password" required minlength="8" maxlength="128" autocomplete="current-password" placeholder="至少 8 位" />
          </label>
          <button class="btn btn-primary btn-block" type="submit" data-submit>登录</button>
          ${allowRegister ? "" : `<p class="hint" style="margin:0">管理员已关闭新用户注册。</p>`}
        </form>
      </section>
    </div>`;

  let mode = "login";
  const form = $("#auth-form");
  root.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.onclick = () => {
      mode = tab.dataset.tab;
      root.querySelectorAll("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      $("[data-submit]", form).textContent = mode === "login" ? "登录" : "注册并登录";
      form.password.autocomplete = mode === "login" ? "current-password" : "new-password";
    };
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("[data-submit]", form);
    btn.disabled = true;
    try {
      const data = await api(`/api/auth/${mode}`, {
        method: "POST",
        body: { username: form.username.value.trim(), password: form.password.value },
      });
      state.user = data.user;
      state.mailboxes = data.mailboxes;
      toast(mode === "login" ? "登录成功" : "注册成功", "success");
      renderApp();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  };
  $("#quick-open").onsubmit = (e) => {
    e.preventDefault();
    const value = e.target.address.value.trim().toLowerCase();
    if (value) location.href = `/${value}`;
  };
}

/* ---------- Logged-in app ---------- */
function renderApp() {
  const { config } = state;
  actions.innerHTML = `
    <div class="menu">
      <button type="button" class="btn btn-sm" data-user-menu aria-haspopup="true" aria-expanded="false">${icon("user")}${esc(state.user.username)}</button>
      <div class="menu-panel hidden" role="menu">
        <button type="button" role="menuitem" data-act="password">${icon("lock")}修改密码</button>
        <hr />
        <button type="button" role="menuitem" class="danger" data-act="logout">${icon("logout")}退出登录</button>
      </div>
    </div>`;
  const userMenu = $(".menu-panel", actions);
  $("[data-user-menu]", actions).onclick = (e) => {
    const open = userMenu.classList.toggle("hidden") === false;
    e.currentTarget.setAttribute("aria-expanded", String(open));
  };
  if (!state.menuBound) {
    state.menuBound = true;
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#topbar-actions .menu")) $("#topbar-actions .menu-panel")?.classList.add("hidden");
    });
  }
  userMenu.onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    userMenu.classList.add("hidden");
    if (act === "logout") {
      await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
      state.user = null;
      state.mailboxes = [];
      state.viewer?.destroy();
      renderLanding();
    }
    if (act === "password") changePassword();
  };

  const domainOptions = config.domains.map((d) => `<option value="${esc(d)}">@${esc(d)}</option>`).join("");
  root.innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <section class="card">
          <div class="card-head"><h2 class="card-title">新建邮箱</h2></div>
          <form id="create-form" class="card-pad stack">
            ${
              config.domains.length
                ? `<label class="field">
                    <span class="label">邮箱地址</span>
                    <div class="input-group">
                      <input class="input mono" name="prefix" autocomplete="off" spellcheck="false" maxlength="${config.maxPrefix}"
                        placeholder="留空则随机" aria-describedby="prefix-hint" />
                      <select class="select" name="domain" aria-label="域名">${domainOptions}</select>
                    </div>
                    <span class="hint" id="prefix-hint">前缀 ${config.minPrefix}-${config.maxPrefix} 位，支持小写字母、数字和 . _ -</span>
                  </label>
                  <div class="row">
                    <button type="button" class="btn" data-random>${icon("shuffle")}随机</button>
                    <button type="submit" class="btn btn-primary grow" data-create>${icon("plus")}生成邮箱</button>
                  </div>`
                : `<div class="notice notice-warn">${icon("info")}<span>管理员尚未添加可用域名。</span></div>`
            }
          </form>
        </section>
        <section class="card">
          <div class="card-head">
            <h2 class="card-title">我的邮箱</h2>
            <span class="small muted" data-count></span>
          </div>
          <ul class="box-list" id="box-list" aria-label="我的邮箱列表"></ul>
        </section>
      </aside>
      <div class="main" id="viewer"></div>
    </div>`;

  const form = $("#create-form");
  if (config.domains.length) {
    form.prefix.addEventListener("input", () => {
      form.prefix.value = form.prefix.value.toLowerCase().replace(/[^a-z0-9._-]/g, "");
    });
    $("[data-random]", form).onclick = () => {
      const chars = "abcdefghjkmnpqrstuvwxyz23456789";
      const len = Math.max(config.minPrefix, Math.min(config.maxPrefix, 10));
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      form.prefix.value = [...bytes].map((b, i) => (i === 0 ? chars.slice(0, 23) : chars)[b % (i === 0 ? 23 : chars.length)]).join("");
    };
    form.onsubmit = createMailbox;
  }

  renderBoxList();
  if (state.mailboxes.length) selectMailbox(state.selectedId && state.mailboxes.some((b) => b.id === state.selectedId) ? state.selectedId : state.mailboxes[0].id);
  else renderNoMailbox();
}

async function createMailbox(e) {
  e.preventDefault();
  const form = e.target;
  const prefix = form.prefix.value.trim();
  const { minPrefix, maxPrefix } = state.config;
  if (prefix && (prefix.length < minPrefix || prefix.length > maxPrefix)) {
    toast(`前缀长度需为 ${minPrefix}-${maxPrefix} 个字符`, "error");
    return;
  }
  const btn = $("[data-create]", form);
  btn.disabled = true;
  try {
    const data = await api("/api/mailboxes", {
      method: "POST",
      body: { prefix, domain: form.domain.value },
    });
    state.mailboxes = [data.mailbox, ...state.mailboxes.filter((b) => b.id !== data.mailbox.id)];
    form.prefix.value = "";
    renderBoxList();
    selectMailbox(data.mailbox.id);
    toast("邮箱已生成", "success");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function renderBoxList() {
  const list = $("#box-list");
  if (!list) return;
  $("[data-count]").textContent = `${state.mailboxes.length} / ${state.config.maxMailboxes}`;
  if (!state.mailboxes.length) {
    list.innerHTML = `<li class="small muted" style="padding:12px 10px">还没有邮箱，先在上方生成一个吧。</li>`;
    return;
  }
  list.innerHTML = state.mailboxes
    .map(
      (b) => `
      <li class="box-item ${b.id === state.selectedId ? "active" : ""}" data-id="${b.id}" tabindex="0" role="button" aria-pressed="${b.id === state.selectedId}">
        <span class="grow">
          <span class="addr truncate" style="display:block">${esc(b.address)}</span>
          <span class="meta">${b.last_mail_at ? `最新邮件 ${esc(timeAgo(b.last_mail_at))}` : "暂无邮件"}</span>
        </span>
        ${b.is_public ? `<span class="badge badge-ok" title="已公开，任何人可通过链接查看">${icon("globe")}公开</span>` : ""}
        <button type="button" class="icon-btn" data-copy="${esc(b.address)}" aria-label="复制 ${esc(b.address)}">${icon("copy")}</button>
      </li>`,
    )
    .join("");
  list.onclick = (e) => {
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      e.stopPropagation();
      return copyText(copyBtn.dataset.copy, "邮箱地址已复制");
    }
    const item = e.target.closest(".box-item");
    if (item) selectMailbox(Number(item.dataset.id));
  };
  list.onkeydown = (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("box-item")) {
      e.preventDefault();
      selectMailbox(Number(e.target.dataset.id));
    }
  };
}

function renderNoMailbox() {
  state.viewer?.destroy();
  state.viewer = null;
  $("#viewer").innerHTML = `<div class="card empty">${icon("inbox")}<h3>选择或生成一个邮箱</h3><p>生成后可复制地址用于注册，收到的邮件会显示在这里。</p></div>`;
}

function selectMailbox(id) {
  const mailbox = state.mailboxes.find((b) => b.id === id);
  if (!mailbox) return renderNoMailbox();
  state.selectedId = id;
  document.querySelectorAll(".box-item").forEach((el) => {
    const on = Number(el.dataset.id) === id;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });
  state.viewer?.destroy();
  state.viewer = createViewer($("#viewer"), {
    address: mailbox.address,
    owner: {
      mailbox,
      onVisibilityChange: renderBoxList,
      onDelete: () => deleteMailbox(mailbox),
    },
  });
  if (window.matchMedia("(max-width: 860px)").matches) $("#viewer").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteMailbox(mailbox) {
  const ok = await confirmDialog(`删除 ${mailbox.address} 及其全部邮件？删除后该地址可被他人重新注册。`, {
    danger: true,
    confirmText: "删除",
  });
  if (!ok) return;
  try {
    await api(`/api/mailboxes/${mailbox.id}`, { method: "DELETE" });
    state.mailboxes = state.mailboxes.filter((b) => b.id !== mailbox.id);
    state.selectedId = null;
    renderBoxList();
    state.mailboxes.length ? selectMailbox(state.mailboxes[0].id) : renderNoMailbox();
    toast("邮箱已删除", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function changePassword() {
  const oldPassword = await promptDialog("修改密码", { label: "当前密码", type: "password", confirmText: "下一步" });
  if (!oldPassword) return;
  const newPassword = await promptDialog("修改密码", { label: "新密码（至少 8 位）", type: "password", minLength: 8 });
  if (!newPassword) return;
  try {
    await api("/api/auth/password", { method: "POST", body: { oldPassword, newPassword } });
    toast("密码已修改，其他设备已退出登录", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

init();
