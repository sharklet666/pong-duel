/**
 * 双人乒乓球 · 共享物理引擎
 *
 * 这份文件同时被浏览器和 Node 服务器加载，是有意为之：
 * 服务器用它跑权威模拟，客户端用它做本地预测/补帧。
 * 两边跑同一份代码，才不会出现「我这边看着接住了、服务器说没接住」。
 *
 * 因此这里**不允许**出现任何 DOM、Canvas、window、音频调用。
 * 纯函数 + 纯数据，可以直接在 node 里单测。
 *
 * 场地约定（关键，别搞反）：
 *   - 球撞**左右**墙 → 反弹
 *   - 球撞**上下**边缘 → 对方得分
 *   - 因此球拍是**横向**的：P1 守上边，P2 守下边
 */

/** 逻辑坐标系。渲染时按容器等比缩放，不参与物理计算。 */
export const FIELD = Object.freeze({
  w: 1000,
  h: 1500,
});

/** 球拍参数。 */
export const PADDLE = Object.freeze({
  w: 190,
  h: 24,
  margin: 74, // 拍子距各自底边的距离
  speed: 1900, // 键盘移动的最大速度（单位/秒）
  followRate: 18, // 触屏绝对定位时的跟随强度（越大越跟手）
});

/** 球参数。 */
export const BALL = Object.freeze({
  r: 15,
  speed0: 640, // 初速
  speedMax: 1560, // 加速上限
  speedGain: 1.045, // 每次被拍中加速
  maxAngle: Math.PI / 3.1, // 最大出射角（相对竖直方向）
});

/** 特殊机制触发条件。 */
export const MECHANICS = Object.freeze({
  splitAtRally: 8, // 连续对拉多少拍后分裂
  maxBalls: 3,
});

/** 一分结束后，球飞向「刚失分的一方」——给他一次接球机会。 */
const SERVE_ANGLE = 0.34; // 弧度，稍微斜向出球避免死板

export const SIDE = Object.freeze({ top: 'top', bottom: 'bottom' });

/** 打出这一拍的玩家 → 他守哪边。 */
export const PLAYER_SIDE = Object.freeze({ p1: SIDE.top, p2: SIDE.bottom });

/**
 * 创建一局新游戏。
 * @param {{width?: number, height?: number, firstTo?: number}} opts
 */
export function createState(opts = {}) {
  const width = opts.width ?? FIELD.w;
  const height = opts.height ?? FIELD.h;
  const firstTo = opts.firstTo ?? 11;

  const state = {
    width,
    height,
    firstTo,
    score: { p1: 0, p2: 0 },
    winner: null,
    paused: false,
    rally: 0,
    speed: BALL.speed0,
    balls: [],
    paddles: {
      p1: { x: width / 2, y: PADDLE.margin, w: PADDLE.w, h: PADDLE.h },
      p2: { x: width / 2, y: height - PADDLE.margin - PADDLE.h, w: PADDLE.w, h: PADDLE.h },
    },
    // 服务方：失分的人接发球
    serveTo: SIDE.top,
    elapsed: 0,
    events: [],
  };

  serve(state);
  return state;
}

/** 把一个球放到中心，朝 serveTo 那一侧飞。 */
function spawnBall(state) {
  const dir = state.serveTo === SIDE.top ? -1 : 1; // 朝 top 飞 = vy 负
  const jitter = (Math.random() - 0.5) * 2 * SERVE_ANGLE;
  return {
    x: state.width / 2,
    y: state.height / 2,
    vx: Math.sin(jitter) * state.speed,
    vy: dir * Math.cos(jitter) * state.speed,
    r: BALL.r,
    trail: [],
  };
}

/** 重新发球。 */
export function serve(state) {
  state.balls = [spawnBall(state)];
  state.rally = 0;
  state.speed = BALL.speed0;
}

