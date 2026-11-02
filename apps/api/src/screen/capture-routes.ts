import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/service.js';
import { HttpError } from '../auth/validation.js';
import type { VoiceService } from '../voice/service.js';
import type { CaptureAuthorizationService } from './capture-authorization.js';

export function registerCaptureAuthorization(
  app: FastifyInstance,
  voice: VoiceService | undefined,
  capture: CaptureAuthorizationService | undefined,
  limits: boolean,
) {
  app.addHook('preHandler', async () => {
    if (!voice || !capture) throw new HttpError(503, 'Capture authorization is unavailable.');
  });
  const options = {
    config: { rateLimit: limits ? { max: 900, timeWindow: 60000 } : (false as const) },
  };
  app.post('/api/screen/capture/prepare', options, async (req) =>
    capture!.prepare(req.cookies[SESSION_COOKIE] ?? '', req.body, req.headers['x-csrf-token']),
  );
  app.post('/api/screen/capture/check', options, async (req) =>
    capture!.verify(req.cookies[SESSION_COOKIE] ?? '', req.body, req.headers['x-csrf-token']),
  );
  app.post('/api/screen/capture/consume', options, async (req) =>
    capture!.verify(req.cookies[SESSION_COOKIE] ?? '', req.body, req.headers['x-csrf-token'], true),
  );
  app.post('/api/screen/capture/cancel', options, async (req) =>
    capture!.cancel(req.cookies[SESSION_COOKIE] ?? '', req.body, req.headers['x-csrf-token']),
  );
}
