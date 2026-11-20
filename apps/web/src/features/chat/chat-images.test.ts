import { afterEach, expect, it, vi } from 'vitest';
import { CHAT_IMAGE_LIMITS } from '@tricord/shared';
import {
  prepareChatImage,
  releaseChatImage,
  clipboardFiles,
  chatImageBase64,
  chatImageUrl,
} from './chat-images';
import { DraftStore, attemptFor, sendPayload } from './chat-state';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function image(name = 'screenshot.png') {
  return prepareChatImage(new File(['synthetic-image'], name, { type: 'image/png' }));
}

it('accepts only bounded image files and never creates a preview for rejected input', () => {
  const create = vi.spyOn(URL, 'createObjectURL');
  for (const file of [
    new File(['not-image'], 'archive.zip', { type: 'application/zip' }),
    new File(['not-image'], 'animated.gif', { type: 'image/gif' }),
    new File([], 'empty.png', { type: 'image/png' }),
    new File([new Uint8Array(CHAT_IMAGE_LIMITS.maxBytes + 1)], 'large.png', { type: 'image/png' }),
  ])
    expect(() => prepareChatImage(file)).toThrow();
  expect(create).not.toHaveBeenCalled();
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
    const draft = prepareChatImage(new File(['synthetic'], 'image', { type: mimeType }));
    expect(draft.mimeType).toBe(mimeType);
    expect(draft.previewUrl).toMatch(/^blob:/);
    releaseChatImage(draft);
  }
});

it('reads one clipboard representation once and retains distinct multiple files for rejection', () => {
  const file = new File(['one'], 'image.png', { type: 'image/png' });
  const entry = { kind: 'file', getAsFile: () => file };
  expect(clipboardFiles({ items: [entry], files: [file] } as unknown as DataTransfer)).toEqual([
    file,
  ]);
  expect(clipboardFiles({ items: [], files: [file] } as unknown as DataTransfer)).toEqual([file]);
  expect(
    clipboardFiles({ items: [entry, entry], files: [file, file] } as unknown as DataTransfer),
  ).toHaveLength(2);
});

it('retains image identity across remount retries and changes it when the selected image changes', () => {
  const first = image();
  const replacement = image('other.png');
  const draft = { body: '', replyToId: null, attempt: null, attachment: first };
  const pending = attemptFor(draft, () => 'original');
  expect(attemptFor({ ...draft, attempt: pending }, () => 'replacement')).toBe(pending);
  expect(
    attemptFor({ ...draft, attachment: replacement, attempt: pending }, () => 'replacement')
      .clientId,
  ).toBe('replacement');
  expect(sendPayload(pending)).toEqual({ clientId: 'original', body: '' });
  releaseChatImage(first);
  releaseChatImage(replacement);
});

it('releases replaced, sent, inaccessible and signed-out image drafts without losing text on session replacement', () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  const store = new DraftStore();
  const first = image();
  const second = image();
  store.set('first', {
    body: 'Keep caption',
    replyToId: 'target',
    attempt: null,
    attachment: first,
  });
  expect(revoke).not.toHaveBeenCalled();
  store.set('first', { ...store.get('first')!, attachment: second });
  expect(revoke).toHaveBeenCalledWith(first.previewUrl);
  const pending = attemptFor(store.get('first')!, () => 'pending');
  store.set('first', { ...store.get('first')!, attempt: pending });
  store.clearImages();
  expect(store.get('first')).toMatchObject({
    body: 'Keep caption',
    replyToId: 'target',
    attempt: null,
    attachment: undefined,
  });
  expect(revoke).toHaveBeenCalledWith(second.previewUrl);
  for (const action of ['delete', 'forget', 'clear'] as const) {
    const attachment = image();
    store.set(action, { body: '', replyToId: null, attempt: null, attachment });
    if (action === 'clear') store.clear();
    else store[action](action);
    expect(revoke).toHaveBeenCalledWith(attachment.previewUrl);
  }
});

it('encodes lazily once for retries and discards cached readers when an image is released', async () => {
  const readers: Reader[] = [];
  class Reader {
    result: string | null = null;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    readAsDataURL = vi.fn();
    abort = vi.fn(() => this.onabort?.());
    constructor() {
      readers.push(this);
    }
  }
  vi.stubGlobal('FileReader', Reader);
  const draft = image();
  expect(readers).toHaveLength(0);
  const first = chatImageBase64(draft);
  expect(chatImageBase64(draft)).toBe(first);
  expect(readers).toHaveLength(1);
  readers[0]!.result = 'data:image/png;base64,c3ludGhldGlj';
  readers[0]!.onload?.();
  await expect(first).resolves.toBe('c3ludGhldGlj');
  expect(chatImageBase64(draft)).toBe(first);
  releaseChatImage(draft);
  expect(readers[0]!.abort).not.toHaveBeenCalled();
  const cancelled = chatImageBase64(draft);
  releaseChatImage(draft);
  await expect(cancelled).rejects.toThrow('cancelled');
  expect(readers[1]!.abort).toHaveBeenCalledOnce();
});

it('allows an image read failure to retry without caching a rejected promise', async () => {
  const readers: Reader[] = [];
  class Reader {
    onerror?: () => void;
    readAsDataURL() {
      readers.push(this);
    }
    abort() {}
  }
  vi.stubGlobal('FileReader', Reader);
  const draft = image();
  const failed = chatImageBase64(draft);
  readers[0]!.onerror?.();
  await expect(failed).rejects.toThrow('Could not read');
  const retry = chatImageBase64(draft);
  expect(retry).not.toBe(failed);
  expect(readers).toHaveLength(2);
  releaseChatImage(draft);
});

it('constructs same-origin media paths from identifiers instead of accepting external URLs', () => {
  expect(chatImageUrl('conversation', 'message')).toBe(
    '/media/chat-attachments/conversation/message',
  );
  expect(chatImageUrl('../private', 'https://example.test')).toBe(
    '/media/chat-attachments/..%2Fprivate/https%3A%2F%2Fexample.test',
  );
});
