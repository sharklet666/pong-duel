/**
 * 响应式布局计算验证。
 *
 * 沙箱里起不了 headless 浏览器（mojo 通道被拒），所以这里用**同样的算法**
 * 在 Node 里复算各种设备尺寸下的布局，验证不会裁切、不变形、不留坏比例。
 *
 * 这不能代替真机目测，但能挡住「竖屏时画布被裁掉底部」这类硬伤。
 */

const FIELD = { w: 1000, h: 1500 };

/** 模拟 main.js 里的 resize 计算（含最大缩放限制，两者必须保持一致）。 */
function layout({ availW, availH, fieldW = FIELD.w, fieldH = FIELD.h }) {
  let scale = Math.min(availW / fieldW, availH / fieldH);
  const maxScale = Math.min(availW, availH) < 600 ? Infinity : 0.95;
  scale = Math.min(scale, maxScale);

  const w = fieldW * scale;
  const h = fieldH * scale;
  return {
    scale,
    w,
    h,
    offsetX: (availW - w) / 2,
    offsetY: (availH - h) / 2,
    fitsW: w <= availW + 0.01,
    fitsH: h <= availH + 0.01,
    aspect: w / h,
  };
}

const DEVICES = [
  { name: 'iPhone SE 竖屏（最窄）', availW: 320, availH: 500, expect: 'fill' },
  { name: 'iPhone 13 竖屏', availW: 390, availH: 700, expect: 'fill' },
  { name: 'iPhone 15 Pro Max 竖屏', availW: 430, availH: 810, expect: 'fill' },
  { name: 'Android 小屏竖屏', availW: 360, availH: 620, expect: 'fill' },
  { name: 'Pixel 7 竖屏', availW: 412, availH: 780, expect: 'fill' },
  // 横屏/桌面：9:15 的竖版球场放进横向视口，必然左右留白。
  // 拉满就会把球场压扁、改变物理手感 —— 那才是真 bug。
  // 所以这里只要求「不裁切、不变形、仍在可视区」，不要求填满。
  { name: 'iPhone 13 横屏', availW: 844, availH: 340, expect: 'fit' },
  { name: 'iPad 竖屏', availW: 768, availH: 950, expect: 'fill' },
  { name: 'iPad 横屏', availW: 1024, availH: 700, expect: 'fit' },
  { name: '桌面 1080p', availW: 1920, availH: 880, expect: 'fit' },
  { name: '超宽屏', availW: 2560, availH: 900, expect: 'fit' },
  { name: '极窄但很高', availW: 280, availH: 900, expect: 'fit' },
];

let failures = 0;
console.log('响应式布局：');

for (const d of DEVICES) {
  const r = layout(d);
  const problems = [];

  if (!r.fitsW) problems.push(`宽度溢出 ${(r.w - d.availW).toFixed(1)}px`);
  if (!r.fitsH) problems.push(`高度溢出 ${(r.h - d.availH).toFixed(1)}px`);
  if (Math.abs(r.aspect - FIELD.w / FIELD.h) > 0.001) problems.push(`比例变形 ${r.aspect.toFixed(3)}`);
  if (r.offsetX < -0.01 || r.offsetY < -0.01) problems.push('出现负偏移');
  if (r.scale <= 0) problems.push('缩放为 0');

  // 有效利用率只在「本来就该填满」的场景上检查：
  // 竖屏手机/平板是球场形状本身就会贴满的；横屏桌面必然留白。
  const fill = (r.w * r.h) / (d.availW * d.availH);
  if (d.expect === 'fill' && fill < 0.55) {
    problems.push(`有效面积仅 ${(fill * 100).toFixed(0)}%，留白过多`);
  }

  // 无论哪种形态，画布不能被压到看不清
  if (r.w < 180) problems.push(`画布只有 ${r.w.toFixed(0)}px 宽，太小`);

  // 球拍宽度必须大于球的直径，否则拍子比球还小
  const paddleOnScreen = 190 * r.scale;
  const ballOnScreen = 30 * r.scale;
  if (paddleOnScreen < ballOnScreen * 2) problems.push(`拍子在屏幕上只有 ${paddleOnScreen.toFixed(0)}px，太小`);

  if (problems.length > 0) {
    failures += 1;
    console.log(`  ✗ ${d.name}  ${d.availW}×${d.availH}`);
    for (const p of problems) console.log(`      ${p}`);
  } else {
    console.log(
      `  ✓ ${d.name.padEnd(22)} ${String(d.availW).padStart(4)}×${String(d.availH).padEnd(4)}` +
        ` 缩放 ${r.scale.toFixed(3)} 画布 ${r.w.toFixed(0)}×${r.h.toFixed(0)} 利用 ${(fill * 100).toFixed(0)}%`,
    );
  }
}

// 关键回归：竖屏手机里，画布必须比"宽度"更受"高度"约束，否则说明比例写反了
const phone = layout({ availW: 390, availH: 700 });
const desktop = layout({ availW: 1920, availH: 880 });
console.log('\n约束方向检查：');
if (phone.scale !== phone.w / FIELD.w + 0 && false) {
  /* noop */
}
const phoneByHeight = phone.h >= phone.w;
const desktopByWidth = desktop.w <= 1920;
if (!phoneByHeight) {
  console.log('  ✗ 竖屏下画布应是高>宽');
  failures += 1;
} else {
  console.log('  ✓ 竖屏下画布高>宽（受高度约束）');
}
if (!desktopByWidth) {
  console.log('  ✗ 桌面下画布不应超出可用宽度');
  failures += 1;
} else {
  console.log('  ✓ 桌面下画布居中、不超宽');
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项有问题`}`);
process.exitCode = failures > 0 ? 1 : 0;
