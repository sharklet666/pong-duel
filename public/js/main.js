/**
 * 主程序：渲染、输入、联机、音效接线。
 *
 * 响应式策略（这是这个需求最容易做砸的地方）：
 *   - 逻辑坐标固定 1000×1500，渲染时整体等比缩放，物理永远不受屏幕尺寸影响
 *   - 画布按 devicePixelRatio 放大，避免手机高分屏上发虚
 *   - 竖屏时画布占满可用高度；横屏时居中并留边，不拉伸变形
 *   - 触屏用「手指绝对位置」控制拍子，不用摇杆（拍子只需横向一维移动）
 */

import * as E from './engine.js';
import * as audio from './audio.js';
import { Net, Interpolator } from './net.js';

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false });

/** 应用状态。 */
const app = {
  mode: 'idle', // idle | solo | online
  side: null, // 'p1' | 'p2'
  net: null,
  interp: new Interpolator(),
  online: { score: { p1: 0, p2: 0 }, balls: [], paddles: { p1: 500, p2: 500 }, winner: null },
  localState: null,
  lastFrame: performance.now(),
  fps: 0,
  frames: 0,
  fpsTimer: 0,
  paused: false,
};

// ---------------------------------------------------------------------------
// 尺寸与坐标
// ---------------------------------------------------------------------------

/** 逻辑 → 屏幕的缩放与偏移。 */
const view = { scale: 1, offsetX: 0, offsetY: 0, w: 0, h: 0 };

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  // 用容器的实际可见尺寸，而不是 window.innerHeight ——
  // 手机浏览器地址栏会把 innerHeight 算错，导致底部被裁掉。
  const host = canvas.parentElement;
  const rect = host.getBoundingClientRect();
  const availW = Math.max(1, rect.width);
  const availH = Math.max(1, rect.height);

  const fieldW = E.FIELD.w;
  const fieldH = E.FIELD.h;

  // 等比缩放到「完整放得下」，绝不裁切
  let scale = Math.min(availW / fieldW, availH / fieldH);

  // 桌面/横屏上把球场撑到整屏高度会很「瘦长」，两侧留白过大。
  // 这里给个最大缩放，让球场在宽屏上占据一块舒服的中央区域，
  // 而不是一条细柱。手机上 scale 本来就小于这个值，不受影响。
  const maxScale = Math.min(availW, availH) < 600 ? Infinity : 0.95;
  scale = Math.min(scale, maxScale);

  view.scale = scale;
  view.w = fieldW * scale;
  view.h = fieldH * scale;
  view.offsetX = (availW - view.w) / 2;
  view.offsetY = (availH - view.h) / 2;

  canvas.width = Math.round(availW * dpr);
  canvas.height = Math.round(availH * dpr);
  canvas.style.width = `${availW}px`;
  canvas.style.height = `${availH}px`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** 屏幕坐标 → 逻辑 x。超出场地就钳住，不返回 NaN。 */
function screenToFieldX(clientX) {
  const rect = canvas.getBoundingClientRect();
  const local = clientX - rect.left - view.offsetX;
  const logical = local / view.scale;
  return Math.max(0, Math.min(E.FIELD.w, logical));
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function draw() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;

  // 背景
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);

  drawField();

  const frame = currentFrame();
  if (frame) {
    drawPaddles(frame.paddles);
    drawBalls(frame.balls);
  }

  ctx.restore();

  // 场地外的区域：竖版球场放在宽屏上必然两侧留白，
  // 与其空着，不如画成「看台」——让留白看起来是设计，不是没做好。
  drawStands(cssW, cssH);

  drawHud();
}

