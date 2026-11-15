import * as s from './schemas.js';
import { contract } from './route.js';

export const voiceContracts = [
  contract(
    'GET',
    '/voice/channels',
    s.object({
      channels: s.array(
        s.object({
          id: s.nonempty,
          name: s.text,
          participants: s.array(s.object({ id: s.nonempty, name: s.text })),
        }),
      ),
    }),
  ),
  contract(
    'POST',
    '/voice/channels',
    s.object({ channel: s.object({ id: s.nonempty, name: s.text }) }),
    {
      body: s.request.voiceChannel,
      status: 201,
    },
  ),
  contract('POST', '/voice/join', s.voiceJoin, { body: s.request.voiceJoin }),
  contract('POST', '/voice/heartbeat', s.ok, { body: s.request.voiceLease }),
  contract('POST', '/voice/leave', s.ok, { body: s.request.voiceLease }),
] as const;
