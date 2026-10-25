/**
 * 一键启动：游戏服务 + 公网隧道。
 *
 * 为什么需要它：
 *   手机上「无法打开页面 ERR_ADDRESS_UNREACHABLE」几乎都是同一类原因 ——
 *   手机和电脑不在同一个可互通的网段（手机用 5G、路由器开了 AP 隔离、
 *   或者电脑那条 WLAN 根本是另一台设备的私有网络）。
 *   局域网 IP 在这种情况下永远连不上，再怎么调端口都没用。
 *
 * 隧道把服务直接暴露成 https://xxx.trycloudflare.com，
 * 手机用 4G/5G 或任何 Wi-Fi 都能打开，而且因为是 HTTPS，WebSocket 会走 wss://，不会被浏览器拦。
 *
 * 用法：
 *   node start-tunnel.mjs
 * 或指定端口：
 *   node start-tunnel.mjs --port 8080
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, openSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');

function parseArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const PORT = Number(parseArg('port', 8080));

const CANDIDATES = [
  join(ROOT, 'bin', 'cloudflared.exe'),
  join(ROOT, 'bin', 'cloudflared'),
];

const cloudflared = CANDIDATES.find((p) => existsSync(p));

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function banner() {
  const lines = [];
  lines.push('');
  lines.push('  ┌──────────────────────────────────────────────┐');
  lines.push('  │           双人乒乓球 · Pong Duel             │');
  lines.push('  └──────────────────────────────────────────────┘');
  lines.push('');
  lines.push(`  本机:      http://127.0.0.1:${PORT}`);
  const lan = lanAddresses();
  if (lan.length > 0) {
    lines.push('  局域网:');
    for (const l of lan) lines.push(`             http://${l.address}:${PORT}    (${l.name})`);
    lines.push('             ↑ 手机必须和电脑连同一个 Wi-Fi，且未开启 AP 隔离');
  } else {
    lines.push('  局域网:    未检测到可用的局域网地址');
  }
  lines.push('');
  if (cloudflared) {
    lines.push('  公网:      正在建立隧道，稍等几秒…');
    lines.push('             ↑ 手机用 4G/5G 也能进，两人**不同网络**也能对战');
  } else {
    lines.push('  公网:      未找到 cloudflared，只有局域网可用');
  }
  lines.push('');
  console.log(lines.join('\n'));
}

banner();

// ---- 游戏服务 ----
// 注意：沙箱可能禁止「用管道捕获子进程输出」（EPERM）。
// 所以这里不接管 stdout，让它直接继承终端 —— 无论如何都能跑。
const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'inherit',
});

server.on('exit', (code) => {
  console.log(`\n  服务已退出（code ${code}），一并关闭隧道。`);
  tunnel?.kill();
  process.exit(code ?? 0);
});

// ---- 隧道 ----
let tunnel = null;
let publicUrl = null;

if (cloudflared) {
  // 同样不用管道：cloudflared 支持 --logfile，让它把日志写进文件，我们定时读。
  // 这样即使父进程被沙箱限制「不能读子进程管道」，也拿得到公网地址。
  const logPath = join(ROOT, '.tunnel.log');
  try {
    rmSync(logPath, { force: true });
  } catch {
    /* ignore */
  }

  const logOut = openSync(logPath, 'a');

  // ��议选择：
  //   默认走 QUIC（UDP 7844）。但实测这台机器所在网络对 Cloudflare 的 QUIC
  //   很不友好 —— 日志里反复出现 "failed to dial to edge with quic" 和
  //   "control stream error: context deadline exceeded"，隧道看起来在跑
  //   （进程还在），公网却是 Error 1033。
  //   TCP 7844 实测可达，所以强制走 http2 更稳。
  //   想换回去：node start-tunnel.mjs --protocol quic
  const protocol = parseArg('protocol', 'http2');

  tunnel = spawn(
    cloudflared,
    [
      'tunnel',
      '--url',
      `http://127.0.0.1:${PORT}`,
      '--no-autoupdate',
      '--protocol',
      protocol,
      '--logfile',
      logPath,
      '--loglevel',
      'info',
    ],
    { cwd: ROOT, stdio: ['ignore', 'inherit', logOut] },
  );

  /** 从日志文件里找公网地址。 */
  const watch = setInterval(() => {
    if (publicUrl) return;
    let text = '';
    try {
      text = readFileSync(logPath, 'utf8');
    } catch {
      return;
    }
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m) {
      publicUrl = m[0];
      clearInterval(watch);
      console.log('');
      console.log('  ════════════════════════════════════════════════════');
      console.log(`  公网地址:  ${publicUrl}`);
      console.log('  ════════════════════════════════════════════════════');
      console.log('  两台手机都打开上面这个网址，跨网络也能对战。');
      console.log('  提醒：网址每次重启都会变，重启后要重新发给对方。');
      console.log('');
    }
  }, 600);

  // 超时放弃
  setTimeout(() => {
    if (!publicUrl) {
      clearInterval(watch);
      console.error('\n  60 秒内没拿到公网地址，隧道可能被网络挡住了。');
      console.error('  你的网络连不上 Cloudflare 的话：让两台手机和电脑连同一个 Wi-Fi，用上面的局域网地址。');
    }
  }, 60000);

  tunnel.on('exit', (code) => {
    clearInterval(watch);
    if (!publicUrl) {
      console.error(`\n  隧道启动失败（code ${code}）。见 ${logPath}`);
      console.error('  → 你的网络可能连不上 Cloudflare。改让两台手机连同一个 Wi-Fi，用局域网地址。');
      return;
    }
    console.error(`\n  隧道已断开（code ${code}）。局域网地址仍然可用；`);
    console.error('  如果你俩不在同一网络，需要重新建立隧道 —— 重启本脚本即可（网址会变）。');
  });
}

// ---- 退出清理 ----
const shutdown = () => {
  console.log('\n  正在关闭…');
  tunnel?.kill();
  server.kill();
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