/** 球场外的看台装饰。只在有留白时出现，手机竖屏下几乎不可见。 */
function drawStands(cssW, cssH) {
  const left = view.offsetX;
  const right = cssW - view.offsetX - view.w;
  if (left < 12 && right < 12) return;

  for (const [x0, width] of [
    [0, left],
    [cssW - right, right],
  ]) {
    if (width < 12) continue;
    const g = ctx.createLinearGradient(x0, 0, x0 + width, 0);
    const fromLeft = x0 === 0;
    g.addColorStop(0, fromLeft ? 'rgba(94,234,212,0.05)' : 'rgba(244,114,182,0)');
    g.addColorStop(1, fromLeft ? 'rgba(94,234,212,0)' : 'rgba(244,114,182,0.05)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, view.offsetY, width, view.h);

    // 竖向细线，像看台的栏杆
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for (let x = x0 + 10; x < x0 + width; x += 22) {
      ctx.beginPath();
      ctx.moveTo(x, view.offsetY);
      ctx.lineTo(x, view.offsetY + view.h);
      ctx.stroke();
    }
  }

  // 球场外框，把「比赛区域」框出来
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.strokeRect(view.offsetX, view.offsetY, view.w, view.h);
}

/** 取当前要画的画面：联机用插值后的服务器状态，单机用本地模拟。 */
function currentFrame() {
  if (app.mode === 'online') {
    const s = app.interp.sample();
    if (!s) return null;
    return {
      balls: s.balls.map((b) => ({ x: b.x, y: b.y, r: E.BALL.r })),
      paddles: s.paddles,
    };
  }
  if (app.mode === 'solo' && app.localState) {
    return {
      balls: app.localState.balls.map((b) => ({ x: b.x, y: b.y, r: b.r })),
      paddles: { p1: app.localState.paddles.p1.x, p2: app.localState.paddles.p2.x },
    };
  }
  return null;
}

function drawField() {
  const { w, h } = E.FIELD;

  // 中线
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 3;
  ctx.setLineDash([18, 22]);
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // 两侧竖墙
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(3, 0);
  ctx.lineTo(3, h);
  ctx.moveTo(w - 3, 0);
  ctx.lineTo(w - 3, h);
  ctx.stroke();

  // 上下两条「球门线」——用颜色区分两个玩家的区域
  const grad1 = ctx.createLinearGradient(0, 0, 0, 120);
  grad1.addColorStop(0, 'rgba(94,234,212,0.30)');
  grad1.addColorStop(1, 'rgba(94,234,212,0)');
  ctx.fillStyle = grad1;
  ctx.fillRect(0, 0, w, 120);

  const grad2 = ctx.createLinearGradient(0, h, 0, h - 120);
  grad2.addColorStop(0, 'rgba(244,114,182,0.30)');
  grad2.addColorStop(1, 'rgba(244,114,182,0)');
  ctx.fillStyle = grad2;
  ctx.fillRect(0, h - 120, w, 120);
}

function drawPaddles(paddles) {
  const { w, h } = E.FIELD;
  const pw = E.PADDLE.w;
  const ph = E.PADDLE.h;

  const mineTop = app.mode === 'online' ? app.side === 'p1' : true;

  // P1 在上，P2 在下
  const p1Color = mineTop ? '#5eead4' : '#5eead4';
  const p2Color = '#f472b6';

  drawOnePaddle(paddles.p1, E.PADDLE.margin, p1Color, w, ph);
  drawOnePaddle(paddles.p2, h - E.PADDLE.margin - ph, p2Color, w, ph);

  function drawOnePaddle(cx, y, color, fieldW, height) {
    const x = Math.max(pw / 2, Math.min(fieldW - pw / 2, cx));
    const left = x - pw / 2;

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 22;
    ctx.fillStyle = color;
    roundRect(left, y, pw, height, height / 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawBalls(balls) {
  for (const b of balls) {
    const r = b.r ?? E.BALL.r;

    // 光晕
    const g = ctx.createRadialGradient(b.x, b.y, r * 0.2, b.x, b.y, r * 3.2);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r * 3.2, 0, Math.PI * 2);
    ctx.fill();

    // 实心球
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function roundRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** HUD：比分与状态。画在屏幕坐标系，不随场地缩放。 */
function drawHud() {
  const score = app.mode === 'online' ? app.online.score : app.localState?.score ?? { p1: 0, p2: 0 };
  const p1El = $('scoreP1');
  const p2El = $('scoreP2');
  if (p1El.textContent !== String(score.p1)) p1El.textContent = String(score.p1);
  if (p2El.textContent !== String(score.p2)) p2El.textContent = String(score.p2);
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function loop(now) {
  const dt = Math.min((now - app.lastFrame) / 1000, 0.1);
  app.lastFrame = now;

  if (app.mode === 'solo' && app.localState && !app.paused) {
    const inputs = buildLocalInputs();
    const events = E.step(app.localState, dt, inputs);
    if (events.length > 0) {
      audio.playEvents(events, app.localState);
      handleSoloEvents(events);
    }
  }

  draw();

  // FPS 统计（只在调试面板显示）
  app.frames += 1;
  app.fpsTimer += dt;
  if (app.fpsTimer >= 0.5) {
    app.fps = Math.round(app.frames / app.fpsTimer);
    app.frames = 0;
    app.fpsTimer = 0;
    const el = $('fps');
    if (el) el.textContent = `${app.fps} fps`;
  }

  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

/** 单机模式下两个玩家共用一个屏幕：左半屏控 P1，右半屏控 P2。 */
const pointer = { p1: null, p2: null };
/** 键盘状态，两个玩家各用一组键。 */
const keys = { p1: 0, p2: 0 };

const KEY_MAP = {
  // P1：A / D
  KeyA: ['p1', -1],
  KeyD: ['p1', 1],
  // P2：方向键
  ArrowLeft: ['p2', -1],
  ArrowRight: ['p2', 1],
};

function buildLocalInputs() {
  const inputs = {};

  if (pointer.p1 !== null) inputs.p1 = { targetX: pointer.p1 };
  else if (keys.p1 !== 0) inputs.p1 = { dir: keys.p1 };

  if (pointer.p2 !== null) inputs.p2 = { targetX: pointer.p2 };
  else if (keys.p2 !== 0) inputs.p2 = { dir: keys.p2 };

  return inputs;
}

function handleSoloEvents(events) {
  for (const ev of events) {
    if (ev.type === 'score') updateScoreboard();
    if (ev.type === 'win') {
      updateScoreboard();
      showBanner(`${ev.player === 'p1' ? 'P1' : 'P2'} 赢了！`, '点击重新开始');
    }
  }
}

/**
 * 单机双人：两人共用一块屏幕。
 * 关键改进（第一版是坏的）：上半屏和下半屏**各自独立跟随一根手指**。
 * 第一版只记一个"当前手指属于谁"，两人同时操作时会互相抢控制权 ——
 * 双人同屏游戏必须按 pointerId 分别记录，否则两个人一起动手就失控。
 */
const soloPointers = new Map(); // pointerId -> 'p1' | 'p2'

function zoneOf(clientY) {
  const rect = canvas.getBoundingClientRect();
  const logicalY = (clientY - rect.top - view.offsetY) / view.scale;
  return logicalY < E.FIELD.h / 2 ? 'p1' : 'p2';
}

/** 触屏/鼠标：单机按半屏分配，联机控自己那一侧。 */
function onPointerMove(e) {
  if (app.mode === 'idle') return;
  const x = screenToFieldX(e.clientX);

  if (app.mode === 'online') {
    app.net?.move(x);
    return;
  }

  if (app.mode === 'solo') {
    const zone = soloPointers.get(e.pointerId) ?? zoneOf(e.clientY);
    soloPointers.set(e.pointerId, zone);
    pointer[zone] = x;
  }
}

function onPointerDown(e) {
  audio.unlock();
  if (app.mode === 'idle') return;
  canvas.setPointerCapture?.(e.pointerId);
  soloPointers.set(e.pointerId, zoneOf(e.clientY));
  onPointerMove(e);
}

function onPointerUp(e) {
  if (app.mode !== 'solo') return;
  const zone = soloPointers.get(e.pointerId);
  soloPointers.delete(e.pointerId);
  if (zone) pointer[zone] = null;
}

function onKey(down) {
  return (e) => {
    const mapped = KEY_MAP[e.code];
    if (!mapped) return;
    e.preventDefault();
    if (down) audio.unlock();
    keys[mapped[0]] += down ? mapped[1] : -mapped[1];
    // 保证方向键不会累积成很大数值
    keys[mapped[0]] = Math.max(-1, Math.min(1, keys[mapped[0]]));
  };
}

window.addEventListener('keydown', onKey(true));
window.addEventListener('keyup', onKey(false));

// ---------------------------------------------------------------------------
// 联机
// ---------------------------------------------------------------------------

function connectNet() {
  if (app.net) return app.net;

  app.net = new Net({
    onMessage: handleNetMessage,
    onStatus: (status) => {
      const el = $('netStatus');
      if (!el) return;
      const map = {
        connecting: '连接中…',
        online: '已连接',
        offline: '已断开，重连中…',
      };
      el.textContent = map[status] ?? status;
      el.dataset.status = status;
    },
  });
  return app.net;
}

function handleNetMessage(msg) {
  switch (msg.type) {
    case 'joined': {
      app.side = msg.side;
      $('roomCode').textContent = msg.room;
      $('roomPanel').hidden = true;
      $('waitPanel').hidden = false;
      $('waitText').textContent = msg.side === 'p1' ? '等待对手加入…把房号告诉对方' : '已加入，等待开始…';
      break;
    }
    case 'players': {
      if (msg.count >= 2) $('waitText').textContent = '对手已就位';
      break;
    }
    case 'start': {
      app.mode = 'online';
      app.online.score = { p1: 0, p2: 0 };
      app.online.winner = null;
      app.interp = new Interpolator();
      $('waitPanel').hidden = true;
      $('roomPanel').hidden = true;
      $('gameoverPanel').hidden = true;
      showBanner('', '');
      updateScoreboard();
      break;
    }
    case 'state': {
      app.online.score = msg.score ?? app.online.score;
      app.online.paddles = msg.paddles ?? app.online.paddles;
      app.online.winner = msg.winner ?? null;
      app.interp.push({
        balls: msg.balls ?? [],
        paddles: msg.paddles ?? app.online.paddles,
      });

      if (msg.events?.length) {
        // 联机时音效由服务器事件驱动，两边听到的是同一时刻
        for (const ev of msg.events) {
          if (ev.type === 'paddle') audio.playPaddle({ x: 0.5, speedRatio: 0.4 });
          else if (ev.type === 'wall') audio.playWall();
          else if (ev.type === 'score') audio.playScore();
          else if (ev.type === 'split') audio.playSplit();
        }
      }
      updateScoreboard();
      break;
    }
    case 'gameover': {
      app.online.winner = msg.winner;
      audio.playWin();
      showBanner(`${msg.winner === 'p1' ? 'P1' : 'P2'} 赢了！`, '等待双方请求再来一局');
      $('gameoverPanel').hidden = false;
      break;
    }
    case 'peer-left': {
      showBanner('对手断开了', '可以等他回来，或返回大厅');
      break;
    }
    case 'rematch-waiting': {
      $('rematchHint').textContent = `已有 ${msg.count} 人准备，等对手…`;
      break;
    }
    case 'error': {
      showToast(msg.message);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function updateScoreboard() {
  const score = app.mode === 'online' ? app.online.score : app.localState?.score ?? { p1: 0, p2: 0 };
  $('scoreP1').textContent = String(score.p1);
  $('scoreP2').textContent = String(score.p2);
}

let bannerTimer = null;
function showBanner(title, sub) {
  const el = $('banner');
  if (!title) {
    el.hidden = true;
    return;
  }
  $('bannerTitle').textContent = title;
  $('bannerSub').textContent = sub;
  el.hidden = false;
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

let toastTimer = null;
function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

function startSolo() {
  audio.unlock();
  app.mode = 'solo';
  app.localState = E.createState({ firstTo: 11 });
  app.paused = false;
  pointer.p1 = null;
  pointer.p2 = null;
  $('lobby').hidden = true;
  $('roomPanel').hidden = true;
  $('waitPanel').hidden = true;
  $('gameoverPanel').hidden = true;
  $('hud').hidden = false;
  updateScoreboard();
  resize();
  showBanner('单机双人', '上半屏控 P1（青色，A/D），下半屏控 P2（粉色，← →）');
}

function startOnline() {
  audio.unlock();
  connectNet();
  $('lobby').hidden = true;
  $('roomPanel').hidden = false;
  resize();
}

function backToLobby() {
  app.mode = 'idle';
  app.net?.close();
  app.net = null;
  app.localState = null;
  app.side = null;
  $('lobby').hidden = false;
  $('roomPanel').hidden = true;
  $('waitPanel').hidden = true;
  $('gameoverPanel').hidden = true;
  $('hud').hidden = true;
  showBanner('', '');
  resize();
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/** 生成 4 位随机房号。Workers 版用它作为 Durable Object 的名字。 */
function randomRoomCode() {
  // 1000–9999，避免以 0 开头造成的认知负担
  return String(1000 + Math.floor(Math.random() * 9000));
}

function bindUi() {
  $('btnSolo').addEventListener('click', startSolo);
  $('btnOnline').addEventListener('click', startOnline);
  $('btnCreate').addEventListener('click', () => {
    const net = connectNet();
    // 关键：先把房号定下来再连。
    // Workers 版靠 URL 里的房号路由到不同的 Durable Object，
    // 不带房号会直接被服务端拒绝（400）。Node 版忽略路径里的房号，
    // 仍然走 create 指令，所以两种后端同一份代码都能用。
    const code = randomRoomCode();
    net.connect(code);
    net.create();
  });
  $('btnJoin').addEventListener('click', () => {
    const code = $('roomInput').value.replace(/\D/g, '').slice(0, 4);
    if (code.length !== 4) {
      showToast('请填 4 位数字房号');
      return;
    }
    const net = connectNet();
    net.connect(code);
    net.join(code);
  });
  $('btnBack').addEventListener('click', backToLobby);
  $('btnBack2').addEventListener('click', backToLobby);
  // btnBack3 在 HTML 上带 onclick=reload()，这里不再重复绑定，避免两套行为打架
  $('btnRematch').addEventListener('click', () => {
    app.net?.rematch();
    $('rematchHint').textContent = '已请求，等对手确认…';
  });
  $('btnSound').addEventListener('click', () => {
    audio.unlock();
    const muted = audio.setMuted(!audio.isMuted());
    $('btnSound').textContent = muted ? '🔇' : '🔊';
    $('btnSound').setAttribute('aria-label', muted ? '取消静音' : '静音');
  });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', (e) => {
    // 触屏只在按下后才跟随，避免悬停误触；鼠标则实时跟随
    if (e.pointerType === 'mouse' || e.buttons > 0) onPointerMove(e);
  });
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 切到后台时暂停本地模拟，回来时重置时间基准 ——
  // 不重置的话，回来后 dt 是几十秒，球会直接飞出场地
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      app.paused = true;
    } else {
      app.paused = false;
      app.lastFrame = performance.now();
    }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));

  // 手机上禁止双指缩放页面，否则游戏时会被放大
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resize);
  }
}

bindUi();
resize();
requestAnimationFrame(loop);

// 首次交互即解锁音频（移动端硬性要求）
['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
  window.addEventListener(evt, () => audio.unlock(), { once: true });
});
