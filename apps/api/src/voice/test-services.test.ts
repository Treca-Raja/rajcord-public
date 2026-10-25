import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { checkVoiceTestServices } from './test-services.js';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn(),
  rooms: vi.fn(),
  config: vi.fn(),
  credentials: { url: 'http://127.0.0.1:7880', key: 'test', secret: 'private-test-secret' },
}));
vi.mock('../db/client.js', () => ({
  createDatabase: () => ({ pool: { query: mocks.query, end: mocks.end } }),
}));
vi.mock('./config.js', () => ({ voiceConfig: mocks.config }));
vi.mock('livekit-server-sdk', () => ({
  RoomServiceClient: class {
    listRooms = mocks.rooms;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'postgresql://test:private-test-password@127.0.0.1:5432/tricord');
  mocks.query.mockResolvedValue({});
  mocks.end.mockResolvedValue(undefined);
  mocks.rooms.mockResolvedValue([]);
  mocks.config.mockReturnValue(mocks.credentials);
});
afterEach(() => vi.unstubAllEnvs());
it('checks database and authenticated media readiness without creating test data', async () => {
  expect(await checkVoiceTestServices()).toEqual(mocks.credentials);
  expect(mocks.query).toHaveBeenCalledExactlyOnceWith('SELECT 1');
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(mocks.rooms).toHaveBeenCalledOnce();
});
it('a stopped database gives startup instructions without leaking connection details', async () => {
  mocks.query.mockRejectedValue(new Error('private-test-password'));
  await expect(checkVoiceTestServices()).rejects.toThrow(
    'Start Docker Desktop, then run pnpm db:up',
  );
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(mocks.rooms).not.toHaveBeenCalled();
});
it('a stopped media server gives voice startup instructions', async () => {
  mocks.rooms.mockRejectedValue(new Error('private-test-secret'));
  await expect(checkVoiceTestServices()).rejects.toThrow('then run pnpm voice:up');
});
it('missing voice configuration gives setup instructions', async () => {
  mocks.config.mockReturnValue(undefined);
  await expect(checkVoiceTestServices()).rejects.toThrow('pnpm voice:setup and pnpm voice:up');
});
it('rejects remote databases before making a connection', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://test:password@remote.example/tricord');
  await expect(checkVoiceTestServices()).rejects.toThrow('loopback PostgreSQL');
  expect(mocks.query).not.toHaveBeenCalled();
});
