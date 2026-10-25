/**
 * 心跳与长期稳定性测试。
 *
 * 云平台部署后，服务要连续跑很多天。这里验证三件在生产上才会暴露的事：
 *   1. 收到 ping 必须回 pong（RFC 6455，否则代理会判连接死亡）
 *   2. 空闲连接不能被误杀（浏览器不发 move 时也不能断）
 *   3. 空房间会被回收（否则跑几天内存泄漏）
 */

import { startServer } from '../server.mjs';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });

/** 手工构造一个 WebSocket 客户端，用来精确控制帧。 */
function rawConnect() {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      const key = randomBytes(16).toString('base64');
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    const frames = [];
    let buf = Buffer.alloc(0);
    let handshook = false;

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        handshook = true;
        buf = buf.subarray(idx + 4);
        resolve({ sock, frames });
      }
      // 解析服务端帧（无掩码）
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        frames.push({ opcode, payload: buf.subarray(off, off + len) });
        buf = buf.subarray(off + len);
      }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('握手超时')), 5000);
  });
}

/** 客户端 → 服务端帧（必须加掩码）。 */
function clientFrame(opcode, payload = Buffer.alloc(0)) {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | masked.length]), mask, masked]);
}

console.log('心跳与稳定性：');

await check('收到 ping 会回 pong（否则代理会判连接死亡）', async () => {
  const { sock, frames } = await rawConnect();
  await sleep(300);
  const payload = Buffer.from('abc');
  sock.write(clientFrame(0x9, payload));
  await sleep(400);
  const pong = frames.find((f) => f.opcode === 0xa);
  if (!pong) throw new Error('没有收到 pong 帧');
  if (pong.payload.toString() !== 'abc') throw new Error('pong 应原样带回 ping 的载荷');
  sock.destroy();
});

await check('空房间会被回收，不会永远占着定时器', async () => {
  const before = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  const { sock } = await rawConnect();
  sock.write(clientFrame(0x1, Buffer.from(JSON.stringify({ type: 'create' }))));
  await sleep(400);
  const during = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  if (during.rooms <= before.rooms) throw new Error('建房后房间数应增加');
  sock.destroy();
  // 等心跳 tick 把空房间清掉
  await sleep(1200);
  const after = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  if (after.rooms > before.rooms) throw new Error(`空房间应被回收：${before.rooms} → ${after.rooms}`);
});

await check('长时间无 move 的空闲连接不会被误杀', async () => {
  const { sock, frames } = await rawConnect();
  sock.write(clientFrame(0x1, Buffer.from(JSON.stringify({ type: 'create' }))));
  await sleep(500);
  // 8 秒不发任何东西，只回 pong（模拟浏览器空闲）
  const pings = [];
  for (let i = 0; i < 16; i += 1) {
    await sleep(500);
    for (const f of frames) {
      if (f.opcode === 0x9 && !pings.includes(f)) {
        pings.push(f);
        sock.write(clientFrame(0xa, f.payload));
      }
    }
  }
  if (sock.destroyed) throw new Error('空闲 8 秒后连接被误杀');
  // 8 秒内可能还没到 30 秒心跳，但连接必须活着
  sock.write(clientFrame(0x1, Buffer.from(JSON.stringify({ type: 'move', x: 123 }))));
  await sleep(300);
  if (sock.destroyed) throw new Error('发送数据时连接已断');
  sock.destroy();
});

await check('healthz 在不暴露内部细节的前提下可用（供平台健康检查）', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/healthz`);
  const j = await r.json();
  if (j.ok !== true) throw new Error('healthz 应返回 ok:true');
  if (typeof j.rooms !== 'number') throw new Error('healthz 应报告房间数');
});

server.close();
setTimeout(() => {
  console.log(`\n通过 ${pass}，失败 ${failures.length}`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`\n失败：${f.name}\n${f.err.stack}`);
    process.exitCode = 1;
  }
  process.exit(failures.length > 0 ? 1 : 0);
}, 300);
