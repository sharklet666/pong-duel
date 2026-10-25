# 长期地址部署指南

**先说结论**：现在的 `https://xxx.trycloudflare.com` 是**临时隧道** ——
地址每次重启都变、连接会反复掉。它适合「今天想玩一把」，
**不适合「长期有效」**。

长期有效需要一个固定地址 + 24 小时在线的机器。有两条路，按推荐顺序：

---

## 路线 A：部署到免费云平台（推荐，永久免费）

**优点**：地址固定、不用开电脑、没有隧道掉线问题。
**代价**：免费套餐会休眠（有人访问时自动唤醒，第一次打开慢 30–60 秒）。

### 为什么选 Render

这个游戏的服务器是 **一个 Node 进程 + WebSocket**，没有数据库、没有文件依赖。
Render 免费套餐恰好支持「常驻 Node 服务 + WebSocket」，是目前最省事的。

Fly.io、Koyeb 也能跑，但它们要么要信用卡、要么配置更绕。
**Render 只要 GitHub 账号**。

### 步骤（约 15 分钟）

**1. 把这个目录推到 GitHub**

```powershell
cd pong-duel
git init
git add .
git commit -m "pong duel"
```

> ⚠️ 提交前确认 `.gitignore` 生效 —— **不要**把 `bin/cloudflared.exe`（52MB）传上去。
> 仓库里别放任何密钥。

然后在 GitHub 网页新建一个仓库（Private 也可以），按提示推送：

```powershell
git remote add origin https://github.com/<你的用户名>/pong-duel.git
git branch -M main
git push -u origin main
```

**2. 在 Render 建服务**

1. 打开 <https://dashboard.render.com>，用 GitHub 登录
2. **New → Web Service**
3. 选你刚推的仓库
4. 关键三项：
   - **Runtime**: Node
   - **Build Command**: 留空（没有依赖要装）
   - **Start Command**: `node server.mjs`
5. **Environment Variables** 加一条：
   - `PORT` → **不要写**。Render 会自动注入 `PORT`，我们的服务已经读 `process.env.PORT`
6. 点 **Create Web Service**

**3. 拿到固定地址**

部署完成后 Render 给你一个地址，形如：

```
https://pong-duel-xxxx.onrender.com
```

**这个地址是永久的**，不会变。发给谁都能打开。

> 免费套餐 15 分钟无人访问会休眠。休眠后第一次打开要等 30–60 秒唤醒，
> 之后一会儿就正常了。**两个人一起玩之前，先各自打开一次「预热」**，
> 避免建房时对方还在等唤醒。

**4. 验证**

```powershell
node doctor.mjs --url https://pong-duel-xxxx.onrender.com
```

或者直接打开地址，看到大厅界面就成功。

---

## 路线 B：Cloudflare 具名隧道 + 自己的域名（真正稳定，但要花钱）

**优点**：自己电脑跑服务，地址固定在你自己的域名上，没有休眠。
**代价**：需要**一个域名**（约 ¥30–60/年），而且**电脑必须开着**。

### 步骤

**1. 域名托管到 Cloudflare**

买一个域名（阿里云/腾讯云/Namecheap 都行），把 DNS 服务器改成 Cloudflare 的
（在 Cloudflare 添加站点后会给你两个 NS 地址，去域名商后台改）。

**2. 登录 cloudflared**（会弹浏览器）

```powershell
cd pong-duel
.\bin\cloudflared.exe tunnel login
```

**3. 建一条具名隧道**

```powershell
.\bin\cloudflared.exe tunnel create pong
```

它会打印一个 **Tunnel ID**，并生成证书在 `%USERPROFILE%\.cloudflared\`。

**4. 配置域名指向本机**

新建文件 `%USERPROFILE%\.cloudflared\config.yml`：

```yaml
tunnel: <上一步的 Tunnel ID>
credentials-file: C:\Users\wxh\.cloudflared\<Tunnel ID>.json

ingress:
  - hostname: pong.你的域名.com
    service: http://127.0.0.1:8123
  - service: http_status:404
```

**5. 把域名绑上去**

```powershell
.\bin\cloudflared.exe tunnel route dns pong <Tunnel ID>
```

这一步会在 Cloudflare 自动创建 CNAME 记录。

**6. 启动**

```powershell
node server.mjs                 # 先起游戏服务（端口 8123）
.\bin\cloudflared.exe tunnel run pong    # 另开一个窗口跑隧道
```

之后 `https://pong.你的域名.com` **永远是你的服务**，
重启电脑后重新跑这两条命令即可，**地址不变**。

> 这条路不需要 `--protocol http2`，具名隧道走的是账号通道，比 quick tunnel 稳得多。
> 仍然受你本机网络影响，但不会像 quick tunnel 那样每 3 分钟掉一次。

---

## 两条路怎么选

| | 路线 A（云平台） | 路线 B（自建域名） |
|---|---|---|
| 地址固定 | ✅ | ✅ |
| 需要电脑开机 | ❌ | ✅ 必须开着 |
| 花费 | 免费 | 域名 ¥30–60/年 |
| 稳定性 | 好（休眠会慢一次） | 很好（取决于本机网络） |
| 上手难度 | 中（要传 GitHub） | 中（要动 DNS） |
| 适合 | **推荐给你** | 想长期当正式服务 |

---

## 本机长期开着（最省事但不推荐）

如果你不想折腾云平台，就让这台机器一直开着 + 让隧道自动重连。
但 quick tunnel **地址会变**，每次变了都要重新发给对方 —— 这不叫「长期有效」。

---

## 现在立刻能做的

在当前临时地址失效之前：

```powershell
node doctor.mjs 8123            # 检查本机状态
node start-tunnel.mjs           # 重建隧道（地址会变）
```

如果你决定走路线 A，把这个目录推到 GitHub 后告诉我仓库地址，
我可以帮你把 `render.yaml` 之类的部署配置补齐，省掉手点几项。
