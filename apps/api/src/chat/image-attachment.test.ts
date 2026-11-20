import { expect, it } from 'vitest';
import sharp from 'sharp';
import { randomBytes, createHash } from 'node:crypto';
import { CHAT_IMAGE_LIMITS } from '@tricord/shared';
import { validateChatImage } from './image-attachment.js';

const image = () =>
  sharp({ create: { width: 800, height: 450, channels: 3, background: '#61a9ca' } });
const upload = (bytes: Buffer, mimeType = 'image/png') => ({
  mimeType,
  base64: bytes.toString('base64'),
});

it.each(['png', 'jpeg', 'webp'] as const)(
  'fully checks %s while preserving exact original pixels, metadata and bytes',
  async (format) => {
    const bytes = await image().withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const checked = await validateChatImage(upload(bytes, 'image/' + format));
    expect(checked.image).toEqual(bytes);
    expect(checked.mimeType).toBe('image/' + format);
    expect(checked.size).toBe(bytes.length);
    expect(checked.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await sharp(checked.image).metadata()).toMatchObject({
      width: 800,
      height: 450,
      orientation: 6,
    });
  },
);

it.each([
  null,
  {},
  { mimeType: 'image/gif', base64: 'AAAA' },
  { mimeType: 'image/png', base64: '' },
  { mimeType: 'image/png', base64: 'data:image/png;base64,AAAA' },
  { mimeType: 'image/png', base64: 'AA=A' },
  { mimeType: 'image/png', base64: 'AB==' },
  { mimeType: 'image/png', base64: 'AAAA', filename: '../../secret' },
  upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
])('rejects unsupported, disguised or malformed input: %j', async (value) => {
  await expect(validateChatImage(value)).rejects.toMatchObject({ statusCode: 400 });
});

it('rejects MIME mismatches before invoking another image format', async () => {
  const bytes = await image().png().toBuffer();
  await expect(validateChatImage(upload(bytes, 'image/jpeg'))).rejects.toMatchObject({
    statusCode: 400,
  });
});

it('checks bytes and decoded pixels before storing an image', async () => {
  await expect(
    validateChatImage(upload(Buffer.alloc(CHAT_IMAGE_LIMITS.maxBytes + 1))),
  ).rejects.toMatchObject({ statusCode: 413 });
  const large = await sharp({
    create: { width: 4097, height: 4097, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  await expect(validateChatImage(upload(large))).rejects.toMatchObject({ statusCode: 400 });
});

it('accepts noisy screenshots without recompressing away text or alpha', async () => {
  const bytes = await sharp(randomBytes(256 * 256 * 4), {
    raw: { width: 256, height: 256, channels: 4 },
  })
    .png()
    .toBuffer();
  expect(bytes.length).toBeGreaterThan(65536);
  expect((await validateChatImage(upload(bytes))).image).toEqual(bytes);
});

it('rejects actual animated WebP content and APNG control chunks', async () => {
  const gif = Buffer.from(
    '47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b',
    'hex',
  );
  const webp = await sharp(gif, { animated: true })
    .webp({ delay: [100, 100], loop: 0 })
    .toBuffer();
  expect((await sharp(webp).metadata()).pages).toBe(2);
  await expect(validateChatImage(upload(webp, 'image/webp'))).rejects.toMatchObject({
    statusCode: 400,
  });
  const png = await image().png().toBuffer();
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8);
  animation.write('acTL', 4);
  animation.writeUInt32BE(2, 8);
  await expect(
    validateChatImage(upload(Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]))),
  ).rejects.toMatchObject({ statusCode: 400 });
});

it.each(['jpeg', 'png', 'webp'] as const)(
  'rejects truncated %s even when its header still parses',
  async (format) => {
    const bytes = await image().toFormat(format).toBuffer();
    await expect(
      validateChatImage(upload(bytes.subarray(0, bytes.length - 50), 'image/' + format)),
    ).rejects.toMatchObject({ statusCode: 400 });
  },
);
