import type { FastifyInstance, FastifyRequest } from 'fastify';
import { approved, identity, equal, SESSION_COOKIE } from '../auth/service.js';
import { HttpError } from '../auth/validation.js';
import type { VoiceService } from './service.js';
export function registerVoice(app: FastifyInstance, voice: VoiceService | undefined) {
  const token = (req: FastifyRequest) => req.cookies[SESSION_COOKIE] ?? '';
  const get = () => {
    if (!voice) throw new HttpError(503, 'Voice is not configured. Run the local voice setup.');
    return voice;
  };
  app.addHook('preHandler', async (req) => {
    const service = get();
    const auth = approved(await identity(service.pool, token(req)));
    if (req.method !== 'GET' && !equal(req.headers['x-csrf-token'], auth.csrfToken))
      throw new HttpError(403, 'Invalid CSRF token.');
  });
  app.get('/api/voice/channels', async (req) => ({ channels: await get().channels(token(req)) }));
  app.post('/api/voice/channels', async (req, reply) =>
    reply.code(201).send({ channel: await get().create(token(req), req.body) }),
  );
  app.post('/api/voice/join', async (req) => get().join(token(req), req.body));
  app.post('/api/voice/heartbeat', async (req) => get().heartbeat(token(req), req.body));
  app.post('/api/voice/leave', async (req) => get().leave(token(req), req.body));
}
