/**
 * 端到端：模拟两台手机真实对打一整局。
 *
 * 这不是单元测试，是「验收」：两个独立 WebSocket 客户端进同一房间，
 * 各自持续发送拍子位置，验证比分真的会推进、最终有人赢。
 *
 * 如果这个用例失败，说明游戏在真实联机下根本玩不完一局 ——
 * 那是比任何单点 bug 都严重的问题。
 */

import { startServer } from '../server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.addEventListener('message', (e) => {
      try {
        inbox.push({ ...JSON.parse(e.data), at: Date.now() });
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('open', () => resolve({ ws, inbox }));
    ws.addEventListener('error', reject);
    setTimeout(() => reject(new Error('连接超时')), 6000);
  });
}

async function waitFor(c, type, ms = 6000, pred = null) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const f = c.inbox.find((m) => m.type === type && (!pred || pred(m)));
    if (f) return f;
    await sleep(20);
  }
  throw new Error(`没等到 ${type}`);
}

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

const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
const WS = `ws://127.0.0.1:${port}/ws`;

console.log('端到端对战：');

let a, b;

await check('两台客户端进同一房间，分别拿到 p1 / p2', async () => {
  a = await connect(WS);
  a.ws.send(JSON.stringify({ type: 'create' }));
  const ja = await waitFor(a, 'joined');
  b = await connect(WS);
  b.ws.send(JSON.stringify({ type: 'join', room: ja.room }));
  const jb = await waitFor(b, 'joined');
  if (ja.side !== 'p1' || jb.side !== 'p2') {
    throw new Error(`方位分配错误：${ja.side} / ${jb.side}`);
  }
  await waitFor(a, 'start');
  await waitFor(b, 'start');
});

await check('双方持续收到状态，且比分字段存在', async () => {
  await waitFor(a, 'state', 3000);
  const s = a.inbox.filter((m) => m.type === 'state').pop();
  if (!s.score || !Array.isArray(s.balls)) throw new Error('状态结构不完整');
});

await check('玩家主动放弃 → 对方真的得分（比分在推进）', async () => {
  // p1 把拍子甩到最角落，故意漏接几球
  const spam = setInterval(() => {
    a.ws.send(JSON.stringify({ type: 'move', x: 0 }));
    b.ws.send(JSON.stringify({ type: 'move', x: 1000 }));
  }, 40);

  // 等比分变化
  const start = Date.now();
  let progressed = false;
  while (Date.now() - start < 25000) {
    const s = a.inbox.filter((m) => m.type === 'state').pop();
    if (s && (s.score.p1 > 0 || s.score.p2 > 0)) {
      progressed = true;
      break;
    }
    await sleep(100);
  }
  clearInterval(spam);
  if (!progressed) throw new Error('25 秒内比分没有变化 —— 球很可能永远接得下来或永远接不到');
});

await check('比分推进过程中没有出现 NaN / undefined 坐标', async () => {
  const bad = a.inbox
    .filter((m) => m.type === 'state')
    .flatMap((m) => m.balls)
    .filter((b) => !Number.isFinite(b[0]) || !Number.isFinite(b[1]));
  if (bad.length > 0) throw new Error(`发现 ${bad.length} 个非法坐标，例如 ${JSON.stringify(bad[0])}`);
});

await check('最终能打到赛点并结束（一局可以玩完）', async () => {
  const deadline = Date.now() + 60000;
  let over = null;
  while (Date.now() < deadline) {
    over = a.inbox.find((m) => m.type === 'gameover');
    if (over) break;
    await sleep(100);
  }
  if (!over) {
    const last = a.inbox.filter((m) => m.type === 'state').pop();
    throw new Error(`60 秒内没打完一局；当前比分 ${JSON.stringify(last?.score)}`);
  }
  const winnerScore = Math.max(over.score.p1, over.score.p2);
  if (winnerScore < 11) throw new Error(`结束时胜者只有 ${winnerScore} 分，应该到 11`);
  console.log(`      （${over.winner} 以 ${over.score.p1}:${over.score.p2} 获胜）`);
});

await check('结束后再来一局能把比分清零', async () => {
  a.ws.send(JSON.stringify({ type: 'rematch' }));
  await waitFor(a, 'rematch-waiting', 3000);
  b.ws.send(JSON.stringify({ type: 'rematch' }));
  await waitFor(a, 'start', 5000);
  await sleep(300);
  const s = a.inbox.filter((m) => m.type === 'state').pop();
  if (s && (s.score.p1 !== 0 || s.score.p2 !== 0)) {
    throw new Error(`新一局比分应该从 0:0 开始，实际 ${s.score.p1}:${s.score.p2}`);
  }
});

a.ws.close();
b.ws.close();
server.close();

console.log(`\n通过 ${pass}，失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n失败：${f.name}\n${f.err.stack}`);
  process.exitCode = 1;
}
setTimeout(() => process.exit(process.exitCode ?? 0), 300);
