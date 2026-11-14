import { afterEach, expect, it, vi } from 'vitest';
import { api } from './context';

afterEach(() => vi.unstubAllGlobals());
it('rejects malformed successful JSON with a safe validation error', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ csrfToken: 'private-fixture' })),
  );
  await expect(api('/auth/me')).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' });
});
it('preserves permission status when the error body is not JSON', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('<html>Unavailable</html>', { status: 401 })),
  );
  await expect(api('/auth/me')).rejects.toMatchObject({ status: 401, message: 'Request failed.' });
});
it('does not replace HTTP permission errors with success-shape errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error: 'Sign in required.' }, { status: 403 })),
  );
  await expect(api('/auth/me')).rejects.toMatchObject({
    status: 403,
    message: 'Sign in required.',
  });
});
it('retains same-origin cookies, CSRF and cancellation on mutations', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  await expect(api('/auth/logout', 'POST', undefined, 'fixture-csrf', signal)).resolves.toEqual({
    ok: true,
  });
  expect(fetch).toHaveBeenCalledWith(
    '/api/auth/logout',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': 'fixture-csrf' },
      signal,
    }),
  );
});
it('preserves aborted response-body errors', async () => {
  const controller = new AbortController();
  const cause = new DOMException('Aborted', 'AbortError');
  controller.abort();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(cause) }),
  );
  await expect(api('/auth/me', 'GET', undefined, undefined, controller.signal)).rejects.toBe(cause);
});
