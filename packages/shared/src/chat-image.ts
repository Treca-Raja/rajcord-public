export const CHAT_IMAGE_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxInputPixels: 16 * 1024 * 1024,
  maxCount: 1,
} as const;

export type ChatImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type ChatImageAttachment = { mimeType: ChatImageMimeType; size: number };
export type ChatImageUpload = { mimeType: ChatImageMimeType; base64: string };
