import type { BrowserWindow, Cookie, Session } from 'electron';
import type { EventEmitter } from 'node:events';
import {
  ServerCaptureAuthority,
  type CaptureAuthorityContext,
  type CaptureAuthorityTransport,
} from './capture-authority.js';

async function json(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  let cancellation: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  const cancel = () => {
    cancellation ??= Promise.resolve()
      .then(() => reader?.cancel())
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    return cancellation;
  };
  const abort = () => {
    void cancel();
  };
  signal.addEventListener('abort', abort, { once: true });
  const current = () => {
    if (signal.aborted) throw new Error('Capture authority request ended.');
  };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    current();
    if (
      !response.ok ||
      response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
        'application/json' ||
      !reader
    )
      throw new Error('Capture authority request failed.');
    while (true) {
      const result = await reader.read();
      current();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 8192) throw new Error('Capture authority response exceeded its limit.');
      chunks.push(result.value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
  } catch (error) {
    // The authority bounds logical waiting; native admission stays held through cancellation.
    const cleanup = await cancel();
    if (!cleanup.ok)
      throw new AggregateError(
        [error, cleanup.error],
        'Capture authority response cleanup failed.',
        { cause: error },
      );
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader?.releaseLock();
  }
}
export function sessionCaptureTransport(
  session: Pick<Session, 'fetch'>,
  origin: string,
): CaptureAuthorityTransport {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Invalid capture authority origin.');
  let csrf: string | undefined;
  return async (operation, body, signal) => {
    if (
      ![
        'prepare',
        'check',
        'consume',
        'cancel',
        'handoff',
        'publication-check',
        'publication-cancel',
      ].includes(operation)
    )
      throw new Error('Invalid capture authority operation.');
    if (operation === 'prepare') {
      csrf = undefined;
      const auth = (await json(
        await session.fetch(origin + '/api/auth/me', {
          credentials: 'include',
          redirect: 'error',
          cache: 'no-store',
          signal,
        }),
        signal,
      )) as { user?: { status?: string }; csrfToken?: string };
      if (signal.aborted) throw new Error('Capture authority request ended.');
      if (
        auth.user?.status !== 'approved' ||
        typeof auth.csrfToken !== 'string' ||
        !/^[a-f0-9]{64}$/.test(auth.csrfToken)
      )
        throw new Error('Capture session is unavailable.');
      csrf = auth.csrfToken;
    }
    if (!csrf) throw new Error('Capture session is unavailable.');
    if (signal.aborted) throw new Error('Capture authority request ended.');
    return json(
      await session.fetch(origin + '/api/screen/capture/' + operation, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(body),
      }),
      signal,
    );
  };
}
export function createSessionCaptureAuthority(options: {
  owner: BrowserWindow;
  session: Session;
  origin: string;
  context: () => CaptureAuthorityContext | null;
  onError: (code: string) => void;
  shutdown?: Pick<EventEmitter, 'on' | 'removeListener'>;
}) {
  const { owner, session, shutdown } = options,
    contents = owner.webContents;
  if (contents.session !== session)
    throw new Error('Capture authority session does not own the window.');
  const authority = new ServerCaptureAuthority({
    context: options.context,
    transport: sessionCaptureTransport(session, options.origin),
    onError: options.onError,
  });
  const invalidate = () => authority.invalidate();
  const cookie = (_event: unknown, value: Cookie) => {
    if (value.name === 'tricord_session') invalidate();
  };
  const dispose = () => {
    const cleanup = authority.dispose();
    contents.removeListener('did-start-navigation', invalidate);
    contents.removeListener('render-process-gone', invalidate);
    owner.removeListener('closed', dispose);
    session.cookies.removeListener('changed', cookie);
    shutdown?.removeListener('before-quit', invalidate);
    shutdown?.removeListener('will-quit', dispose);
    return cleanup;
  };
  contents.on('did-start-navigation', invalidate);
  contents.on('render-process-gone', invalidate);
  owner.once('closed', dispose);
  session.cookies.on('changed', cookie);
  shutdown?.on('before-quit', invalidate);
  shutdown?.on('will-quit', dispose);
  return Object.freeze({
    prepare: authority.prepare.bind(authority),
    handoff: authority.handoff.bind(authority),
    inspectPublication: authority.inspectPublication.bind(authority),
    inspect: authority.inspect.bind(authority),
    verify: authority.verify.bind(authority),
    onInvalidated: authority.onInvalidated.bind(authority),
    invalidate,
    dispose,
  });
}
