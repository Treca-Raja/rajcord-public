import { expect, it, vi } from 'vitest';
import { createWindowOpenHandler } from './external-links.js';

async function fixture(currentUrl = 'https://chat.example/channel') {
  const openExternal = vi.fn(async (_url: string) => {});
  const onError = vi.fn();
  const handler = await createWindowOpenHandler({
    target: 'https://chat.example',
    currentUrl: () => currentUrl,
    openExternal,
    onError,
  });
  return { handler, openExternal, onError };
}

it('opens validated web links through the OS adapter and always denies new Electron windows', async () => {
  const { handler, openExternal, onError } = await fixture();
  expect(handler({ url: 'HTTPS://example.com/a' })).toEqual({ action: 'deny' });
  expect(handler({ url: 'http://example.com/b' })).toEqual({ action: 'deny' });
  expect(openExternal.mock.calls).toEqual([['https://example.com/a'], ['http://example.com/b']]);
  expect(onError).not.toHaveBeenCalled();
});

it.each([
  'javascript:alert(1)',
  'file:///C:/Windows/System32/cmd.exe',
  'data:text/html,x',
  'mailto:someone@example.com',
  'https://user:secret@example.com',
  'https://',
])('denies external actions for unsafe destinations: %s', async (url) => {
  const { handler, openExternal } = await fixture();
  expect(handler({ url })).toEqual({ action: 'deny' });
  expect(openExternal).not.toHaveBeenCalled();
});

it.each([
  'https://evil.example',
  'https://chat.example.evil.test',
  'http://chat.example',
  'https://chat.example:444',
  'about:blank',
  'broken',
])('denies external actions when the app window has an untrusted URL: %s', async (currentUrl) => {
  const { handler, openExternal } = await fixture(currentUrl);
  expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  expect(openExternal).not.toHaveBeenCalled();
});

it('handles rejected OS browser launches without an unhandled rejection', async () => {
  const { handler, openExternal, onError } = await fixture();
  const failure = new Error('No browser configured');
  openExternal.mockRejectedValueOnce(failure);
  expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  await Promise.resolve();
  expect(onError).toHaveBeenCalledWith(failure);
});
