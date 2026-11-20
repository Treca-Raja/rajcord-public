import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { CHAT_IMAGE_LIMITS, type ChatImageMimeType } from '@tricord/shared';
import { HttpError, input } from '../auth/validation.js';

export const CHAT_ATTACHMENT_BODY_LIMIT = Math.ceil(CHAT_IMAGE_LIMITS.maxBytes / 3) * 4 + 32768;
export type ValidatedChatImage = {
  mimeType: ChatImageMimeType;
  size: number;
  image: Buffer;
  hash: string;
};
const invalid = () => new HttpError(400, 'Choose a still PNG, JPEG or WebP image.');

function animatedChunks(bytes: Buffer, format: string) {
  if (format === 'png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
      offset += bytes.readUInt32BE(offset) + 12;
    }
  } else if (format === 'webp') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = bytes.toString('ascii', offset, offset + 4);
      if (kind === 'ANIM' || kind === 'ANMF') return true;
      const length = bytes.readUInt32LE(offset + 4);
      offset += 8 + length + (length % 2);
    }
  }
  return false;
}

export async function validateChatImage(value: unknown): Promise<ValidatedChatImage> {
  const body = input(value, ['mimeType', 'base64']);
  if (
    typeof body.mimeType !== 'string' ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(body.mimeType) ||
    typeof body.base64 !== 'string'
  )
    throw invalid();
  if (body.base64.length > Math.ceil(CHAT_IMAGE_LIMITS.maxBytes / 3) * 4)
    throw new HttpError(413, 'Images must be no larger than 8 MiB.');
  if (body.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.base64)) throw invalid();
  const image = Buffer.from(body.base64, 'base64');
  if (!image.length) throw invalid();
  if (image.length > CHAT_IMAGE_LIMITS.maxBytes)
    throw new HttpError(413, 'Images must be no larger than 8 MiB.');
  if (image.toString('base64') !== body.base64) throw invalid();
  const mimeType = body.mimeType as ChatImageMimeType;
  const format = mimeType.slice(6);
  const signatureMatches =
    format === 'jpeg'
      ? image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : format === 'png'
        ? image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
  if (!signatureMatches || animatedChunks(image, format)) throw invalid();
  // libjpeg can tolerate a missing end marker when producing a small validation raster.
  if (format === 'jpeg' && !image.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) throw invalid();
  try {
    const decoder = sharp(image, {
      limitInputPixels: CHAT_IMAGE_LIMITS.maxInputPixels,
      failOn: 'warning',
    }).timeout({ seconds: 5 });
    const metadata = await decoder.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1) throw invalid();
    // Use the timed processing pipeline; metadata/stats do not enforce Sharp's timeout.
    await decoder
      .resize({
        width: 32,
        height: 32,
        fit: 'inside',
        withoutEnlargement: true,
        fastShrinkOnLoad: false,
      })
      .raw()
      .toBuffer();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && /timeout/i.test(error.message))
      throw new HttpError(400, 'This image takes too long to check. Choose a smaller image.');
    throw invalid();
  }
  return {
    mimeType,
    size: image.length,
    image,
    hash: createHash('sha256').update(image).digest('hex'),
  };
}
