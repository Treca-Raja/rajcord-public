// Original geometric Rajcord mark; deterministic, dependency-free raster/ICO generation.
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';
const dir = new URL('../apps/desktop/resources/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
const shapes = [
  {
    color: '#66e0cf',
    points: [
      [0, 0],
      [256, 0],
      [256, 256],
      [0, 256],
    ],
  },
  {
    color: '#14282f',
    points: [
      [22, 22],
      [234, 22],
      [234, 234],
      [22, 234],
    ],
  },
  {
    color: '#ffffff',
    points: [
      [60, 58],
      [133, 58],
      [160, 80],
      [160, 121],
      [135, 140],
      [171, 198],
      [139, 198],
      [106, 145],
      [89, 145],
      [89, 198],
      [60, 198],
    ],
  },
  {
    color: '#14282f',
    points: [
      [89, 84],
      [123, 84],
      [132, 92],
      [132, 112],
      [123, 119],
      [89, 119],
    ],
  },
  {
    color: '#66e0cf',
    points: [
      [181, 101],
      [196, 101],
      [196, 156],
      [181, 156],
    ],
  },
];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${shapes.map((s) => `<polygon fill="${s.color}" points="${s.points.map((p) => p.join(',')).join(' ')}"/>`).join('')}</svg>\n`;
fs.writeFileSync(new URL('icon.svg', dir), svg);
function inside(x, y, points) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i],
      [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
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
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          let color = '#66e0cf';
          for (const shape of shapes)
            if (
              inside(
                ((x + (sx + 0.5) / 4) * 256) / size,
                ((y + (sy + 0.5) / 4) * 256) / size,
                shape.points,
              )
            )
              color = shape.color;
          for (let c = 0; c < 3; c++) sum[c] += parseInt(color.slice(1 + c * 2, 3 + c * 2), 16);
        }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[offset + c] = Math.round(sum[c] / 16);
      raw[offset + 3] = 255;
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
const sizes = [16, 32, 48, 256],
  images = sizes.map(png);
fs.writeFileSync(new URL('icon.png', dir), images[3]);
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
fs.writeFileSync(new URL('icon.ico', dir), Buffer.concat([header, ...images]));
