/**
 * 一次性归因分析（跑完即删，非交付物）
 * 问题：cdp-interact 实测 rightContactCenter(R0→R1)=159.5 异常偏高，需定位来源。
 * 方法：对 shots/interact 下截图做分块 diff，对比各状态对的差异空间分布。
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { decodePng } from './png.mjs';

const DIR = join(process.cwd(), 'utils', 'verify', 'shots', 'interact');
const load = (n) => decodePng(readFileSync(join(DIR, `${n}.png`)));

function win(a, b, w) {
  const ch = a.channels;
  const W = a.width;
  const x0 = Math.floor(W * w.x0), x1 = Math.ceil(W * w.x1);
  const y0 = Math.floor(a.height * w.y0), y1 = Math.ceil(a.height * w.y1);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = (y * W + x) * ch;
      sum += Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2]);
      n++;
    }
  return +(sum / n).toFixed(1);
}

function grid(a, b, k) {
  const rows = [];
  for (let j = 0; j < k; j++) {
    const line = [];
    for (let i = 0; i < k; i++)
      line.push(win(a, b, { x0: i / k, y0: j / k, x1: (i + 1) / k, y1: (j + 1) / k }).toFixed(0).padStart(4));
    rows.push(line.join(' '));
  }
  return rows.join('\n');
}

const CW = { x0: 0.4, y0: 0.425, x1: 0.6, y1: 0.575 };
const names = ['base0', 'base1', 'left0', 'left1', 'left2', 'right0', 'right1', 'recenter1', 'recenter2'];
const im = Object.fromEntries(names.map((n) => [n, load(n)]));

const pairs = [
  ['base0', 'base1', '噪声（无鼠标）'],
  ['left1', 'left2', '左侧静止 contact'],
  ['right0', 'right1', '右侧静止 contact ← 异常项'],
  ['left0', 'right0', '视差 L→R'],
  ['right0', 'left1', '视差回程 R→L'],
  ['recenter1', 'recenter2', '回正后 recover'],
  ['left0', 'recenter1', 'L→回正'],
  ['left0', 'base0', '检查：左稳态 vs 初始']
];

console.log('窗口口径: CENTER_WIN 20%x15%  |  全屏');
console.log('---');
for (const [a, b, label] of pairs) {
  console.log(`${label.padEnd(26)} center=${String(win(im[a], im[b], CW)).padStart(6)}  full=${String(win(im[a], im[b], { x0: 0, y0: 0, x1: 1, y1: 1 })).padStart(6)}`);
}
console.log('\n== right0 vs right1 (异常项) 6x6 分块 ==');
console.log(grid(im.right0, im.right1, 6));
console.log('\n== base0 vs base1 (噪声基线) 6x6 分块 ==');
console.log(grid(im.base0, im.base1, 6));
console.log('\n== left0 vs right0 (视差) 6x6 分块 ==');
console.log(grid(im.left0, im.right0, 6));

// 追加：R1 vs L0b —— 右侧稍后帧与左侧稳定帧的差异（旋转饱和后的纯姿态差）
console.log('\n== left1 vs right1 (L 稳态 vs R 稳态后段) 6x6 ==');
console.log(grid(im.left1, im.right1, 6));
console.log('\n== left2 vs right1 (L 最稳态 vs R 稳态后段) 6x6 ==');
console.log(grid(im.left2, im.right1, 6));
