import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function clamp(v, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function sdRoundedBox(px, py, cx, cy, bw, bh, r) {
  const qx = Math.abs(px - cx) - bw + r;
  const qy = Math.abs(py - cy) - bh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size;

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const nx = (x + 0.5) / s;
      const ny = (y + 0.5) / s;

      // Outer rounded squircle background
      const dBg = sdRoundedBox(nx, ny, 0.5, 0.5, 0.44, 0.44, 0.22);
      const alphaBg = clamp(0.5 - dBg * s);

      if (alphaBg <= 0) continue;

      // Gradient Indigo -> Cyan/Emerald
      const t = clamp((nx * 0.6 + ny * 0.8));
      let r = Math.round(59 * (1 - t) + 16 * t);
      let g = Math.round(130 * (1 - t) + 185 * t);
      let b = Math.round(246 * (1 - t) + 129 * t);

      // Page / Frame motif inside
      const dPage = sdRoundedBox(nx, ny, 0.5, 0.5, 0.26, 0.30, 0.05);
      const dInner = sdRoundedBox(nx, ny, 0.5, 0.52, 0.20, 0.21, 0.03);
      const isPageBorder = dPage <= 0 && dInner > 0;

      // Camera lens circle in the center
      const distCenter = Math.hypot(nx - 0.5, ny - 0.52);
      const dLensOuter = distCenter - 0.13;
      const dLensInner = distCenter - 0.075;
      const isLensRing = dLensOuter <= 0 && dLensInner > 0;
      const isLensCore = distCenter <= 0.04;

      // Full-page corner brackets
      let whiteMix = 0;
      if (isPageBorder) {
        whiteMix = clamp(0.5 - dPage * s);
      }
      if (isLensRing) {
        whiteMix = Math.max(whiteMix, clamp(0.5 - dLensOuter * s));
      }
      if (isLensCore) {
        whiteMix = Math.max(whiteMix, clamp(0.5 - (distCenter - 0.04) * s));
      }
      // Top header bar of page
      if (dPage <= 0 && ny < 0.29) {
        whiteMix = Math.max(whiteMix, 0.92);
      }

      r = Math.round(r * (1 - whiteMix) + 255 * whiteMix);
      g = Math.round(g * (1 - whiteMix) + 255 * whiteMix);
      b = Math.round(b * (1 - whiteMix) + 255 * whiteMix);

      const idx = (y * s + x) * 4;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = Math.round(alphaBg * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const iconsDir = path.resolve('icons');
fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = renderIcon(size);
  const file = path.join(iconsDir, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`Generated ${file} (${size}x${size}, ${png.length} bytes)`);
}
