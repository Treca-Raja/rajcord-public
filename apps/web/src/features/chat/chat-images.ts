import { CHAT_IMAGE_LIMITS, type ChatImageMimeType } from '@tricord/shared';

export interface ChatImageDraft {
  id: string;
  file: File;
  mimeType: ChatImageMimeType;
  previewUrl: string;
}

type ImageRead = { reader: FileReader | undefined; promise: Promise<string> };
const reads = new WeakMap<ChatImageDraft, ImageRead>();

export function clipboardFiles(data: Pick<DataTransfer, 'items' | 'files'>): File[] {
  const items = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  // Clipboard items and files describe the same payload, not separate images.
  return items.length ? items : Array.from(data.files ?? []);
}

export function prepareChatImage(file: File): ChatImageDraft {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('Choose a PNG, JPEG or WebP image.');
  if (!file.size || file.size > CHAT_IMAGE_LIMITS.maxBytes)
    throw new Error('Choose an image no larger than 8 MiB.');
  return {
    id: crypto.randomUUID(),
    file,
    mimeType: file.type as ChatImageMimeType,
    previewUrl: URL.createObjectURL(file),
  };
}

export function releaseChatImage(image: ChatImageDraft | undefined) {
  if (!image) return;
  reads.get(image)?.reader?.abort();
  reads.delete(image);
  URL.revokeObjectURL(image.previewUrl);
}

export function chatImageBase64(image: ChatImageDraft): Promise<string> {
  const existing = reads.get(image);
  if (existing) return existing.promise;
  const reader = new FileReader();
  const promise = new Promise<string>((resolve, reject) => {
    reader.onload = () => {
      if (
        typeof reader.result !== 'string' ||
        !reader.result.startsWith(`data:${image.mimeType};base64,`)
      ) {
        reject(new Error('Could not prepare this image. Remove it and choose it again.'));
        return;
      }
      const cached = reads.get(image);
      // Drop the reader's data URL once the reusable wire payload is ready.
      if (cached?.reader === reader) cached.reader = undefined;
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Could not read this image. Try sending again.'));
    reader.onabort = () => reject(new Error('Image preparation was cancelled.'));
    reader.readAsDataURL(image.file);
  });
  reads.set(image, { reader, promise });
  void promise.catch(() => {
    if (reads.get(image)?.reader === reader) reads.delete(image);
  });
  return promise;
}

export function chatImageUrl(conversationId: string, messageId: string) {
  return `/media/chat-attachments/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}`;
}
