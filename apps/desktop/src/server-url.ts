export function serverUrl(env: Record<string, string | undefined>, test = false) {
  if (test) return 'http://127.0.0.1:3002';
  const dev = env.TRICORD_DEV_URL,
    remote = env.TRICORD_SERVER_URL;
  if (dev && dev !== 'http://127.0.0.1:5173')
    throw new Error('Only the local development origin is permitted.');
  if (dev) return dev;
  if (!remote) return 'http://127.0.0.1:3001';
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new Error('TRICORD_SERVER_URL must be an exact HTTPS origin.');
  }
  if (url.protocol !== 'https:' || url.origin !== remote)
    throw new Error(
      'TRICORD_SERVER_URL must be an exact HTTPS origin without credentials, a path or query.',
    );
  return url.origin;
}
