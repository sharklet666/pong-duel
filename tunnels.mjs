/**
 * 多隧道后端。
 *
 * 为什么要有这一层：免费 quick tunnel 都有各自的脾气，不能只赌一个。
 *
 *   cloudflared  注册稳、延迟低，但实测在这台机器所在网络上，
 *                每隔约 3 分钟会因 "client disconnected" 断一次，
 *                重连那几秒访问就是 Error 1033 / 530。
 *   localtunnel  通过 npm 包（无二进制），域名固定可预测：<子域名>.loca.lt
 *   pinggy       走 ssh，不需要装东西（Windows 自带 OpenSSH），
 *                地址在交互式终端里打印，需要特殊处理才能读到。
 *
 * 策略：默认 cloudflared；如果它反复掉线，工具会自动提示你换一个。
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, openSync } from 'node:fs';

/** 从一段文本里找出各种可能的公网地址。 */
export function findUrl(text) {
  if (!text) return null;
  const patterns = [
    /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
    /https:\/\/[a-z0-9-]+\.loca\.lt/i,
    /https:\/\/[a-z0-9-]+\.pinggy\.link/i,
    /https:\/\/[a-z0-9-]+\.pinggy\.io/i,
    /https:\/\/[a-z0-9-]+\.localhost\.run/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

/**
 * cloudflared 后端。
 * @returns {{ kind: string, kill: Function, onUrl: (url: string) => void }}
 */
export function startCloudflared({ binary, port, root, protocol = 'http2', logPath, onLine }) {
  const logOut = openSync(logPath, 'a');
  const child = spawn(
    binary,
    [
      'tunnel',
      '--url',
      `http://127.0.0.1:${port}`,
      '--no-autoupdate',
      '--protocol',
      protocol,
      '--logfile',
      logPath,
      '--loglevel',
      'info',
    ],
    { cwd: root, stdio: ['ignore', 'inherit', logOut] },
  );

  let lastSize = 0;
  const timer = setInterval(() => {
    if (!existsSync(logPath)) return;
    let text = '';
    try {
      text = readFileSync(logPath, 'utf8');
    } catch {
      return;
    }
    // 只在日志有新增时才解析，避免重复处理
    if (text.length === lastSize) return;
    lastSize = text.length;
    const url = findUrl(text);
    if (url) onLine?.({ type: 'url', url });
  }, 700);

  return {
    kind: 'cloudflared',
    kill: () => {
      clearInterval(timer);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
    child,
  };
}

/**
 * 判断 cloudflared 日志里是否出现了「频繁掉线」的信号。
 * 用于主动提示用户换后端，而不是让用户对着 530 干着急。
 */
export function analyzeLog(logPath) {
  if (!existsSync(logPath)) return { disconnects: 0, healthy: false };
  const text = readFileSync(logPath, 'utf8');
  const disconnectCount = (text.match(/Connection terminated/g) ?? []).length;
  const registered = (text.match(/Registered tunnel connection/g) ?? []).length;
  return {
    disconnects: disconnectCount,
    registered,
    // 注册次数明显多于 1，说明在反复重连
    healthy: registered > 0 && disconnectCount < 3,
  };
}
