/**
 * 一次性窗口扫描（跑完即删，非交付物）
 * 目的：基于 probe 截图，枚举不同分块网格，确定「视差/噪声」信噪比最优的判定窗口。
 * 数据源：utils/verify/shots/probe/ 下的 p0/p1（噪声）、l0/r0（视差）。
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { decodePng } from './png.mjs';

const DIR = join(process.cwd(), 'utils', 'verify', 'shots', 'probe');
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
  return sum / n;
}

const p0 = load('p0'), p1 = load('p1'), l0 = load('l0'), r0 = load('r0');

console.log('== 网格扫描：noise(p0,p1) vs parallax(l0,r0)，按信噪比排序 ==');
for (const k of [3, 4, 5, 6]) {
  const rows = [];
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      const cell = { x0: i / k, y0: j / k, x1: (i + 1) / k, y1: (j + 1) / k };
      const n = win(p0, p1, cell);
      const s = win(l0, r0, cell);
      rows.push({ cell: `${i},${j}`, noise: +n.toFixed(1), signal: +s.toFixed(1), ratio: +(s / n).toFixed(2) });
    }
  rows.sort((a, b) => b.ratio - a.ratio);
  console.log(`\n-- ${k}x${k} grid top5:`);
  rows.slice(0, 5).forEach((r) => console.log(`   [${r.cell}] noise=${r.noise} signal=${r.signal} ratio=${r.ratio}`));
  const center = rows.find((r) => r.cell === `${Math.floor((k - 1) / 2)},${Math.floor((k - 1) / 2)}`);
  console.log(`   center cell: noise=${center.noise} signal=${center.signal} ratio=${center.ratio}`);
}

console.log('\n== 中心邻域聚合窗口（以质心为中心） ==');
for (const half of [0.08, 0.1, 0.12, 0.15, 0.18, 0.2, 0.25]) {
  const w = { x0: 0.5 - half, x1: 0.5 + half, y0: 0.5 - half * 0.75, y1: 0.5 + half * 0.75 };
  const n = win(p0, p1, w);
  const s = win(l0, r0, w);
  console.log(`   half=${half} (${(half * 2 * 100).toFixed(0)}%x${(half * 1.5 * 100).toFixed(0)}%) noise=${n.toFixed(1)} signal=${s.toFixed(1)} ratio=${(s / n).toFixed(2)}`);
}
