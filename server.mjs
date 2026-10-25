/**
 * 双人联机服务器。
 *
 * 设计要点（为什么不是"两台手机各自跑一份物理"）：
 *   - 两台手机若各跑一份模拟，球的位置会越差越远，看起来像两个游戏
 *   - 所以：服务器跑**权威**模拟，按 30Hz 广播比分与球的位置
 *   - 客户端只负责画和发「我的拍子在哪」，不负责决定输赢
 *
 * 但同时保留一个重要的降级：
 *   客户端也跑引擎，但**只用于球拍手感和插值**；一旦收到服务器状态就以服务器为准。
 *
 * 传输用 WebSocket。房间用 4 位数字码，两人各输一次即可配对。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createState, step, FIELD } from './js/engine.js';

/**
 * 项目根目录 = server.mjs 所在的目录。
 *
 * 踩过的坑：`new URL('..', import.meta.url)` 指向的是**父目录**，
 * 而且它转出来的路径自带结尾分隔符，拼 `ROOT + sep` 会变成 `\\`，
 * 让 startsWith 恒为 false —— 那样整站每个文件都会 403。
 * 这里两个问题一起避开：用 '.'，并去掉结尾分隔符。
 */
const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 服务器模拟频率。30Hz 足够，再高会白白耗流量。 */
const TICK_HZ = 30;

// -------------------------------------------------------------------------
// WebSocket 最小实现（RFC 6455 子集）
//
// 不引第三方库：这个项目只需要「文本帧 + ping/pong + close」，
// 引一个 ws 依赖会让部署多一步 npm install。
// -------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 解析 WebSocket 握手请求，成功返回 101 head + 帧读取器。 */
function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  return socket;
}

/** 编码一个服务端 → 客户端的文本帧（不做掩码）。 */
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  return encodeFrame(0x1, payload);
}

/**
 * 编码任意帧。
 * @param {number} opcode 0x1 文本 / 0x8 关闭 / 0x9 ping / 0xA pong
 * @param {Buffer|string} data
 */
function encodeFrame(opcode, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * 给 upgrade 得到的 socket 挂上「连接真的结束了」的清理钩子。
 *
 * 这是整个服务器最容易踩的坑，实测确认过：
 *   `http.Server` 的 `upgrade` 事件交出来的 socket **不会**触发 `close` 事件
 *   （它没有被 http 模块托管生命周期），客户端断开时只触发 `end`。
 *   只监听 `close` 的话，客户端走了服务器永远不知道 ——
 *   房间里挂着一个幽灵玩家，房间也永远不回收。
 *
 * 所以这里同时监听 end / close / error，并用 flag 保证只清理一次。
 *
 * @param {import('node:net').Socket} socket
 * @param {() => void} cleanup
 * @returns {() => void} 用于在正常关闭时主动调用
 */
function onSocketGone(socket, cleanup) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    try {
      cleanup();
    } catch {
      /* 清理失败不该拖垮进程 */
    }
  };

  socket.on('end', once); // 客户端半关闭：http upgrade socket 上最常见
  socket.on('close', once); // 完整关闭
  socket.on('error', once); // 写失败等

  return once;
}

/**
 * 增量解析客户端帧。
 * 关键：TCP 不保证一条消息一个 chunk —— 半个帧、两个帧粘一起都是常态。
 * 不做这个缓冲，联机就会随机丢输入。
 *
 * @param onMessage 文本帧回调
 * @param onClose 关闭帧回调
 * @param onControl 控制帧回调 (opcode, payload)：ping/pong 靠它处理
 */
function createFrameReader(onMessage, onClose, onControl) {
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const first = buffer[0];
      const opcode = first & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return; // 帧还没收全

      let payload = buffer.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload); // 不要改动原 buffer
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }

      buffer = buffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        onClose();
        return;
      }
      // RFC 6455：收到 ping 必须回 pong，否则对端会认为连接已死。
      // 云平台的代理（Render/Railway/Cloudflare）靠这个判断连接活性，
      // 不回 pong 会导致连接被中途掐断。
      if (opcode === 0x9) {
        onControl?.(0xa, payload);
        continue;
      }
      if (opcode === 0xa) {
        onControl?.(0xa, null); // pong 收到，刷新活跃时间
        continue;
      }
      if (opcode === 0x1) {
        try {
          onMessage(JSON.parse(payload.toString('utf8')));
        } catch {
          /* 坏包丢弃，不要因为一个坏帧断开连接 */
        }
      }
    }
  };
}

// -------------------------------------------------------------------------
// 房间
// -------------------------------------------------------------------------

