// Sanitized protocol fixture: no captured screen, device labels or real network addresses.
export function screenSdp(type: 'offer' | 'answer', sound = true, ufrag = 'test') {
  const media = (kind: string, mid: number) => [
    `m=${kind} 9 UDP/TLS/RTP/SAVPF ${kind === 'video' ? 96 : 111}`,
    'c=IN IP4 0.0.0.0',
    `a=mid:${mid}`,
    `a=ice-ufrag:${ufrag}`,
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'),
    'a=setup:' + (type === 'offer' ? 'actpass' : 'active'),
    'a=' + (type === 'offer' ? 'sendonly' : 'recvonly'),
    'a=rtcp-mux',
    kind === 'video' ? 'a=rtpmap:96 VP8/90000' : 'a=rtpmap:111 opus/48000/2',
  ];
  return [
    'v=0',
    'o=- 1 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE ' + (sound ? '0 1' : '0'),
    ...media('video', 0),
    ...(sound ? media('audio', 1) : []),
    '',
  ].join('\r\n');
}
export const screenIce = {
  candidate:
    'candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host generation 0 ufrag test network-cost 999',
  sdpMid: '0',
  sdpMLineIndex: 0,
  usernameFragment: 'test',
};
