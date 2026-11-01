// Rasterize the existing desktop mascot, rather than maintaining a second design.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'desktop/pet-canvas.js'), 'utf8');
const width = 384, height = 384;
function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), sum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, sum]);
}
for (const state of ['idle', 'running', 'waiting']) {
  const pixels = Buffer.alloc(width * height * 4);
  let callback, sx = 1, sy = 1, tx = 0, ty = 0;
  const ctx = {
    fillStyle: '#000000', imageSmoothingEnabled: false,
    clearRect() { pixels.fill(0); }, save() {}, restore() {},
    scale(x, y) { sx *= x; sy *= y; }, translate(x, y) { tx += x; ty += y; },
    fillRect(x, y, w, h) {
      const c = this.fillStyle.startsWith('#')
        ? [...this.fillStyle.slice(1).match(/../g).map(v => parseInt(v, 16)), 255]
        : this.fillStyle.match(/[\d.]+/g).map(Number);
      if (!this.fillStyle.startsWith('#')) c[3] *= 255;
      for (let py = Math.max(0, Math.round((y + ty) * sy)); py < Math.min(height, Math.round((y + h + ty) * sy)); py++)
        for (let px = Math.max(0, Math.round((x + tx) * sx)); px < Math.min(width, Math.round((x + w + tx) * sx)); px++) {
          const i = (py * width + px) * 4;
          for (let k = 0; k < 4; k++) pixels[i + k] = Math.round(c[k]);
        }
    },
  };
  const sandbox = { document: { getElementById: () => ({ width, height, getContext: () => ctx }) },
    performance: { now: () => 0 }, window: {}, requestAnimationFrame: fn => { callback = fn; } };
  vm.runInNewContext(source, sandbox);
  sandbox.window.shadowMascot.setState(state); callback(1000);
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const dir = path.join(root, 'mobile/android/app/src/main/res/drawable-nodpi');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `shadow_${state}.png`), png);
}