let nextRoomId = 1000;
/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  constructor(code) {
    this.code = code;
    this.state = createState({ width: FIELD.w, height: FIELD.h });
    this.clients = new Map(); // socket -> { side }
    this.timer = null; // 物理 tick（两人都在场时才跑）
    this.reaper = null; // 空房间回收巡查（独立于 tick）
    this.last = Date.now();
    this.rematchRequested = new Set();
    this.startReaper();
  }

  get size() {
    return this.clients.size;
  }

  /** 分配一个还没被占的方位。 */
  assignSide() {
    const used = new Set([...this.clients.values()].map((c) => c.side));
    if (!used.has('p1')) return 'p1';
    if (!used.has('p2')) return 'p2';
    return null; // 满了
  }

  /** 满员判定：两人都在场时，第三个人不能进来。 */
  isFull() {
    return this.clients.size >= 2;
  }

  join(socket, side) {
    this.clients.set(socket, { side });
    this.send(socket, { type: 'welcome', side, room: this.code, field: { w: this.state.width, h: this.state.height } });
    this.broadcast({ type: 'players', count: this.clients.size });
    this.sendState();
    if (this.clients.size === 2) this.start();
  }

  /**
   * 空房间巡查。
   *
   * 为什么不能只靠 tick() 里的检查：
   * 物理 tick 只在**两个人都在场**时才启动（见 start()），
   * 所以「单人建了房、然后走掉」这种最常见的场景下 tick 根本没在跑，
   * 空房间就永远不会被回收 —— 云平台上连续跑几天，房间会越积越多。
   * 这里单独起一个低频巡查，专门管回收。
   */
  startReaper() {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      if (this.clients.size === 0) this.destroy();
    }, 1000);
  }

  leave(socket) {
    const entry = this.clients.get(socket);
    this.clients.delete(socket);
    if (entry) this.broadcast({ type: 'players', count: this.clients.size });
    if (this.clients.size === 0) this.destroy();
    else this.broadcast({ type: 'peer-left', side: entry?.side });
  }

  start() {
    if (this.timer) return;
    this.state = createState({ width: FIELD.w, height: FIELD.h });
    this.last = Date.now();
    this.broadcast({ type: 'start', field: { w: this.state.width, h: this.state.height } });
    this.timer = setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  tick() {
    // 空房间不空转：云平台上进程要跑很久，没人的房间必须停表。
    if (this.clients.size === 0) {
      this.destroy();
      return;
    }

    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.last = now;

    // 注意：不能每帧清空输入。
    // 客户端只是「报告我的拍子在哪」，不是「推一把」——
    // 每帧清空会让拍子每帧只动一步，玩家手感是「滑的」。
    // 所以这里保留最后已知位置，直到客户端发新的。
    const events = step(this.state, dt, this.inputs);

    if (events.length > 0) this.sendState(true);
    else this.sendState(false);

    // 比赛结束 → 停表，等两人都请求再来一局
    if (this.state.winner) {
      clearInterval(this.timer);
      this.timer = null;
      this.broadcast({ type: 'gameover', winner: this.state.winner, score: this.state.score });
    }
  }

  /** 只把该客户端需要的数据发出去。 */
  sendState(withEvents = false) {
    const s = this.state;
    const base = {
      type: 'state',
      score: s.score,
      balls: s.balls.map((b) => [round(b.x), round(b.y)]),
      rally: s.rally,
      speed: round(s.speed),
      winner: s.winner,
    };
    if (withEvents) base.events = s.events.map((e) => (e.type === 'score' ? { type: 'score', player: e.player } : { type: e.type }));

    for (const [socket] of this.clients) {
      // 每个客户端要看到「自己的拍子」和「对手的拍子」，用 side 标注
      this.send(socket, { ...base, paddles: { p1: round(s.paddles.p1.x), p2: round(s.paddles.p2.x) } });
    }
  }

  send(socket, payload) {
    if (socket.destroyed) return;
    try {
      socket.write(encodeTextFrame(JSON.stringify(payload)));
    } catch {
      /* 写失败当作断开处理 */
    }
  }

  broadcast(payload) {
    for (const [socket] of this.clients) this.send(socket, payload);
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    rooms.delete(this.code);
  }
}

function round(v) {
  return Math.round(v * 10) / 10;
}

/** 分配房间号；传入 preferred 时优先用它（「加入指定房间号」必须真的用那个号）。 */
function createRoom(preferred) {
  let code = preferred;
  if (code !== undefined) {
    // 调用方已经保证这个号不存在
    const room = new Room(code);
    rooms.set(code, room);
    return room;
  }
  do {
    nextRoomId = nextRoomId >= 9999 ? 1000 : nextRoomId + 1;
    code = String(nextRoomId);
  } while (rooms.has(code));
  const room = new Room(code);
  rooms.set(code, room);
  return room;
}

// -------------------------------------------------------------------------
// HTTP + WebSocket 合体服务
// -------------------------------------------------------------------------

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(ROOT, rel));
  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

