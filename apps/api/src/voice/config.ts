import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
export type VoiceConfig = {
  url: string;
  key: string;
  secret: string;
  prefix?: string;
  useServerIceServers?: boolean;
};
export function voiceConfig(): VoiceConfig | undefined {
  const path = fileURLToPath(new URL('../../../../infrastructure/.env.voice', import.meta.url));
  if (process.env.NODE_ENV !== 'production' && existsSync(path)) loadEnvFile(path);
  return parseVoiceConfig(process.env);
}
export function parseVoiceConfig(env: Record<string, string | undefined>): VoiceConfig | undefined {
  const hosted = env.NODE_ENV === 'production';
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = env;
  if (!url && !key && !secret && !hosted) return undefined;
  if (!url || !key || !secret || secret.length < 32)
    throw new Error('Incomplete voice configuration.');
  const target = new URL(url);
  if (
    target.origin !== url ||
    target.protocol !== 'http:' ||
    (target.hostname !== '127.0.0.1' && !(hosted && target.hostname === 'livekit'))
  )
    throw new Error(
      'LiveKit control must use an exact loopback HTTP origin or the private livekit Docker service in production.',
    );
  return { url, key, secret, useServerIceServers: hosted };
}
