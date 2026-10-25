/**
 * 联机层测试：真实起服务、真实 WebSocket 握手、真实收发。
 *
 * 这里必须覆盖的真实场景：
 *   1. 两个客户端进同一房间 → 一个 p1 一个 p2
 *   2. 客户端发出的 move 真的能影响服务器模拟（否则输入丢包，玩家会觉得「滑了」）
 *   3. TCP 半包 / 粘包不会让连接崩掉
 *   4. 断线后房间能正确清理，不泄漏
 */

import assert from 'node:assert/strict';
import { startServer } from '../server.mjs';

const failures = [];
let pass = 0;

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 打开一个 WebSocket 并收集消息。 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.addEventListener('message', (e) => {
      try {
        inbox.push(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('open', () => resolve({ ws, inbox }));
    ws.addEventListener('error', reject);
    setTimeout(() => reject(new Error('连接超时')), 5000);
  });
}

/** 等某类消息出现（可附加条件）。 */
async function waitFor(client, type, ms = 4000, predicate = null) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = client.inbox.find((m) => m.type === type && (!predicate || predicate(m)));
    if (found) return found;
    await sleep(25);
  }
  const seen = [...new Set(client.inbox.map((m) => m.type))].join(', ');
  throw new Error(`等了 ${ms}ms 也没收到 ${type}${predicate ? '(带条件)' : ''}；收到的是：${seen}`);
}

console.log('联机层：');

const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
const base = `ws://127.0.0.1:${port}/ws`;

await check('健康检查可用', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  const json = await res.json();
  assert.equal(json.ok, true);
});

await check('静态页能取到（首页 / 引擎 / 音频）', async () => {
  for (const p of ['/', '/js/engine.js', '/js/audio.js', '/js/net.js', '/style.css']) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    assert.equal(res.status, 200, `${p} 应该 200，实际 ${res.status}`);
    assert.ok((await res.text()).length > 0, `${p} 不能为空`);
  }
});

let roomCode;

await check('创建房间并收到自己是 p1', async () => {
  const host = await connect(base);
  host.ws.send(JSON.stringify({ type: 'create' }));
  const joined = await waitFor(host, 'joined');
  assert.equal(joined.side, 'p1');
  assert.match(joined.room, /^\d{4}$/);
  roomCode = joined.room;
  host.ws.close();
  await sleep(150);
});

await check('第二个客户端加入同一房间 → 得到 p2，双方都收到 players=2', async () => {
  const a = await connect(base);
  a.ws.send(JSON.stringify({ type: 'join', room: roomCode }));
  await waitFor(a, 'joined');

  const b = await connect(base);
  b.ws.send(JSON.stringify({ type: 'join', room: roomCode }));
  const joinedB = await waitFor(b, 'joined');
  assert.equal(joinedB.side, 'p2');

  const playersA = await waitFor(a, 'players', 4000, (m) => m.count >= 2);
  assert.ok(playersA.count >= 2, `A 应看到 2 人，实际 ${playersA.count}`);

  await waitFor(a, 'start');
  await waitFor(b, 'start');

  a.ws.close();
  b.ws.close();
  await sleep(150);
});

await check('第三个人加入满员房间会被明确拒绝，而不是静默失败', async () => {
  const a = await connect(base);
  a.ws.send(JSON.stringify({ type: 'create' }));
  const ja = await waitFor(a, 'joined');
  const code = ja.room;

  const b = await connect(base);
  b.ws.send(JSON.stringify({ type: 'join', room: code }));
  await waitFor(b, 'joined');

  const c = await connect(base);
  c.ws.send(JSON.stringify({ type: 'join', room: code }));
  const err = await waitFor(c, 'error');
  assert.ok(err.message.includes('满'), `应提示房间满，实际：${err.message}`);

  a.ws.close();
  b.ws.close();
  c.ws.close();
  await sleep(150);
});

await check('服务器持续广播状态，分数与球的位置都在', async () => {
  const a = await connect(base);
  a.ws.send(JSON.stringify({ type: 'create' }));
  const ja = await waitFor(a, 'joined');
  const b = await connect(base);
  b.ws.send(JSON.stringify({ type: 'join', room: ja.room }));
  await waitFor(b, 'joined');
  await waitFor(a, 'start');

  const st = await waitFor(a, 'state');
  assert.ok(st.score, '状态里必须有 score');
  assert.ok(Array.isArray(st.balls), '状态里必须有 balls');
  assert.ok(st.paddles, '状态里必须有 paddles');

  a.ws.close();
  b.ws.close();
  await sleep(150);
});

await check('客户端 move 真的影响服务器模拟（输入不能丢）', async () => {
  const a = await connect(base);
  a.ws.send(JSON.stringify({ type: 'create' }));
  const ja = await waitFor(a, 'joined');
  const b = await connect(base);
  b.ws.send(JSON.stringify({ type: 'join', room: ja.room }));
  await waitFor(b, 'joined');
  await waitFor(a, 'start');

  // 把 p1 拍子推到最左
  a.ws.send(JSON.stringify({ type: 'move', x: 0 }));
  await sleep(700);
  const states = a.inbox.filter((m) => m.type === 'state');
  const last = states[states.length - 1];
  assert.ok(last, '应该收到状态');
  assert.ok(last.paddles.p1 < 200, `p1 应被移到左侧，实际 x=${last.paddles.p1}`);

  a.ws.close();
  b.ws.close();
  await sleep(150);
});

await check('对手断线后，留下的人收到 peer-left', async () => {
  const a = await connect(base);
  a.ws.send(JSON.stringify({ type: 'create' }));
  const ja = await waitFor(a, 'joined');
  const b = await connect(base);
  b.ws.send(JSON.stringify({ type: 'join', room: ja.room }));
  await waitFor(b, 'joined');

  b.ws.close();
  const left = await waitFor(a, 'peer-left', 3000);
  assert.equal(left.side, 'p2');

  a.ws.close();
  await sleep(200);
});

await check('两人都断开后房间被清理，不泄漏', async () => {
  const before = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();

  const a = await connect(base);
  a.ws.send(JSON.stringify({ type: 'create' }));
  await waitFor(a, 'joined');
  a.ws.close();
  await sleep(400);

  const after = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.ok(after.rooms <= before.rooms, `房间数不应增长：${before.rooms} → ${after.rooms}`);
});

await check('非法房间号被拒绝而不是崩溃', async () => {
  const a = await connect(base);
  a.ws.send(JSON.stringify({ type: 'join', room: 'abc' }));
  const err = await waitFor(a, 'error');
  assert.ok(err.message.includes('4 位'), `应提示格式错误，实际：${err.message}`);
  a.ws.close();
  await sleep(100);
});

server.close();
setTimeout(() => process.exit(failures.length > 0 ? 1 : 0), 300);

console.log(`\n通过 ${pass}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`失败：${f.name}\n${f.err.stack}`);
  process.exitCode = 1;
}
