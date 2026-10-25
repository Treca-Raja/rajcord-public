import { createDatabase } from '../db/client.js';
import { RoomServiceClient } from 'livekit-server-sdk';
import { voiceConfig } from './config.js';

export async function checkVoiceTestServices() {
  const source = process.env.DATABASE_URL;
  if (!source)
    throw new Error('Database configuration is missing. From F:\\tricord, run pnpm db:setup.');
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error('DATABASE_URL is invalid. Check apps/api/.env.');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Voice tests require loopback PostgreSQL.');
  const database = createDatabase(source);
  try {
    await database.pool.query('SELECT 1');
  } catch {
    throw new Error(
      'PostgreSQL is unavailable. Start Docker Desktop, then run pnpm db:up from F:\\tricord. If it is already running, check apps/api/.env against the existing database configuration.',
    );
  } finally {
    await database.pool.end();
  }
  const config = voiceConfig();
  if (!config)
    throw new Error(
      'Voice is not configured. From F:\\tricord, run pnpm voice:setup and pnpm voice:up.',
    );
  try {
    await new RoomServiceClient(config.url, config.key, config.secret, {
      requestTimeout: 3,
    }).listRooms();
  } catch {
    throw new Error(
      'LiveKit is unavailable or its credentials do not match. Start Docker Desktop, then run pnpm voice:up from F:\\tricord. Preserve your existing infrastructure/.env.voice.',
    );
  }
  return config;
}
