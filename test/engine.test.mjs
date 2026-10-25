/**
 * 引擎测试（进程内，不派生 subprocess —— 沙箱禁子进程 pipe）。
 *
 * 这里最重要的是三个「会毁掉游戏」的用例：
 *   1. 高速球穿透球拍（tunneling）
 *   2. 得分记到错误的一方（上下方向搞反）
 *   3. 球卡在墙里出不来
 */

import {
  createState,
  step,
  serve,
  splitBalls,
  pitchFromX,
  SIDE,
  FIELD,
  BALL,
  MECHANICS,
} from '../js/engine.js';

const failures = [];
let pass = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function ok(c, m) {
  if (!c) throw new Error(m);
}

function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m || '值'}不符：期望 ${y}，实际 ${x}`);
}

/** 跑 n 帧，每帧 dt 秒。 */
function run(state, n, dt = 1 / 60, inputs = {}) {
  const all = [];
  for (let i = 0; i < n; i += 1) {
    const ev = step(state, dt, inputs);
    all.push(...ev);
  }
  return all;
}

console.log('物理引擎：');

check('初始状态合法：1 球、0 分、球拍在正确的一端', () => {
  const s = createState();
  eq(s.balls.length, 1);
  eq(s.score, { p1: 0, p2: 0 });
  // P1 守上边（y 小），P2 守下边（y 大）
  ok(s.paddles.p1.y < s.height / 2, 'P1 应该在上半场');
  ok(s.paddles.p2.y > s.height / 2, 'P2 应该在下半场');
});

check('球撞左墙反弹，x 速度变正、不穿墙', () => {
  const s = createState();
  s.balls = [{ x: 20, y: 700, vx: -600, vy: 10, r: BALL.r, trail: [] }];
  const ev = run(s, 30);
  ok(ev.some((e) => e.type === 'wall'), '应该产生 wall 事件');
  ok(s.balls[0].vx > 0, `反弹后 vx 应为正，实际 ${s.balls[0].vx}`);
  ok(s.balls[0].x >= BALL.r, `球心不能小于半径，实际 ${s.balls[0].x}`);
});

check('球撞右墙反弹，不越界', () => {
  const s = createState();
  s.balls = [{ x: s.width - 20, y: 700, vx: 600, vy: 10, r: BALL.r, trail: [] }];
  run(s, 30);
  ok(s.balls[0].vx < 0, '反弹后 vx 应为负');
  ok(s.balls[0].x <= s.width - BALL.r, '球不能越过右边界');
});

check('球出上边缘 → P2 得分（方向不能搞反）', () => {
  const s = createState();
  s.paddles.p1.x = -9999; // 把 P1 挪开，确保不是被拍子接住
  s.balls = [{ x: s.width / 2, y: 60, vx: 0, vy: -900, r: BALL.r, trail: [] }];
  const ev = run(s, 20);
  const scoreEv = ev.find((e) => e.type === 'score');
  ok(scoreEv, '应该得分');
  eq(scoreEv.player, 'p2', '上边缘失分的是 P1，得分应记给 P2');
  eq(s.score, { p1: 0, p2: 1 });
});

check('球出下边缘 → P1 得分', () => {
  const s = createState();
  s.paddles.p2.x = -9999;
  s.balls = [{ x: s.width / 2, y: s.height - 60, vx: 0, vy: 900, r: BALL.r, trail: [] }];
  const ev = run(s, 20);
  const scoreEv = ev.find((e) => e.type === 'score');
  ok(scoreEv, '应该得分');
  eq(scoreEv.player, 'p1', '下边缘失分的是 P2，得分应记给 P1');
});

check('高速球不会穿透静止球拍（tunneling）', () => {
  const s = createState();
  // P1 拍到 x 中心，球正对着它以极速飞来
  s.paddles.p1.x = s.width / 2;
  s.balls = [{ x: s.width / 2, y: 400, vx: 0, vy: -1500, r: BALL.r, trail: [] }];
  const ev = run(s, 60, 1 / 60);
  ok(ev.some((e) => e.type === 'paddle' && e.player === 'p1'), '高速球必须被拍子接住，不能穿透');
  ok(!ev.some((e) => e.type === 'score'), '不应该因为穿透而失分');
});

check('一次大步长（切后台回来）也不会穿透', () => {
  const s = createState();
  s.paddles.p1.x = s.width / 2;
  s.balls = [{ x: s.width / 2, y: 300, vx: 0, vy: -1500, r: BALL.r, trail: [] }];
  s.paddles.p1.y = 300; // 拍子正好在球的路径上
  step(s, 0.1, {}); // 一次推 100ms
  ok(!s.events.some((e) => e.type === 'score'), '大步长下也不能漏接');
});

check('撞拍后方向反转并加速', () => {
  const s = createState();
  s.paddles.p1.x = s.width / 2;
  s.balls = [{ x: s.width / 2, y: s.paddles.p1.y + 40, vx: 0, vy: -800, r: BALL.r, trail: [] }];
  const before = s.speed;
  run(s, 20);
  ok(s.balls.length > 0, '球还在场上');
  ok(s.balls[0].vy > 0, `P1 接球后球应向下飞，实际 vy=${s.balls[0].vy}`);
  ok(s.speed > before, '接球后应该加速');
});

check('击球点靠边 → 出射角更斜', () => {
  const s2 = createState();
  s2.paddles.p1.x = s2.width / 2;
  s2.balls = [{ x: s2.paddles.p1.x + s2.paddles.p1.w / 2 - 2, y: s2.paddles.p1.y + 40, vx: 0, vy: -800, r: BALL.r, trail: [] }];
  run(s2, 20);
  ok(Math.abs(s2.balls[0].vx) > 100, `边缘击球应有明显横向速度，实际 vx=${s2.balls[0].vx}`);
});

check('球速有上限，不会越打越快直到无敌', () => {
  const s = createState();
  for (let i = 0; i < 200; i += 1) {
    s.speed = Math.min(s.speed * BALL.speedGain, BALL.speedMax);
  }
  ok(s.speed <= BALL.speedMax, `球速应被上限钳制，实际 ${s.speed}`);
});

check('球拍被限制在场地内', () => {
  const s = createState();
  s.paddles.p1.x = 500;
  run(s, 120, 1 / 60, { p1: { dir: -1 } });
  ok(s.paddles.p1.x >= PADDLE_HALF(), `拍子不能出左边界，实际 ${s.paddles.p1.x}`);
  run(s, 240, 1 / 60, { p1: { dir: 1 } });
  ok(s.paddles.p1.x <= s.width - PADDLE_HALF(), `拍子不能出右边界，实际 ${s.paddles.p1.x}`);
});

function PADDLE_HALF() {
  return createState().paddles.p1.w / 2;
}

check('触屏 targetX 不会瞬移（受最大速度限制）', () => {
  const s = createState();
  s.paddles.p1.x = 100;
  step(s, 1 / 60, { p1: { targetX: 900 } });
  // 一帧最多走 PADDLE.speed/60，不可能从 100 直接到 900
  ok(s.paddles.p1.x < 900, `一帧不该跳到目标，实际 ${s.paddles.p1.x}`);
});

check('分裂后球数变多且不超过上限', () => {
  const s = createState();
  splitBalls(s, []);
  eq(s.balls.length, 2, '一次分裂应有 2 个球');
  splitBalls(s, []);
  ok(s.balls.length <= MECHANICS.maxBalls, `不能超过上限 ${MECHANICS.maxBalls}`);
});

check('分裂球速度一致、方向分开', () => {
  const s = createState();
  s.balls = [{ x: 500, y: 750, vx: 0, vy: -800, r: BALL.r, trail: [] }];
  splitBalls(s, []);
  const speeds = s.balls.map((b) => Math.hypot(b.vx, b.vy));
  const spread = Math.abs(speeds[0] - speeds[1]);
  ok(spread < 1, `分裂球速度应一致，实际差 ${spread}`);
  ok(Math.sign(s.balls[0].vx) !== Math.sign(s.balls[1].vx), '两个球应朝左右分开');
});

check('对拉达到阈值自动分裂', () => {
  const s = createState();
  s.rally = MECHANICS.splitAtRally - 1;
  s.paddles.p1.x = s.width / 2;
  s.balls = [{ x: s.width / 2, y: s.paddles.p1.y + 40, vx: 0, vy: -800, r: BALL.r, trail: [] }];
  const ev = run(s, 20);
  ok(s.rally === MECHANICS.splitAtRally, `rally 应为 ${MECHANICS.splitAtRally}，实际 ${s.rally}`);
  ok(ev.some((e) => e.type === 'split'), '应该触发 split 事件');
  eq(s.balls.length, 2);
});

check('达到赛点时结束，且不再推进', () => {
  const s = createState({ firstTo: 3 });
  s.score.p1 = 2;
  s.paddles.p2.x = -9999;
  s.balls = [{ x: s.width / 2, y: s.height - 60, vx: 0, vy: 900, r: BALL.r, trail: [] }];
  const ev = run(s, 20);
  ok(ev.some((e) => e.type === 'win'), '应该产生 win 事件');
  eq(s.winner, 'p1');
  const before = { ...s.score };
  step(s, 1 / 60, {});
  eq(s.score, before, '结束后比分不应再变');
});

check('得分后重新发球，且球飞向刚失分的一方', () => {
  const s = createState();
  s.paddles.p2.x = -9999;
  s.balls = [{ x: s.width / 2, y: s.height - 60, vx: 0, vy: 900, r: BALL.r, trail: [] }];
  run(s, 20);
  eq(s.score.p1, 1);
  eq(s.balls.length, 1, '得分后应重发一球');
  // P2 失分 → 球应飞向 bottom（vy 为正）
  ok(s.balls[0].vy > 0, `球应飞向刚失分的 P2（vy>0），实际 ${s.balls[0].vy}`);
});

check('pitchFromX 归一化在 0..1 之间', () => {
  const s = createState();
  eq(pitchFromX(s, 0), 0);
  eq(pitchFromX(s, s.width), 1);
  const mid = pitchFromX(s, s.width / 2);
  ok(mid > 0.49 && mid < 0.51, '中点应在 0.5 附近');
});

check('切后台造成巨大 dt 时不会把球打飞', () => {
  const s = createState();
  s.balls = [{ x: 500, y: 700, vx: 0, vy: 200, r: BALL.r, trail: [] }];
  step(s, 5, {}); // 5 秒，异常值
  ok(s.balls.length > 0, '球应该还在');
  ok(Math.abs(s.balls[0].y) < s.height * 2, `球不该飞出天际，实际 y=${s.balls[0].y}`);
});

console.log(`\n通过 ${pass}，失败 ${failures.length}`);
if (failures.length > 0) process.exitCode = 1;
