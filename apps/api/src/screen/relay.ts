import { createHash } from 'node:crypto';
import type { ScreenIceServer } from '@tricord/shared';
import type { VoiceConfig } from '../voice/config.js';

// LiveKit 1.13.10 uses jxskiss' bit-packed base62, not integer radix-62.
// Wire references: pkg/service/turn.go and github.com/jxskiss/base62.
export function livekitBase62(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let bits = bytes.length * 8;
  let value = bytes.reduce((n, byte) => (n << 8n) | BigInt(byte), 0n);
  let encoded = '';
  while (bits > 0) {
    let digit = Number(value & 63n);
    const compact = (digit & 30) === 30;
    const width = compact && (bits > 6 || digit > 31) ? 5 : 6;
    if (compact) digit &= 31;
    encoded += alphabet[digit];
    value >>= BigInt(width);
    bits -= width;
  }
  return encoded;
}

export function screenRelayServers(
  config: VoiceConfig,
  accountId: string,
  now: number,
): ScreenIceServer[] | undefined {
  if (!config.screenTurnHost) return;
  // Stable account identity shares the relay's per-user quota across bindings.
  const participant = 'SC_' + accountId;
  const expiry = Math.floor(now / 1000) + 60;
  const username = livekitBase62(Buffer.from(`${config.key}|${participant}|${expiry}`));
  const credential = livekitBase62(
    createHash('sha256').update(`${config.secret}|${participant}|${expiry}`).digest(),
  );
  return [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: [
        `turn:${config.screenTurnHost}:3478?transport=udp`,
        `turns:${config.screenTurnHost}:5349?transport=tcp`,
      ],
      username,
      credential,
    },
  ];
}
