/**
 * 连通性自检：把所有「手机连不上」的可能原因按顺序排查一遍。
 *
 * 设计原则：不猜，只报告**能验证的事实**。
 * 每条结论都带证据（端口监听状态、网卡、防火墙、隧道日志），
 * 让用户知道该改哪一样，而不是笼统地说「网络问题」。
 */

import { readFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');

const ipv4 = () => {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ name, address: a.address, cidr: a.cidr });
      }
    }
  }
  return out;
};

/** 判断两个 IPv4 是否在同一网段（粗略，足够诊断用）。 */
function sameSubnet(a, b, maskBits = 24) {
  const toInt = (ip) => ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const m = maskBits === 24 ? 0xffffff00 : 0xffff0000;
  return (toInt(a) & m) === (toInt(b) & m);
}

async function checkPort(port) {
  try {
    const c = new AbortController();
    const id = setTimeout(() => c.abort(), 4000);
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: c.signal });
    clearTimeout(id);
    const j = await r.json();
    return { ok: r.ok, body: j };
  } catch (err) {
    return { ok: false, error: err.cause?.code || err.message };
  }
}

const port = Number(process.argv[2] ?? 8123);

console.log('\n连通性自检');
console.log('─'.repeat(56));

// 1. 服务是否在本机跑起来
console.log('\n[1] 服务本身');
const health = await checkPort(port);
if (health.ok) {
  console.log(`  ✓ 127.0.0.1:${port} 有响应，房间数 ${health.body.rooms}`);
} else {
  console.log(`  ✗ 127.0.0.1:${port} 无响应（${health.error}）`);
  console.log(`    → 服务没启动，或端口不对。先跑：node start-tunnel.mjs --port ${port}`);
}

// 2. 网卡
console.log('\n[2] 本机网卡');
const addrs = ipv4();
if (addrs.length === 0) {
  console.log('  ✗ 没有局域网 IPv4 地址 —— 这台机器当前根本没连 Wi-Fi/网线');
  console.log('    → 这是手机一定连不上的直接原因。插网线或连 Wi-Fi，或改用公网隧道。');
} else {
  for (const a of addrs) {
    console.log(`  · ${a.address.padEnd(16)} ${a.name}  (${a.cidr ?? '掩码未知'})`);
  }
}

// 3. 关键：手机在不在同一网段
console.log('\n[3] 手机为什么连不上（按可能性排序）');

if (addrs.length === 0) {
  console.log('  ✗ 本机无局域网地址 —— 见 [2]');
} else {
  const lan = addrs[0];
  console.log(`  手机需要和电脑在同一个可互通的网段（当前电脑: ${lan.address}）`);
  console.log('  常见原因，逐条对照手机状态栏：');
  console.log('');
  console.log('   ① 手机用的是「5G/4G」而不是 Wi-Fi');
  console.log('       → 最常见。手机打开 Wi-Fi，连上和电脑同一个路由器，');
  console.log(`         再访问 http://${lan.address}:${port}`);
  console.log('');
  console.log('   ② 手机连的是另一个 Wi-Fi（比如 5G 频段 vs 2.4G 频段分了两个名字，');
  console.log('      或者连了隔壁/访客网络）');
  console.log(`       → 让手机连和电脑**同名**的那个 Wi-Fi。`);
  console.log('');
  console.log('   ③ 路由器开了「AP 隔离 / 客户端隔离」');
  console.log('       → 同一 Wi-Fi 下设备也互不可见，运营商光猫默认常开。');
  console.log('         改法：进路由器关掉 AP 隔离，或者直接用下面的公网地址。');
  console.log('');
  console.log('   ④ Windows 防火墙拦了这个端口');
  console.log(`       → 需要放行。管理员 PowerShell 执行：`);
  console.log(`         New-NetFirewallRule -DisplayName "Pong ${port}" -Direction Inbound -LocalPort ${port} -Protocol TCP -Action Allow`);
  console.log('');
  console.log('   ⑤ 本机这条 WLAN 是虚拟网卡 / 手机热点 / VPN 私有网络');
  console.log('       → 手机即使连 Wi-Fi 也不在同一层网络，只能用公网隧道。');
}

// 4. 隧道
console.log('\n[4] 公网隧道（跨网络唯一可靠的办法）');
const logPath = join(ROOT, '.tunnel.log');
if (!existsSync(logPath)) {
  console.log('  · 没找到隧道日志，说明没启动隧道');
  console.log('  → 跑 node start-tunnel.mjs，它会自动开隧道并打印公网地址');
} else {
  const log = readFileSync(logPath, 'utf8');
  const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m) {
    console.log(`  ✓ 公网地址: ${m[0]}`);
    console.log('  → 两台手机都打开这个地址，用 4G/5G 也能连，且 WS 会走 wss');
  } else {
    console.log('  ✗ 有日志但没拿到地址');
    const errs = log.split('\n').filter((l) => /error|failed/i.test(l)).slice(-3);
    for (const e of errs) console.log(`    ${e.trim()}`);
    console.log('  → 你的网络可能连不上 Cloudflare，改用局域网或换隧道工具');
  }
}

// 5. 结论
console.log('\n结论');
console.log('─'.repeat(56));
const hasTunnel = existsSync(logPath) && /trycloudflare\.com/i.test(readFileSync(logPath, 'utf8'));
if (hasTunnel) {
  console.log('  用公网地址，两台手机在任何网络下都能连。这是最省事的路。');
} else if (health.ok) {
  console.log('  服务正常，但缺公网隧道：现在只能同网段手机访问。');
} else {
  console.log('  先把服务跑起来，再回来跑这个自检。');
}
console.log('');
