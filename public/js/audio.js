/**
 * 音效层 · Web Audio API
 *
 * 全部用振荡器实时合成，不加载任何音频文件：
 *   - 体积为 0，没有 404，没有解码延迟
 *   - 音高可以随击球位置变化（同一个球拍，打在边上和打在中间声音不同）
 *
 * 三个必须处理的现实问题：
 *   1. **移动端必须由用户手势解锁** —— iOS/Android 都不允许无交互创建/恢复 AudioContext
 *   2. **触屏点击要压低延迟** —— latencyHint: 'interactive'
 *   3. **连续快速击球不能爆音** —— 每次都用独立的 gain 包络，结束后自动断开
 */

let ctx = null;
let master = null;
let unlocked = false;
let muted = false;

/** 音量：留足余量，避免叠加时削波。 */
const LEVEL = {
  master: 0.35,
  paddle: 0.5,
  wall: 0.32,
  score: 0.5,
  split: 0.34,
  win: 0.5,
};

/**
 * 必须由一次真实用户手势调用（touchstart / click / keydown），否则移动端会静默失败。
 * 返回 true 表示音频已经可用。
 */
export function unlock() {
  if (typeof window === 'undefined') return false;
  if (!unlocked) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = muted ? 0 : LEVEL.master;
      // 加一级压缩，防止多球同时撞击时削波
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 6;
      master.connect(comp).connect(ctx.destination);
      unlocked = true;
    } catch {
      return false;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx.state === 'running';
}

export function isUnlocked() {
  return unlocked && ctx?.state === 'running';
}

export function setMuted(value) {
  muted = Boolean(value);
  if (master) {
    // 用短斜坡避免咔哒声
    master.gain.setTargetAtTime(muted ? 0 : LEVEL.master, ctx.currentTime, 0.02);
  }
  return muted;
}

export function isMuted() {
  return muted;
}

/**
 * 一次完整的音：一个有包络的振荡器。
 * @param {object} o
 * @param {number} o.freq   起始频率
 * @param {number} [o.to]   频率滑动终点
 * @param {number} [o.dur]  时长（秒）
 * @param {number} [o.gain] 峰值音量
 * @param {string} [o.type] 波形
 * @param {number} [o.tau]  包络衰减系数
 */
function blip({ freq, to, dur = 0.08, gain = 0.4, type = 'square', tau = 0.02 }) {
  if (!ctx || ctx.state !== 'running' || muted) return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (typeof to === 'number' && to !== freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), now + dur);
  }

  // 快起快落，避免咔哒
  env.gain.setValueAtTime(0.0001, now);
  env.gain.exponentialRampToValueAtTime(gain, now + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  osc.connect(env).connect(master);
  osc.start(now);
  osc.stop(now + dur + 0.02);

  // 显式断开，避免节点堆积
  osc.onended = () => {
    try {
      env.disconnect();
      osc.disconnect();
    } catch {
      /* 已断开 */
    }
  };
}

/** 击球：音高随横向位置升高，力度随球速增加。 */
export function playPaddle({ x = 0.5, speedRatio = 0 } = {}) {
  const base = 300 + x * 240; // 左侧低沉，右侧明亮
  const gain = LEVEL.paddle * (0.75 + Math.min(1, speedRatio) * 0.35);
  blip({ freq: base, to: base * 1.6, dur: 0.075, gain, type: 'square', tau: 0.02 });
}

/** 撞墙：更短更尖。 */
export function playWall({ y = 0.5 } = {}) {
  const base = 620 + y * 120;
  blip({ freq: base, to: base * 0.8, dur: 0.05, gain: LEVEL.wall, type: 'triangle' });
}

/** 得分：两段下行，明确是「丢了」。 */
export function playScore() {
  blip({ freq: 520, to: 300, dur: 0.14, gain: LEVEL.score, type: 'sawtooth' });
  setTimeout(() => blip({ freq: 300, to: 170, dur: 0.2, gain: LEVEL.score * 0.8, type: 'sawtooth' }), 110);
}

/** 分裂：快速上行滑音，像「裂开」。 */
export function playSplit() {
  blip({ freq: 380, to: 900, dur: 0.22, gain: LEVEL.split, type: 'triangle' });
}

/** 胜利：上行琶音。 */
export function playWin() {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => {
    setTimeout(() => blip({ freq: f, to: f, dur: 0.16, gain: LEVEL.win, type: 'triangle' }), i * 95);
  });
}

/** 把引擎事件翻译成声音。集中在这里，方便统一调参。 */
export function playEvents(events, state) {
  for (const ev of events) {
    switch (ev.type) {
      case 'paddle':
        playPaddle({
          x: ev.x / state.width,
          speedRatio: (ev.speed - 640) / (1560 - 640),
        });
        break;
      case 'wall':
        playWall({ y: ev.y / state.height });
        break;
      case 'score':
        playScore();
        break;
      case 'split':
        playSplit();
        break;
      case 'win':
        playWin();
        break;
      default:
        break;
    }
  }
}
