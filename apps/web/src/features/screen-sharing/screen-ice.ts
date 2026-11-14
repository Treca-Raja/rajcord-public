import type { ScreenIceServer } from '@tricord/shared';
// Screen ICE is independent of microphone voice; relay credentials come only from the authenticated screen binding.
export const publicScreenIceServers = Object.freeze([
  Object.freeze({ urls: 'stun:stun.cloudflare.com:3478' }),
]);

export function screenIceServers(servers: readonly RTCIceServer[] = []): ScreenIceServer[] {
  if (!Array.isArray(servers) || servers.length > 4)
    throw new Error('Invalid screen ICE configuration.');
  return servers.map((server) => {
    if (
      !server ||
      Object.keys(server).some(
        (key) => !['urls', 'username', 'credential', 'credentialType'].includes(key),
      )
    )
      throw new Error('Invalid screen ICE configuration.');
    const credentialType = (server as RTCIceServer & { credentialType?: string }).credentialType;
    if (credentialType !== undefined && credentialType !== 'password')
      throw new Error('Invalid screen ICE credential type.');
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 4)
      throw new Error('Invalid screen ICE configuration URLs.');
    const kinds = urls.map((url) => {
      const match =
        typeof url === 'string' &&
        /^(stuns?|turns?):([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):([0-9]{1,5})(?:\?transport=(udp|tcp))?$/.exec(
          url,
        );
      if (
        !match ||
        Number(match[3]) < 1 ||
        Number(match[3]) > 65535 ||
        (match[1]!.startsWith('stun') && match[4]) ||
        (match[1] === 'turns' && match[4] && match[4] !== 'tcp')
      )
        throw new Error('Invalid screen ICE configuration URL.');
      return match[1]!.startsWith('turn');
    });
    const relay = kinds[0];
    if (kinds.some((kind) => kind !== relay))
      throw new Error('Mixed screen ICE credential scopes.');
    if (relay) {
      if (
        typeof server.username !== 'string' ||
        !/^[A-Za-z0-9]{8,256}$/.test(server.username) ||
        typeof server.credential !== 'string' ||
        !/^[A-Za-z0-9]{8,128}$/.test(server.credential)
      )
        throw new Error('Screen relay requires bounded ephemeral credentials.');
      return { urls: [...urls], username: server.username, credential: server.credential };
    }
    if (
      (server.username !== undefined && server.username !== '') ||
      (server.credential !== undefined && server.credential !== '')
    )
      throw new Error('STUN must not carry credentials.');
    return { urls: [...urls] };
  });
}

export function sameScreenIceServers(
  left: readonly RTCIceServer[],
  right: readonly RTCIceServer[],
) {
  return JSON.stringify(screenIceServers(left)) === JSON.stringify(screenIceServers(right));
}
