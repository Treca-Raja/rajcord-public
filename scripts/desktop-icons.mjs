// Generate all Rajcord brand assets from the same 32-unit waveform.
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';

const dir = new URL('../apps/desktop/resources/', import.meta.url);
const violet = '#1d1929';
const citron = '#d4ff57';
const shapes = [
  { x: 0, y: 0, width: 32, height: 32, radius: 7, fill: violet },
  ...[
    [3, 13, 6],
    [8.5, 7, 15],
    [14, 3, 26],
    [19.5, 10, 14],
    [25, 7, 14],
  ].map(([x, y, height]) => ({ x, y, width: 4, height, radius: 2, fill: citron })),
];

function asset(path, bytes) {
  if (process.argv.includes('--check')) {
    if (!fs.readFileSync(path).equals(Buffer.from(bytes))) {
      throw new Error(
        'Regenerate the Rajcord icon with node scripts/desktop-icons.mjs: ' + path.pathname,
      );
    }
    return;
  }
  fs.writeFileSync(path, bytes);
}

const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
  ...shapes.map(
    ({ x, y, width, height, radius, fill }) =>
      `  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"/>`,
  ),
  '</svg>',
  '',
].join('\n');
asset(new URL('icon.svg', dir), svg);
asset(new URL('../apps/web/src/assets/rajcord.svg', import.meta.url), svg);

function inside(x, y, shape) {
  const { x: left, y: top, width, height, radius } = shape;
  const dx = x - Math.max(left + radius, Math.min(x, left + width - radius));
  const dy = y - Math.max(top + radius, Math.min(y, top + height - radius));
  return dx * dx + dy * dy <= radius * radius;
}

function chunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, bytes, checksum]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = ((x + (sx + 0.5) / 4) * 32) / size;
          const py = ((y + (sy + 0.5) / 4) * 32) / size;
          const shape = shapes.findLast((item) => inside(px, py, item));
          if (!shape) continue;
          covered++;
          for (let c = 0; c < 3; c++)
            sum[c] += parseInt(shape.fill.slice(1 + c * 2, 3 + c * 2), 16);
        }
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      if (covered) {
        for (let c = 0; c < 3; c++) raw[offset + c] = Math.round(sum[c] / covered);
        raw[offset + 3] = Math.round((255 * covered) / 16);
      }
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256],
  images = sizes.map(png);
asset(new URL('icon.png', dir), images.at(-1));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const start = 6 + i * 16;
  header[start] = size % 256;
  header[start + 1] = size % 256;
  header.writeUInt16LE(1, start + 4);
  header.writeUInt16LE(32, start + 6);
  header.writeUInt32LE(images[i].length, start + 8);
  header.writeUInt32LE(offset, start + 12);
  offset += images[i].length;
});
asset(new URL('icon.ico', dir), Buffer.concat([header, ...images]));
