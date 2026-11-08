# MailBlink 临时邮箱

运行在 **Cloudflare Workers 免费版** 上的轻量临时邮箱：注册账号一键生成邮箱、公开 API 链接查看邮件，并带有完整的管理后台。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MyPrivateShare/MailBlink)

> 一键部署按钮要求仓库为 **公开**。私有仓库请用下文「方式二：连接 GitHub 部署」。

---

## 功能一览

### 用户端（`/`）
- 注册 / 登录（用户名 + 密码，PBKDF2 加盐哈希）
- 选择可用域名，自定义前缀或随机生成邮箱，**地址全局唯一**
- 每个邮箱都由注册用户创建并归属该账号，地址全局唯一；发往不存在地址的邮件会被直接拒收
- 我的邮箱列表 → 点击查看全部邮件，邮件正文点击时才加载
- **自动识别验证码**，在列表中一键复制
- 每个邮箱可单独开启 **公开访问**（默认关闭），关闭时只有本人登录后可查看邮件
- 一键复制邮箱地址、API 链接；清空邮件、删除邮箱、修改密码

### 公开 API（无需认证）
仅对已开启「公开」的邮箱有效；未公开或不存在的邮箱统一返回 404。

| 请求 | 返回 |
| --- | --- |
| 浏览器打开 `https://你的域名/name@example.com` | 网页，列出该邮箱所有邮件 |
| `curl https://你的域名/name@example.com` | JSON 邮件列表 |
| `GET /api/public/name@example.com/messages` | JSON 邮件列表（`?refresh=1` 跳过边缘缓存） |
| `GET /api/public/name@example.com/messages/{id}` | JSON 单封邮件（含 HTML / 纯文本正文） |

### 管理后台（`/admin`）
- **收信配置**：Email Worker 实时收信、可选备份转发邮箱
- **域名管理**：增加 / 停用 / 删除可用域名
- **用户管理**：搜索、筛选、查看用户邮箱、修改密码、封禁 / 解封、删除
- **用户管理过滤**：全部 / 已封禁 / 无邮箱 / 不活跃（可选最后活跃日期，默认 3 个月前）；除「全部用户」外可一键删除当前过滤出的所有用户（删除前二次确认）
- **系统设置**：前缀最少字符（默认 5）/ 最多字符、每用户邮箱上限、边缘缓存时间、开关注册
- 邮件不会被自动删除，由用户自行删除或清空

---

## 架构与免费额度优化

```
发件人 ──► Cloudflare Email Routing (Catch-all) ──► Email Worker ──► D1 数据库
                                                      └─► (可选) 备份转发
浏览器 ──► 静态页面 (Workers Static Assets，边缘直出，不计 Worker 请求)
       └─► /api/* ──► Worker ──► D1   (打开邮箱时才读取)
```

| 优化点 | 做法 |
| --- | --- |
| 收信最快、零轮询 | **Email Worker** 直接接收邮件写入 D1，到达即可见 |
| 不实时读取 | 只在打开邮箱 / 点击刷新时请求；自动刷新默认关闭，开启后仅在页面可见时 30 秒一次，10 分钟自动关闭 |
| 减少请求 | 前端为静态资源（**不消耗每日 10 万次 Worker 请求额度**）；登录后一次请求返回用户与邮箱列表 |
| 边缘缓存 | 邮件列表用 Cache API 缓存 10 秒，邮件详情缓存 5 分钟（自定义域名生效） |
| 省 D1 额度 | 设置 / 域名在内存缓存 60 秒；用户活跃时间最多 6 小时写一次；邮件只存正文不存附件 |
| CPU 10ms 限制 | 无框架、无前端构建，Worker 打包体积小 |

---

## 部署步骤

### 准备
1. 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费版即可）
2. 域名已接入 Cloudflare（DNS 托管）
3. 想好管理员密码 `ADMIN_PASSWORD`，并生成会话密钥 `SESSION_SECRET`（可用 `openssl rand -hex 32` 或任意 32 位以上随机字符串）

### 方式一：一键部署（公开仓库）
1. 点击上方 **Deploy to Cloudflare** 按钮
2. 登录 Cloudflare，按提示填写 `ADMIN_PASSWORD`、`SESSION_SECRET`
3. D1 数据库会自动创建，部署命令会自动执行数据库迁移
4. 部署完成后进入下文「部署后配置」

### 方式二：连接 GitHub 部署（私有仓库推荐，网页操作）
1. 打开 [Workers & Pages → 创建](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create) → **导入存储库**（Import a repository）→ 授权 GitHub → 选择本仓库
2. 构建设置：
   - 构建命令：留空
   - 部署命令：`npm run deploy`（部署时自动创建名为 `mailblink` 的 D1 数据库，并执行数据库迁移）
3. 点击 **部署**，完成后进入 Worker → **设置 → 变量和机密**，添加两个 **机密（Secret）**：`ADMIN_PASSWORD`、`SESSION_SECRET`，然后重新部署一次

> `wrangler.jsonc` 中不包含任何数据库 ID、账号 ID 或密码，无需修改即可部署。若账号中已有名为 `mailblink` 的 D1 数据库，会直接复用。

> 即使迁移未执行，Worker 首次访问时也会自动建表。

### 方式三：命令行
```bash
npm install
npx wrangler login
npm run deploy                            # 首次部署自动创建 D1，无需填写 database_id
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

---

## 部署后配置

1. **绑定自定义域名**（API 链接与边缘缓存需要）
   打开 Worker → **设置 → 域和路由 → 添加 → 自定义域**，例如 `mail.example.com`
   直达：[Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)

2. **登录后台添加域名**
   访问 `https://你的域名/admin`，用 `ADMIN_PASSWORD` 登录 → **域名管理** → 添加收信域名（如 `example.com`）

3. **配置收信（Email Worker）**
   1. 打开 [Email Routing](https://dash.cloudflare.com/?to=/:account/:zone/email/routing/routes)，选择收信域名，按提示启用 Email Routing（会自动添加 MX / SPF 记录）
   2. **路由规则 → Catch-all 地址 → 编辑**：操作选择 **发送到 Worker**，目标选择 `mailblink`，保存并 **启用**
   3. 如需保留副本：先在 Email Routing **目标地址** 中添加并验证备份邮箱，再到后台「收信配置」填写 **备份转发邮箱**

4. **（可选）防暴力破解**
   在 [安全性 → WAF → 速率限制规则](https://dash.cloudflare.com/?to=/:account/:zone/security/waf/rate-limiting-rules) 中为 `/api/auth/login` 和 `/api/admin/login` 添加一条规则（免费版可建 1 条）。

---

## 安全说明
- 邮箱开启「公开」后，**任何知道地址的人都能查看邮件**，请勿对重要账号的邮箱开启
- `SESSION_SECRET` 用于签名会话，更换后所有用户和管理员需重新登录
- 邮件 HTML 在禁用脚本的沙箱 iframe 中渲染
- 请勿把任何密码、Token 提交到仓库

## 本地开发
```bash
cp .dev.vars.example .dev.vars   # 填写本地密码
npm install
npm run db:migrate:local
npm run dev
# 模拟收信：
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=a@b.com&to=test1@example.com" --data-binary @mail.eml
```

## 目录结构
```
src/
  index.ts          入口：fetch / email
  router.ts         轻量路由
  auth.ts           用户会话、管理员签名、密码哈希
  db.ts             设置缓存、建表
  mail.ts           邮件解析、存储、验证码识别
  routes/           public / user / admin 接口
public/             静态前端（index / admin / viewer）
migrations/         D1 数据库结构
```