export function startServer({ port = 0, host = '0.0.0.0' } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
        return;
      }
      await serveStatic(res, url.pathname);
    } catch (err) {
      res.writeHead(500).end(String(err?.message ?? err));
    }
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    const ws = acceptWebSocket(req, socket);
    if (!ws) return;

    let room = null;
    let side = null;

    let aliveAt = Date.now();

    // 心跳句柄提前声明并给出停止函数，
    // 这样下面的所有回调都能安全引用，不依赖「声明先于回调触发」这种脆弱时序。
    let heartbeat = null;
    const stopHeartbeat = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const send = (payload) => {
      if (socket.destroyed) return;
      try {
        socket.write(encodeTextFrame(JSON.stringify(payload)));
      } catch {
        /* ignore */
      }
    };

    const joinRoom = (code) => {
      if (room) room.leave(socket);
      let target = rooms.get(code);
      // 「加入房间号」必须真的用这个号。之前这里写成了 createRoom()，
      // 结果输错一位就会拿到一个**全新**的房间，两个人永远碰不上。
      if (!target) target = createRoom(code);
      if (target.isFull()) {
        send({ type: 'error', message: '房间满了（已有两人）。' });
        if (target.clients.size === 0) target.destroy();
        return;
      }
      const assigned = target.assignSide();
      if (!assigned) {
        send({ type: 'error', message: '房间满了（已有两人）。' });
        return;
      }
      room = target;
      side = assigned;
      room.join(socket, assigned);
      send({ type: 'joined', room: room.code, side: assigned });
    };

    const reader = createFrameReader(
      (msg) => {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'create': {
            const created = createRoom();
            joinRoom(created.code);
            break;
          }
          case 'join': {
            const code = String(msg.room ?? '').replace(/\D/g, '').slice(0, 4);
            if (code.length !== 4) {
              send({ type: 'error', message: '房间号必须是 4 位数字。' });
              break;
            }
            joinRoom(code);
            break;
          }
          case 'move': {
            if (!room || !side) break;
            const x = Number(msg.x);
            if (!Number.isFinite(x)) break;
            room.inputs = room.inputs ?? {};
            room.inputs[side] = { targetX: x };
            break;
          }
          case 'rematch': {
            if (!room) break;
            room.rematchRequested.add(side);
            room.broadcast({ type: 'rematch-waiting', count: room.rematchRequested.size });
            if (room.rematchRequested.size >= 2) {
              room.rematchRequested.clear();
              room.start();
            }
            break;
          }
          default:
            break;
        }
      },
      () => {
        // 收到关闭帧：客户端主动告别
        if (room) room.leave(socket);
        stopHeartbeat();
        socket.destroy();
      },
      (opcode, payload) => {
        // 收到 ping 就回 pong（保持连接活性）；收到 pong 只刷新时间戳
        aliveAt = Date.now();
        if (opcode === 0xa && payload && payload.length <= 125) {
          if (!socket.destroyed) {
            try {
              socket.write(encodeFrame(0xa, payload));
            } catch {
              /* 忽略写失败 */
            }
          }
        }
      },
    );

    socket.on('data', reader);
    // data 事件也证明连接活跃（浏览器不一定回 pong，但会持续发 move）
    socket.on('data', () => {
      aliveAt = Date.now();
    });

    /**
     * 心跳。
     *
     * 云平台的反向代理（Render / Railway / Cloudflare）会在连接「看起来空闲」时
     * 直接掐断，而且**不通知任何一端** —— 客户端以为是网络卡了，
     * 服务器以为客户端还在。每 30 秒发一次 ping 就能把这条连接标成活跃。
     *
     * 同时做反向检查：如果 75 秒没收到任何数据（连 pong 都没有），
     * 说明对端已死，主动清理，避免房间永远挂着一个幽灵玩家。
     */
    heartbeat = setInterval(() => {
      if (socket.destroyed) {
        stopHeartbeat();
        return;
      }
      if (Date.now() - aliveAt > 75_000) {
        stopHeartbeat();
        if (room) room.leave(socket);
        socket.destroy();
        return;
      }
      try {
        socket.write(encodeFrame(0x9, ''));
      } catch {
        /* 写失败交给 onSocketGone 处理 */
      }
    }, 30_000);

    // 统一的「连接没了」清理入口。
    // 必须同时覆盖 end / close / error —— 见 onSocketGone 的注释，
    // 只监听 close 会让客户端断开后服务器永远不知道。
    onSocketGone(socket, () => {
      stopHeartbeat();
      if (room) room.leave(socket);
    });

    send({ type: 'hello', tickHz: TICK_HZ });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const { port } = await startServer({ port: Number(process.env.PORT ?? 8080) });
  console.log(`pong-duel server: http://127.0.0.1:${port}`);
}
