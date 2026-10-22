/**
 * 最小 PNG 解码器（8-bit、非隔行、colorType 2/6）——验证工具专用
 *
 * 为什么需要它：
 * WebGL 渲染器（未开 preserveDrawingBuffer）在合成后立即丢弃绘制缓冲，
 * 页面内对 WebGL canvas 做 drawImage 采样会得到全黑假象。
 * 因此像素验证的正确数据源是 Page.captureScreenshot 的截图本身。
 *
 * 仅依赖 node:zlib。支持 Chrome 截图常见格式：8bit RGB / RGBA、非 Adam7。
 */
import { inflateSync } from 'node:zlib';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 解码 PNG buffer 为 { width, height, channels, data(RGBA/RGB 交织数组) }
 */
export function decodePng(buffer) {
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== PNG_SIG[i]) throw new Error('不是有效的 PNG 数据');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  let off = 8;
  while (off + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.toString('ascii', off + 4, off + 8);
    const data = buffer.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (!width || !height) throw new Error('PNG 缺少 IHDR');
  if (bitDepth !== 8) throw new Error(`不支持的 bitDepth: ${bitDepth}`);
  if (interlace !== 0) throw new Error('不支持隔行（Adam7）PNG');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`不支持的 colorType: ${colorType}`);

  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);

  let prev = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    row.set(raw.subarray(pos, pos + stride));
    pos += stride;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`未知行滤镜: ${filter}（y=${y}）`);
      row[i] = v & 0xff;
    }
    prev = row;
  }

  return { width, height, channels, data: out };
}

/**
 * 统计解码图中指定相对窗口内的亮度分布。
 * 相对窗口坐标取 [0,1]，默认中部区域，避开顶部导航与底部相位文案。
 * 非黑判定：RGB 通道和 > 24（对暗色星域场景足够敏感，噪点级 8/255 不误判）。
 */
export function analyzePixels(img, win = { x0: 0.15, y0: 0.25, x1: 0.85, y1: 0.6 }) {
  const { width: w, height: h, channels: ch, data } = img;
  const x0 = Math.max(0, Math.floor(w * win.x0));
  const x1 = Math.min(w, Math.ceil(w * win.x1));
  const y0 = Math.max(0, Math.floor(h * win.y0));
  const y1 = Math.min(h, Math.ceil(h * win.y1));

  let nonBlack = 0;
  let total = 0;
  let sum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * ch;
      const v = data[i] + data[i + 1] + data[i + 2];
      sum += v;
      if (v > 24) nonBlack++;
      total++;
    }
  }
  return {
    size: `${w}x${h}`,
    region: `[${x0},${y0} → ${x1},${y1}]`,
    sampled: total,
    nonBlack,
    nonBlackRatio: total ? +(nonBlack / total).toFixed(4) : 0,
    avgBrightness: total ? +(sum / total).toFixed(2) : 0
  };
}
