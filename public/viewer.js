import { $, $$, api, confirmDialog, copyText, esc, fmtTime, icon, timeAgo, toast } from "./common.js";

const AUTO_REFRESH_MS = 30_000;
const AUTO_REFRESH_MAX_MS = 10 * 60_000;

function frameDoc(html) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; form-action 'none'; frame-src 'none'"><base target="_blank"><style>body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:16px;color:#0f172a;font-size:14px;line-height:1.6;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}a{color:#0f766e}</style></head><body>${html}</body></html>`;
}

/**
 * Renders the mailbox viewer. Emails are fetched only when the viewer opens or the user
 * presses refresh; auto-refresh is opt-in, visible-tab-only and stops after 10 minutes.
 */
export function createViewer(root, { address, owner = null, onMissing = null }) {
  const apiBase = owner
    ? `/api/mailboxes/${owner.mailbox.id}/messages`
    : `/api/public/${encodeURIComponent(address)}/messages`;
  const publicLink = `${location.origin}/${address}`;
  let messages = [];
  let activeId = null;
  let autoTimer = null;
  let autoStartedAt = 0;
  let destroyed = false;

  root.innerHTML = `
    <section class="card viewer" aria-label="邮箱 ${esc(address)}">
      <div class="viewer-head">
        <div class="grow">
          <h2 class="viewer-address" style="margin:0">${esc(address)}</h2>
          <div class="small muted" data-status aria-live="polite">正在加载…</div>
        </div>
        <div class="row wrap">
          <button type="button" class="btn btn-sm" data-copy-addr>${icon("copy")}复制地址</button>
          <button type="button" class="btn btn-sm" data-copy-api>${icon("link")}API 链接</button>
          ${
            owner
              ? `<label class="switch small" title="开启后任何人都可通过链接查看此邮箱的邮件">
                  <input type="checkbox" data-public ${owner.mailbox.is_public ? "checked" : ""} /> 公开
                </label>`
              : ""
          }
          <label class="switch small" title="仅在页面可见时每 30 秒刷新一次，10 分钟后自动关闭">
            <input type="checkbox" data-auto /> 自动刷新
          </label>
          <button type="button" class="btn btn-sm btn-primary" data-refresh data-spin>${icon("refresh")}刷新</button>
          ${
            owner
              ? `<div class="menu">
                  <button type="button" class="icon-btn" data-menu aria-haspopup="true" aria-expanded="false" aria-label="更多操作">${icon("more")}</button>
                  <div class="menu-panel hidden" role="menu">
                    <button type="button" role="menuitem" data-act="open">${icon("external")}在新窗口打开</button>
                    <hr />
                    <button type="button" role="menuitem" data-act="clear">${icon("eraser")}清空所有邮件</button>
                    <button type="button" role="menuitem" class="danger" data-act="delete">${icon("trash")}删除此邮箱</button>
                  </div>
                </div>`
              : ""
          }
        </div>
      </div>
      <div class="viewer-body">
        <div class="mail-list" role="list" aria-label="邮件列表"></div>
        <div class="mail-detail"></div>
      </div>
    </section>`;

  const listEl = $(".mail-list", root);
  const detailEl = $(".mail-detail", root);
  const bodyEl = $(".viewer-body", root);
  const statusEl = $("[data-status]", root);
  const refreshBtn = $("[data-refresh]", root);
  const autoInput = $("[data-auto]", root);
  const publicInput = $("[data-public]", root);
  const apiBtn = $("[data-copy-api]", root);
  const openBtn = $('[data-act="open"]', root);

  function renderVisibility() {
    const isPublic = !owner || owner.mailbox.is_public;
    apiBtn.disabled = !isPublic;
    apiBtn.title = isPublic ? "浏览器打开显示网页，程序请求返回 JSON" : "开启「公开」后才能通过链接查看";
    openBtn?.classList.toggle("hidden", !isPublic);
  }
  renderVisibility();

  publicInput?.addEventListener("change", async () => {
    const next = publicInput.checked;
    publicInput.disabled = true;
    try {
      await api(`/api/mailboxes/${owner.mailbox.id}`, { method: "PATCH", body: { is_public: next } });
      owner.mailbox.is_public = next;
      renderVisibility();
      owner.onVisibilityChange?.();
      toast(next ? "已公开，任何人可通过链接查看邮件" : "已关闭公开，链接将无法查看邮件", "success");
    } catch (err) {
      publicInput.checked = !next;
      toast(err.message, "error");
    } finally {
      publicInput.disabled = false;
    }
  });

  function renderEmptyDetail() {
    detailEl.innerHTML = `<div class="empty">${icon("mail")}<h3>选择一封邮件查看</h3><p>邮件正文仅在点击时加载，节省流量与请求次数。</p></div>`;
  }

  function renderList() {
    if (!messages.length) {
      listEl.innerHTML = `<div class="empty">${icon("inbox")}<h3>暂无邮件</h3><p>使用此地址接收邮件后，点击「刷新」即可看到新邮件。</p></div>`;
      renderEmptyDetail();
      return;
    }
    listEl.innerHTML = messages
      .map(
        (m) => `
        <button type="button" role="listitem" class="mail-item ${m.id === activeId ? "active" : ""}" data-id="${m.id}">
          <div class="row">
            <span class="from grow truncate">${esc(m.from_name || m.from_addr || "未知发件人")}</span>
            <span class="time" title="${esc(fmtTime(m.received_at))}">${esc(timeAgo(m.received_at))}</span>
          </div>
          <div class="row">
            <div class="subject grow truncate">${esc(m.subject)}</div>
            ${m.otp ? `<span class="otp" data-otp="${esc(m.otp)}" title="点击复制验证码">${esc(m.otp)}${icon("copy")}</span>` : ""}
          </div>
          <div class="preview">${esc(m.preview)}</div>
        </button>`,
      )
      .join("");
    if (!activeId) renderEmptyDetail();
  }

  async function load(refresh = false) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add("spin");
    try {
      const data = await api(`${apiBase}${refresh ? "?refresh=1" : ""}`);
      if (destroyed) return;
      messages = data.messages;
      renderList();
      statusEl.textContent = `共 ${messages.length} 封 · 更新于 ${fmtTime(data.fetchedAt).slice(11)}`;
    } catch (err) {
      if (err.status === 404 && onMissing) {
        stopAuto();
        return onMissing(err.message);
      }
      statusEl.textContent = err.message;
      if (!messages.length) listEl.innerHTML = `<div class="empty">${icon("info")}<h3>加载失败</h3><p>${esc(err.message)}</p></div>`;
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("spin");
    }
  }

  async function openMessage(id) {
    activeId = id;
    $$(".mail-item", listEl).forEach((el) => el.classList.toggle("active", Number(el.dataset.id) === id));
    bodyEl.classList.add("show-detail");
    detailEl.innerHTML = `<div class="empty">${icon("refresh", "spin")}<p>正在加载邮件…</p></div>`;
    try {
      const m = await api(`${apiBase}/${id}`);
      if (destroyed || activeId !== id) return;
      const hasHtml = Boolean(m.html_body);
      detailEl.innerHTML = `
        <div class="detail-head">
          <div class="row">
            <button type="button" class="icon-btn back-btn" data-back aria-label="返回列表">${icon("back")}</button>
            <h3 class="detail-subject grow">${esc(m.subject)}</h3>
            ${owner ? `<button type="button" class="icon-btn danger" data-del-msg aria-label="删除邮件">${icon("trash")}</button>` : ""}
          </div>
          <div class="row wrap small">
            <span class="grow truncate"><strong>${esc(m.from_name || m.from_addr)}</strong> <span class="muted">&lt;${esc(m.from_addr)}&gt;</span></span>
            <span class="muted">${esc(fmtTime(m.received_at))}</span>
          </div>
          <div class="row wrap">
            ${m.otp ? `<span class="otp" data-otp="${esc(m.otp)}" title="点击复制验证码">验证码 ${esc(m.otp)}${icon("copy")}</span>` : ""}
            <span class="grow"></span>
            ${
              hasHtml && m.text_body
                ? `<div class="segmented" role="group" aria-label="显示格式">
                    <button type="button" aria-pressed="true" data-mode="html">网页</button>
                    <button type="button" aria-pressed="false" data-mode="text">纯文本</button>
                  </div>`
                : ""
            }
          </div>
        </div>
        <div data-content style="display:flex;flex:1;min-height:0"></div>`;
      const content = $("[data-content]", detailEl);
      const show = (mode) => {
        if (mode === "html") {
          content.innerHTML = `<iframe class="detail-frame" title="邮件正文" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`;
          $("iframe", content).srcdoc = frameDoc(m.html_body);
        } else {
          content.innerHTML = `<pre class="detail-text">${esc(m.text_body || "（无正文）")}</pre>`;
        }
        $$("[data-mode]", detailEl).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
      };
      show(hasHtml ? "html" : "text");
      $$("[data-mode]", detailEl).forEach((b) => (b.onclick = () => show(b.dataset.mode)));
    } catch (err) {
      detailEl.innerHTML = `<div class="empty">${icon("info")}<h3>无法打开邮件</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function stopAuto() {
    clearInterval(autoTimer);
    autoTimer = null;
    autoInput.checked = false;
  }

  const onRootClick = async (e) => {
    const otp = e.target.closest("[data-otp]");
    if (otp) {
      e.stopPropagation();
      return copyText(otp.dataset.otp, `验证码 ${otp.dataset.otp} 已复制`);
    }
    const item = e.target.closest(".mail-item");
    if (item) return openMessage(Number(item.dataset.id));
    if (e.target.closest("[data-back]")) {
      bodyEl.classList.remove("show-detail");
      return;
    }
    if (e.target.closest("[data-copy-addr]")) return copyText(address, "邮箱地址已复制");
    if (e.target.closest("[data-copy-api]")) return copyText(publicLink, "API 链接已复制");
    if (e.target.closest("[data-refresh]")) return load(true);
    if (e.target.closest("[data-del-msg]") && owner) {
      if (!(await confirmDialog("确定删除这封邮件吗？", { danger: true, confirmText: "删除" }))) return;
      try {
        await api(`/api/mailboxes/${owner.mailbox.id}/messages/${activeId}`, { method: "DELETE" });
        messages = messages.filter((m) => m.id !== activeId);
        activeId = null;
        bodyEl.classList.remove("show-detail");
        renderList();
        toast("邮件已删除", "success");
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }
    const menuBtn = e.target.closest("[data-menu]");
    const panel = $(".menu-panel", root);
    if (menuBtn && panel) {
      const open = panel.classList.toggle("hidden") === false;
      menuBtn.setAttribute("aria-expanded", String(open));
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act && owner) {
      panel?.classList.add("hidden");
      const action = act.dataset.act;
      if (action === "open") return window.open(publicLink, "_blank", "noopener");
      if (action === "delete") return owner.onDelete();
      if (action === "clear") {
        if (!(await confirmDialog("将删除此邮箱中的全部邮件，无法恢复。", { danger: true, confirmText: "清空" }))) return;
        try {
          const res = await api(`/api/mailboxes/${owner.mailbox.id}/messages`, { method: "DELETE" });
          messages = [];
          activeId = null;
          renderList();
          toast(`已清空 ${res.deleted} 封邮件`, "success");
        } catch (err) {
          toast(err.message, "error");
        }
      }
    }
  };
  root.addEventListener("click", onRootClick);

  const closeMenu = (e) => {
    if (!e.target.closest(".menu")) $(".menu-panel", root)?.classList.add("hidden");
  };
  document.addEventListener("click", closeMenu);

  autoInput.addEventListener("change", () => {
    if (!autoInput.checked) return stopAuto();
    autoStartedAt = Date.now();
    autoTimer = setInterval(() => {
      if (Date.now() - autoStartedAt > AUTO_REFRESH_MAX_MS) {
        stopAuto();
        toast("自动刷新已在 10 分钟后关闭");
        return;
      }
      if (document.visibilityState === "visible") load(false);
    }, AUTO_REFRESH_MS);
    toast("已开启自动刷新（30 秒一次）");
  });

  load(false);

  return {
    destroy() {
      destroyed = true;
      stopAuto();
      root.removeEventListener("click", onRootClick);
      document.removeEventListener("click", closeMenu);
    },
  };
}