/**
 * 推进一帧。
 *
 * 内部用固定小步长切分，避免球速高时穿过球拍（tunneling）。
 * 这是这类游戏最典型的 bug：60fps 下球一帧走 26 单位，比拍子厚度还大。
 *
 * @param {object} state 会被原地修改
 * @param {number} dt 距上一帧的秒数
 * @param {{p1?: object, p2?: object}} inputs 玩家输入
 * @returns {object} 本帧产生的事件（供音效、特效使用）
 */
export function step(state, dt, inputs = {}) {
  const events = [];
  if (state.winner || state.paused) {
    state.events = events;
    return events;
  }

  // 夹住异常 dt（切后台回来时会给出巨大的值，会直接把球打飞）
  const clamped = Math.min(Math.max(dt, 0), 0.1);

  movePaddles(state, clamped, inputs);

  const steps = Math.max(1, Math.ceil(clamped / (1 / 240)));
  const h = clamped / steps;
  for (let i = 0; i < steps; i += 1) {
    advanceBalls(state, h, events);
    if (state.winner) break;
    // 分裂必须放在「遍历球」之后统一处理。
    // 在遍历途中改 state.balls，会被循环结束时的 survivors 赋值覆盖掉 ——
    // 那会让分裂机制静默失效（这个 bug 真的出现过）。
    if (state.pendingSplit) {
      state.pendingSplit = false;
      splitBalls(state, events);
    }
  }

  state.elapsed += clamped;
  state.events = events;
  return events;
}

/** 球拍跟随输入。绝对坐标用于触屏，方向键用于键盘。 */
function movePaddles(state, dt, inputs) {
  for (const key of ['p1', 'p2']) {
    const paddle = state.paddles[key];
    const input = inputs?.[key];
    const half = paddle.w / 2;
    const minX = half;
    const maxX = state.width - half;

    if (!input) continue;

    if (typeof input.targetX === 'number' && Number.isFinite(input.targetX)) {
      // 触屏：朝手指位置平滑靠近，但仍然受最大速度限制，防止瞬移
      const delta = input.targetX - paddle.x;
      const want = delta * Math.min(1, PADDLE.followRate * dt);
      const maxStep = PADDLE.speed * dt;
      const applied = Math.max(-maxStep, Math.min(maxStep, want));
      paddle.x += applied;
    } else if (typeof input.dir === 'number' && input.dir !== 0) {
      paddle.x += Math.max(-1, Math.min(1, input.dir)) * PADDLE.speed * dt;
    }

    paddle.x = Math.min(maxX, Math.max(minX, paddle.x));
  }
}

/** 推进所有球一个子步。 */
function advanceBalls(state, dt, events) {
  const survivors = [];

  for (const ball of state.balls) {
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // --- 左右墙：反弹 ---
    if (ball.x - ball.r < 0) {
      ball.x = ball.r;
      ball.vx = Math.abs(ball.vx);
      events.push({ type: 'wall', x: ball.x, y: ball.y });
    } else if (ball.x + ball.r > state.width) {
      ball.x = state.width - ball.r;
      ball.vx = -Math.abs(ball.vx);
      events.push({ type: 'wall', x: ball.x, y: ball.y });
    }

    // --- 与球拍碰撞 ---
    hitPaddle(state, ball, SIDE.top, events);
    hitPaddle(state, ball, SIDE.bottom, events);

    // --- 上下边缘：对方得分 ---
    const topOut = ball.y + ball.r < 0;
    const bottomOut = ball.y - ball.r > state.height;
    if (topOut || bottomOut) {
      // 上边缘 = P1 守的门 → P2 得分
      const scorer = topOut ? 'p2' : 'p1';
      awardPoint(state, scorer, events);
      return; // 一分结束，剩余球清空
    }

    if (!state.winner) survivors.push(ball);
  }

  if (!state.winner) state.balls = survivors;
}

