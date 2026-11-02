import type { ScreenIce, ScreenSignal, ScreenLinkRequest } from './screen.js';
export class ScreenSignalingError extends Error {}
export type ScreenAddress = (value: string) => boolean;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
function input(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ScreenSignalingError('Invalid request.');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new ScreenSignalingError('Unexpected request field.');
  return body;
}
function uuid(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new ScreenSignalingError('Invalid identifier.');
  return value.toLowerCase();
}
export function parseScreenReference(value: unknown): ScreenLinkRequest {
  const body = input(value, ['epoch', 'linkId']);
  return { epoch: uuid(body.epoch), linkId: uuid(body.linkId) };
}
// Browser-side direct-address validation. The API supplies its existing node:net validator.
function screenAddress(value: string) {
  if (/^[a-zA-Z0-9-]{1,63}\.local$/.test(value)) return true;
  const parts = value.split('.');
  if (
    parts.length === 4 &&
    parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
  )
    return true;
  if (!value.includes(':') || /[^0-9a-f:.]/i.test(value)) return false;
  try {
    return new URL('http://[' + value + ']').hostname.startsWith('[');
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}
const invalid = () => new ScreenSignalingError('Invalid screen signaling envelope.');
export function screenPositive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}
function bounded(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || byteLength(value) > max || !value.length)
    throw invalid();
  return value;
}
export function parseScreenIce(value: unknown, address: ScreenAddress = screenAddress): ScreenIce {
  const b = input(value, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']);
  const candidate = bounded(b.candidate, 2048);
  const parts = candidate.split(' ');
  if (
    !/^candidate:[a-zA-Z0-9+/]{1,32}$/.test(parts[0] ?? '') ||
    !['1', '2'].includes(parts[1]!) ||
    !/^(udp|tcp)$/i.test(parts[2] ?? '') ||
    !/^\d{1,10}$/.test(parts[3] ?? '') ||
    Number(parts[3]) > 4294967295 ||
    !address(parts[4] ?? '') ||
    !/^\d{1,5}$/.test(parts[5] ?? '') ||
    Number(parts[5]) > 65535 ||
    parts[6] !== 'typ' ||
    !['host', 'srflx', 'prflx'].includes(parts[7]!) ||
    (parts.length - 8) % 2 !== 0
  )
    throw invalid();
  const seen = new Set<string>();
  for (let i = 8; i < parts.length; i += 2) {
    const key = parts[i]!,
      v = parts[i + 1]!;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    if (
      !(key === 'raddr'
        ? address(v)
        : key === 'rport'
          ? /^\d{1,5}$/.test(v) && Number(v) <= 65535
          : key === 'tcptype'
            ? ['active', 'passive', 'so'].includes(v)
            : ['generation', 'network-id', 'network-cost'].includes(key)
              ? /^\d{1,10}$/.test(v)
              : key === 'ufrag'
                ? v === b.usernameFragment
                : false)
    )
      throw invalid();
  }
  if (
    typeof b.sdpMid !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,16}$/.test(b.sdpMid) ||
    !Number.isInteger(b.sdpMLineIndex) ||
    (b.sdpMLineIndex !== 0 && b.sdpMLineIndex !== 1) ||
    typeof b.usernameFragment !== 'string' ||
    !/^[a-zA-Z0-9+/]{4,256}$/.test(b.usernameFragment)
  )
    throw invalid();
  return {
    candidate,
    sdpMid: b.sdpMid,
    sdpMLineIndex: b.sdpMLineIndex,
    usernameFragment: b.usernameFragment,
  };
}
export type ScreenDescription = {
  mids: string[];
  ufrags: string[];
  kinds: string[];
  candidates: number;
};
export function parseScreenDescription(
  sdp: string,
  type: 'offer' | 'answer',
  address: ScreenAddress = screenAddress,
): ScreenDescription {
  bounded(sdp, 12 * 1024);
  if (!sdp.endsWith('\r\n') || /[^\x20-\x7e\r\n]/.test(sdp)) throw invalid();
  const lines = sdp.slice(0, -2).split('\r\n');
  if (lines.some((l) => !/^[a-z]=[^\r\n]*$/.test(l) || l.length > 2048) || lines[0] !== 'v=0')
    throw invalid();
  const sections: string[][] = [[]];
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push([]);
    sections.at(-1)!.push(line);
  }
  const session = sections.shift()!;
  const one = (rows: string[], prefix: string) => {
    const matches = rows.filter((l) => l.startsWith(prefix));
    if (matches.length !== 1) throw invalid();
    return matches[0]!.slice(prefix.length);
  };
  one(session, 'o=');
  one(session, 's=');
  one(session, 't=');
  if (
    session.some((l) => /^a=(sendonly|recvonly|sendrecv|inactive|candidate:)/.test(l)) ||
    sections.length < 1 ||
    sections.length > 2
  )
    throw invalid();
  const mids: string[] = [],
    ufrags: string[] = [],
    kinds: string[] = [];
  let candidates = 0,
    videos = 0;
  for (const rows of sections) {
    if (!/^m=(video|audio) \d{1,5} UDP\/TLS\/RTP\/SAVPF(?: \d{1,3})+$/.test(rows[0]!))
      throw invalid();
    if (rows[0]!.startsWith('m=video')) videos++;
    kinds.push(rows[0]!.split(' ')[0]!);
    const mid = one(rows, 'a=mid:');
    if (!/^[a-zA-Z0-9_-]{1,16}$/.test(mid) || mids.includes(mid)) throw invalid();
    mids.push(mid);
    const inherited = (prefix: string) =>
      one(rows.some((l) => l.startsWith(prefix)) ? rows : session, prefix);
    const ufrag = inherited('a=ice-ufrag:');
    if (
      !/^[a-zA-Z0-9+/]{4,256}$/.test(ufrag) ||
      !/^[a-zA-Z0-9+/]{22,256}$/.test(inherited('a=ice-pwd:')) ||
      !/^sha-256 (?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(inherited('a=fingerprint:')) ||
      !(type === 'offer' ? ['actpass'] : ['active', 'passive']).includes(inherited('a=setup:')) ||
      rows.filter((l) => /^a=(sendonly|recvonly|sendrecv|inactive)$/.test(l)).join() !==
        (type === 'offer' ? 'a=sendonly' : 'a=recvonly') ||
      !rows.includes('a=rtcp-mux')
    )
      throw invalid();
    ufrags.push(ufrag);
    for (const line of rows.filter((l) => l.startsWith('a=candidate:'))) {
      parseScreenIce(
        {
          candidate: line.slice(2),
          sdpMid: mid,
          sdpMLineIndex: mids.length - 1,
          usernameFragment: ufrag,
        },
        address,
      );
      candidates++;
    }
  }
  if (
    videos !== 1 ||
    candidates > 128 ||
    one(session, 'a=group:BUNDLE ').split(' ').join() !== mids.join()
  )
    throw invalid();
  return { mids, ufrags, kinds, candidates };
}
export function parseScreenSignal(
  value: unknown,
  address: ScreenAddress = screenAddress,
): ScreenSignal {
  const b = input(value, ['epoch', 'linkId', 'revision', 'sequence', 'payload']);
  const p = input(b.payload, ['type', 'sdp', 'candidate']);
  let payload: ScreenSignal['payload'];
  if (p.type === 'offer' || p.type === 'answer') {
    if (Object.keys(p).sort().join() !== 'sdp,type') throw invalid();
    const sdp = bounded(p.sdp, 12288);
    parseScreenDescription(sdp, p.type, address);
    payload = { type: p.type, sdp };
  } else if (p.type === 'ice') {
    if (Object.keys(p).sort().join() !== 'candidate,type') throw invalid();
    payload = { type: 'ice', candidate: parseScreenIce(p.candidate, address) };
  } else throw invalid();
  const result = {
    epoch: uuid(b.epoch),
    linkId: uuid(b.linkId),
    revision: screenPositive(b.revision),
    sequence: screenPositive(b.sequence),
    payload,
  };
  if (byteLength(JSON.stringify(result)) > 15360) throw invalid();
  return result;
}
