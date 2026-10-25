/**
 * 联机客户端。
 *
 * 三件事必须做对，否则玩家能明显感觉到：
 *   1. **重连**：Wi-Fi 抖动时不要直接退游戏，自动重试并回到原房间
 *   2. **状态插值**：30Hz 的服务器状态要画成 60fps 的平滑运动，否则球会一格一格跳
 *   3. **输入节流**：触屏每秒能产生上百个 move，全发会把带宽吃光，会拖手感
 */

const RECONNECT_DELAYS = [400, 900, 1800, 3000, 5000];

export class Net {
  /**
   * @param {object} handlers
   * @param {(msg: object) => void} handlers.onMessage
   * @param {(status: 'connecting'|'online'|'offline'|'error', info?: object) => void} handlers.onStatus
   */
  constructor({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.room = null;
    this.side = null;
    this.attempt = 0;
    this.closedByUs = false;
    this.lastSent = 0;
    this.minIntervalMs = 1000 / 24; // 最多 24Hz 发送
    this.pendingMove = null;
    this.moveTimer = null;
    /**
     * 连接建立前发出的指令要排队。
     * 没有这个队列，点「创建房间」在弱网下会静默失败 ——
     * 因为 send() 在 readyState !== OPEN 时直接返回 false，用户什么反馈都没有。
     */
    this.outbox = [];
  }

  /** 有队列就发；没连上就排队。 */
  sendOrQueue(payload) {
    if (this.send(payload)) return true;
    this.outbox.push(payload);
    // 队列不要无限增长
    if (this.outbox.length > 20) this.outbox.shift();
    return false;
  }

  flushOutbox() {
    const pending = this.outbox;
    this.outbox = [];
    for (const payload of pending) this.send(payload);
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByUs = false;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    this.onStatus?.('connecting');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.onStatus?.('online');
      this.flushOutbox();
    });

    ws.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'joined' || msg.type === 'welcome') {
        this.room = msg.room;
        if (msg.side) this.side = msg.side;
      }
      this.onMessage?.(msg);
    });

    ws.addEventListener('close', () => {
      this.ws = null;
      if (this.closedByUs) {
        this.onStatus?.('offline');
        return;
      }
      this.onStatus?.('offline');
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      /* close 事件会紧跟着来，这里不重复处理 */
    });
  }

  scheduleReconnect() {
    const delay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)];
    this.attempt += 1;
    setTimeout(() => {
      if (this.closedByUs) return;
      this.connect();
      // 重连后自动回到原房间，玩家不用重输房号
      if (this.room) {
        this.send({ type: 'join', room: this.room });
      }
    }, delay);
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  create() {
    this.sendOrQueue({ type: 'create' });
  }

  join(room) {
    this.sendOrQueue({ type: 'join', room });
  }

  rematch() {
    this.sendOrQueue({ type: 'rematch' });
  }

  /**
   * 发送拍子位置。带节流 + 合并：高频输入只保留最新一个，
   * 到时间再发。这样既省带宽，又不会丢掉最后的位置。
   */
  move(x) {
    this.pendingMove = x;
    const now = performance.now();
    const elapsed = now - this.lastSent;

    if (elapsed >= this.minIntervalMs) {
      this.flushMove();
      return;
    }

    if (this.moveTimer) return;
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      this.flushMove();
    }, this.minIntervalMs - elapsed);
  }

  flushMove() {
    if (this.pendingMove === null) return;
    this.send({ type: 'move', x: this.pendingMove });
    this.pendingMove = null;
    this.lastSent = performance.now();
  }

  close() {
    this.closedByUs = true;
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * 状态插值器：把稀疏的服务器快照补成平滑运动。
 *
 * 做法：保存最近两个快照，按「现在距上一个快照多久」在两帧之间线性插值。
 * 不做外推（预测未来）——外推在掉包时会让球瞬移，比轻微延迟更难受。
 */
export class Interpolator {
  constructor() {
    this.prev = null;
    this.curr = null;
  }

  push(snapshot) {
    this.prev = this.curr;
    this.curr = { ...snapshot, at: performance.now() };
  }

  /**
   * @returns {{balls: {x:number,y:number}[], paddles: {p1:number,p2:number}} | null}
   */
  sample() {
    if (!this.curr) return null;
    if (!this.prev) return { balls: this.curr.balls, paddles: this.curr.paddles };

    const span = this.curr.at - this.prev.at;
    if (span <= 0) return { balls: this.curr.balls, paddles: this.curr.paddles };

    // 渲染落后服务器约一帧，换取平滑
    const raw = (performance.now() - this.curr.at) / span;
    const t = Math.min(1.35, Math.max(0, raw));

    const lerp = (a, b) => a + (b - a) * t;

    const balls = this.curr.balls.map((b, i) => {
      const p = this.prev.balls[i];
      if (!p) return { x: b[0], y: b[1] };
      return { x: lerp(p[0], b[0]), y: lerp(p[1], b[1]) };
    });

    return {
      balls,
      paddles: {
        p1: lerp(this.prev.paddles.p1, this.curr.paddles.p1),
        p2: lerp(this.prev.paddles.p2, this.curr.paddles.p2),
      },
    };
  }
}