/** 球拍碰撞检测与反弹。 */
function hitPaddle(state, ball, side, events) {
  const key = side === SIDE.top ? 'p1' : 'p2';
  const paddle = state.paddles[key];
  const top = paddle.y;
  const bottom = paddle.y + paddle.h;

  const withinX = Math.abs(ball.x - paddle.x) <= paddle.w / 2 + ball.r;
  if (!withinX) return;

  if (side === SIDE.top) {
    // P1 守上边：球向上飞、穿过拍子上沿
    if (ball.vy < 0 && ball.y - ball.r <= bottom && ball.y - ball.r >= top - ball.r) {
      bounceOffPaddle(state, ball, paddle, 'p1', events);
      ball.y = bottom + ball.r;
    }
  } else {
    // P2 守下边：球向下飞
    if (ball.vy > 0 && ball.y + ball.r >= top && ball.y + ball.r <= bottom + ball.r) {
      bounceOffPaddle(state, ball, paddle, 'p2', events);
      ball.y = top - ball.r;
    }
  }
}

/** 反弹并计算出射角：击球点越靠边，角度越斜。 */
function bounceOffPaddle(state, ball, paddle, player, events) {
  const offset = clamp((ball.x - paddle.x) / (paddle.w / 2), -1, 1);
  const angle = offset * BALL.maxAngle;

  // 每次被拍中加速，但有上限——否则几拍之后就没法接了
  state.speed = Math.min(state.speed * BALL.speedGain, BALL.speedMax);

  const towardTop = player === 'p2'; // P2 打回去是朝上
  ball.vy = (towardTop ? -1 : 1) * Math.cos(angle) * state.speed;
  ball.vx = Math.sin(angle) * state.speed;

  state.rally += 1;
  events.push({ type: 'paddle', player, x: ball.x, y: ball.y, speed: state.speed, rally: state.rally });

  maybeSplit(state, events);
}

/** 连续对拉达到阈值时分裂。只做标记，真正分裂留到一帧的球遍历结束后。 */
function maybeSplit(state, events) {
  if (state.rally > 0 && state.rally % MECHANICS.splitAtRally === 0) {
    if (state.balls.length < MECHANICS.maxBalls) {
      state.pendingSplit = true;
      events.push({ type: 'split-pending', rally: state.rally });
    }
  }
}

/** 把一个球拆成两个，速度方向左右分开。 */
export function splitBalls(state, events = []) {
  const source = state.balls.find((b) => b.vy !== 0) ?? state.balls[0];
  if (!source) return;

  const created = [];
  for (let i = 0; i < state.balls.length; i += 1) {
    const b = state.balls[i];
    if (b !== source) {
      created.push(b);
      continue;
    }
    for (const sign of [-1, 1]) {
      const spread = 0.42;
      const speed = Math.hypot(b.vx, b.vy);
      // 以原方向为轴，向左右各偏一点
      const baseAngle = Math.atan2(b.vy, b.vx);
      const a = baseAngle + sign * spread;
      created.push({
        x: b.x,
        y: b.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        r: b.r,
        trail: [],
      });
    }
  }

  state.balls = created.slice(0, MECHANICS.maxBalls);
  events.push({ type: 'split', x: source.x, y: source.y, count: state.balls.length });
}

/** 记分，并在达到赛点时结束。 */
function awardPoint(state, scorer, events) {
  state.score[scorer] += 1;
  state.balls = [];
  events.push({ type: 'score', player: scorer, score: { ...state.score } });

  if (state.score[scorer] >= state.firstTo) {
    state.winner = scorer;
    events.push({ type: 'win', player: scorer });
    return;
  }

  // 下一球发给刚失分的人
  state.serveTo = scorer === 'p1' ? SIDE.bottom : SIDE.top;
  state.speed = BALL.speed0;
  state.rally = 0;

  const ball = spawnBall(state);
  ball.y = state.height / 2;
  state.balls = [ball];
}

/**
 * 把命中信息里的坐标换算成音高用参数（0..1）。
 * 放在引擎里而不是音频层，是为了让离线测试也能覆盖。
 */
export function pitchFromX(state, x) {
  return clamp(x / state.width, 0, 1);
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
