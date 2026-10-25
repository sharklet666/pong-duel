# 长期地址：Render 部署

**目标**：一个永久的网址，两个人随时都能打开对战。

**已经替你准备好的**（不用你动手）：
- `render.yaml` —— Render 自动识别的部署配置
- `.gitignore` —— 已验证挡住 55MB 的 cloudflared.exe（仓库只有 118KB）
- 服务端已适配云环境：读 `process.env.PORT`、监听 `0.0.0.0`、`/healthz` 健康检查
- 已修掉云平台上才会暴露的几个问题（见文末）

---

## 你要做的三步

### 第一步：推到 GitHub

在这个目录下：

```powershell
git remote add origin https://github.com/<你的用户名>/pong-duel.git
git push -u origin main
```

> 先在 GitHub 网页上新建一个空仓库，名字用 `pong-duel`，**不要**勾选
> "Add a README" / "Add .gitignore"（否则会跟本地冲突）。

### 第二步：在 Render 建服务

1. 打开 <https://dashboard.render.com>，用 **GitHub 登录**
2. 点 **New +** → **Web Service**
3. 选刚推的 `pong-duel` 仓库 → **Connect**
4. 平台会自动读取 `render.yaml`，确认这几项：
   - **Runtime**: Node
   - **Build Command**: 空
   - **Start Command**: `node server.mjs`
   - **Health Check Path**: `/healthz`
5. **Instance Type**: Free
6. 点 **Create Web Service**

> 如果它没有自动识别 `render.yaml`，就手动按上面四项填，效果一样。

### 第三步：拿到永久地址

部署约 2–3 分钟。完成后地址形如：

```
https://pong-duel-xxxx.onrender.com
```

**这个地址永久不变**，发给谁都能打开，你关掉电脑也照样能玩。

---

## 关于免费套餐的休眠（重要）

Render 免费实例**15 分钟无人访问会休眠**。休眠后第一次打开要等 **30–60 秒**唤醒。

这不是故障，但会让「创建房间」那一步体验很差 —— 对方还在等唤醒，房号可能已经超时。

**建议玩法**：
1. 开局前，两人**各自先打开一次**网址（这会把服务唤醒）
2. 等页面出来（大厅界面），再建房、加入

> 想彻底免掉休眠，升到 Render 付费套餐（$7/月起），或走 Cloudflare 具名隧道 +
> 自己的域名（服务跑在自己电脑上，需电脑常开）。见 `DEPLOY.md` 的路线 B。

---

## 部署后自检

```powershell
# 把地址换成你的
node doctor.mjs --url https://pong-duel-xxxx.onrender.com
```

或者直接打开网址，看到「双人乒乓球」大厅就成功。

---

## 为云平台修掉的问题

这些问题在本机跑不出来，只在长时间运行的服务器上暴露：

| 问题 | 后果 | 修法 |
|---|---|---|
| **upgrade socket 不触发 `close`** | 客户端走了服务器不知道，房间永远不回收，跑几天内存泄漏 | 同时监听 `end`/`close`/`error`（`onSocketGone`） |
| **没有心跳** | 反向代理判连接空闲，60 秒后掐断，玩家掉线 | 每 30 秒发 WebSocket ping |
| **收到 ping 不回 pong** | 违反 RFC 6455，代理判连接死亡 | 原样回 pong |
| **单人建房后走掉，tick 没启动** | 空房间回收逻辑根本不执行 | 独立的 reaper 定时器 |
| **心跳句柄声明在使用之后** | 运行时 TDZ 崩溃 | 提前声明 |

每一项都有对应的回归测试（`test/heartbeat.test.mjs`）。

---

## 测试

```powershell
node test/engine.test.mjs     # 19 项物理
node test/layout.test.mjs     # 11 种设备尺寸
node test/net.test.mjs        # 10 项联机
node test/heartbeat.test.mjs  # 4 项心跳与回收（云平台关键）
node test/e2e.test.mjs        # 完整打完一局
```
