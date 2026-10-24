import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
export type VoiceConfig = { url: string; key: string; secret: string; prefix?: string };
export function voiceConfig(): VoiceConfig | undefined {
  const path = fileURLToPath(new URL('../../../../infrastructure/.env.voice', import.meta.url));
  if (existsSync(path)) loadEnvFile(path);
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
  if (!url && !key && !secret) return undefined;
  if (!url || !key || !secret || secret.length < 32)
    throw new Error('Incomplete voice configuration.');
  const target = new URL(url);
  if (target.origin !== url || target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
    throw new Error('This voice milestone supports only a loopback LiveKit service.');
  return { url, key, secret };
}
