/**
 * 双人乒乓球 · Cloudflare Workers 版
 *
 * 为什么要有这个版本（而不是继续用 server.mjs）：
 *   Render 免费套餐要绑卡，Zeabur 年底关停，Koyeb 免费层没了，
 *   ngrok / HuggingFace 在这台机器上都连不上。
 *   目前唯一「不需要信用卡 + 地址永久 + 支持 WebSocket」的组合，
 *   就是 Cloudflare Workers Free + Durable Objects。
 *
 * 关键事实（来自 Cloudflare 官方定价页，2026-10 查证）：
 *   - Workers Free 支持 Durable Objects（仅 SQLite 后端）
 *   - Free 额度：10 万请求/天、13000 GB-s/天
 *   - **WebSocket 的协议层 ping/pong 不计费**，入站消息按 20:1 折算
 *   - 用 Hibernation API 时，空闲期间不产生 duration 计费
 *
 * 多房间设计：
 *   房号直接当作 Durable Object 的名字（idFromName），
 *   所以两对朋友可以同时玩，互不干扰。
 *   前端已经改成连 /ws/<房号>。
 *
 * 物理引擎复用 js/engine.js —— 与 Node 版同一份代码，
 * 保证「本机测过的行为」和「线上跑的行为」一致。
 */

import { createState, step, FIELD } from '../js/engine.js';

const TICK_MS = 1000 / 30;

/** 房号校验：4 位数字，与前端输入框一致。 */
function normalizeRoom(code) {
  const digits = String(code ?? '').replace(/\D/g, '').slice(0, 4);
  return digits.length === 4 ? digits : null;
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map(); // ws -> { side }
    this.game = createState({ width: FIELD.w, height: FIELD.h });
    this.inputs = {};
    this.loop = null;
    this.pendingRematch = new Set();

    // 只持久化比分这种低频数据。
    // 球位置是连续量，每 tick 写存储会烧光免费额度（10 万写/天），
    // 唤醒后重发一球即可，玩家不会察觉。
    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get('score');
      if (saved) this.game.score = saved;
    });
  }

  sideOf(ws) {
    return this.clients.get(ws)?.side;
  }

  assignSide() {
    const used = new Set([...this.clients.values()].map((c) => c.side));
    if (!used.has('p1')) return 'p1';
    if (!used.has('p2')) return 'p2';
    return null;
  }

  send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* 连接已死，交给 close 处理 */
    }
  }

  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const ws of this.clients.keys()) {
      try {
        ws.send(text);
      } catch {
        /* ignore */
      }
    }
  }

  sendState(withEvents = false) {
    const g = this.game;
    const base = {
      type: 'state',
      score: g.score,
      balls: g.balls.map((b) => [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10]),
      paddles: {
        p1: Math.round(g.paddles.p1.x * 10) / 10,
        p2: Math.round(g.paddles.p2.x * 10) / 10,
      },
      rally: g.rally,
      speed: Math.round(g.speed),
      winner: g.winner,
    };
    if (withEvents) {
      base.events = g.events.map((e) => (e.type === 'score' ? { type: 'score', player: e.player } : { type: e.type }));
    }
    this.broadcast(base);
  }

  startLoop() {
    if (this.loop) return;
    this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  stopLoop() {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
  }

  tick() {
    // 没人就停表：Workers 按 duration 计费，空转是在烧免费额度。
    if (this.clients.size === 0) {
      this.stopLoop();
      return;
    }

    const events = step(this.game, TICK_MS / 1000, this.inputs);
    this.sendState(events.length > 0);

    if (this.game.winner) {
      this.stopLoop();
      this.broadcast({ type: 'gameover', winner: this.game.winner, score: this.game.score });
      this.persistScore();
    }
  }

  async persistScore() {
    try {
      await this.state.storage.put('score', this.game.score);
    } catch {
      /* 存储失败不该影响对局 */
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 从 URL 里取出房号（由 Worker 入口路由进来时带上）。
    // 前端要在「等待对手」面板里显示它，所以得让对象知道自己的名字。
    const codeMatch = url.pathname.match(/^\/ws\/([^/]+)/);
    if (codeMatch) this.roomCode = normalizeRoom(codeMatch[1]) ?? this.roomCode;

    if (url.pathname.endsWith('/healthz')) {
      return Response.json({ ok: true, players: this.clients.size });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    if (this.clients.size >= 2) {
      return new Response('room full', { status: 409 });
    }

    const side = this.assignSide();
    if (!side) {
      return new Response('room full', { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API：空闲时对象可休眠，醒来仍持有连接，且不产生 duration 计费。
    this.state.acceptWebSocket(server);
    this.clients.set(server, { side });

    this.send(server, { type: 'hello', side, tickHz: 30 });
    this.send(server, {
      type: 'welcome',
      side,
      field: { w: FIELD.w, h: FIELD.h },
    });
    // 前端靠 joined 关闭「建房/加入」面板并显示房号。
    // Node 版由 create/join 指令触发，这里直接发，让前端同一套 UI 可用。
    this.send(server, { type: 'joined', room: this.roomCode ?? '----', side });

    this.broadcast({ type: 'players', count: this.clients.size });

    if (this.clients.size === 2) {
      // 人齐了，开新局
      this.game = createState({ width: FIELD.w, height: FIELD.h });
      this.inputs = {};
      this.pendingRematch.clear();
      this.broadcast({ type: 'start', field: { w: FIELD.w, h: FIELD.h } });
      this.sendState();
      this.startLoop();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const side = this.sideOf(ws);
    if (!side) return;

    switch (msg.type) {
      case 'move': {
        const x = Number(msg.x);
        if (Number.isFinite(x)) this.inputs[side] = { targetX: x };
        break;
      }
      case 'rematch': {
        this.pendingRematch.add(side);
        this.broadcast({ type: 'rematch-waiting', count: this.pendingRematch.size });
        if (this.pendingRematch.size >= 2) {
          this.pendingRematch.clear();
          this.game = createState({ width: FIELD.w, height: FIELD.h });
          this.inputs = {};
          this.broadcast({ type: 'start', field: { w: FIELD.w, h: FIELD.h } });
          this.sendState();
          this.startLoop();
        }
        break;
      }
      case 'create':
      case 'join':
        // 房号由 URL 决定，这两个指令在 Workers 版是空操作。
        // 保留分支是为了让前端同一份代码在两种后端上都能跑。
        break;
      default:
        break;
    }
  }

  async webSocketClose(ws) {
    const side = this.sideOf(ws);
    this.clients.delete(ws);
    this.broadcast({ type: 'players', count: this.clients.size });
    if (this.clients.size === 0) {
      this.stopLoop();
      await this.persistScore();
    } else if (side) {
      this.broadcast({ type: 'peer-left', side });
    }
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }
}

/** Worker 入口。 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /ws/<房号> 路由到对应的房间对象
    const m = url.pathname.match(/^\/ws(?:\/([^/]+))?$/);
    if (m) {
      const room = normalizeRoom(m[1]);
      if (!room) {
        return Response.json(
          { error: '房号必须是 4 位数字，例如 /ws/1234' },
          { status: 400 },
        );
      }
      const id = env.ROOMS.idFromName(`room-${room}`);
      return env.ROOMS.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
