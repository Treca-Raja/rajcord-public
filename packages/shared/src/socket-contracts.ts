import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const id = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const text = Type.String();
const revision = Type.Integer({ minimum: 0 });
const sequence = Type.String({ pattern: '^(0|[1-9]\\d*)$' });
const object = (properties: Record<string, TSchema>) =>
  Type.Object(properties, { additionalProperties: false });
const optional = (schema: TSchema) => Type.Optional(schema);
const nullable = (schema: TSchema) => Type.Union([schema, Type.Null()]);
const oneOf = <const T extends readonly (string | number | boolean)[]>(...values: T) =>
  Type.Union(values.map((value) => Type.Literal(value)) as unknown as [TSchema, ...TSchema[]]);
const resolution = oneOf(480, 720, 1080);
const frameRate = oneOf(15, 30, 60);
const videoBitrate = nullable(oneOf(2000000, 4000000, 6000000, 8000000, 12000000, 20000000));
const quality = {
  profile: oneOf('low', 'auto', 'high', 'smooth', 'ultra'),
  videoBitrate,
  resolution: optional(resolution),
  frameRate: optional(frameRate),
};
const boundedRequest = object({ epoch: id });
const socketIce = object({
  candidate: text,
  sdpMid: text,
  sdpMLineIndex: Type.Integer({ minimum: 0 }),
  usernameFragment: text,
});

const clientPayloads: Record<string, TSchema | undefined> = {
  'connection:ping': undefined,
  'presence:snapshot': undefined,
  'conversation:join': object({ conversationId: id }),
  'conversation:read': object({ conversationId: id, seq: sequence }),
  'message:send': object({
    conversationId: id,
    clientId: id,
    body: text,
    replyToId: optional(nullable(id)),
  }),
  'screen:bind': object({ version: Type.Literal(2), leaseId: id, requestId: id }),
  'screen:publish': object({
    ...quality,
    epoch: id,
    requestId: id,
    sourceGeneration: Type.Integer({ minimum: 1 }),
    sound: oneOf('none', 'tab', 'system'),
  }),
  'screen:stop': object({ epoch: id, shareId: id }),
  'screen:select': object({
    ...quality,
    epoch: id,
    requestId: id,
    revision,
    shareId: nullable(id),
    mode: optional(oneOf('replace', 'add', 'remove', 'clear')),
    removeShareId: optional(id),
  }),
  'screen:renew': object({ epoch: id, requestId: id, revision }),
  'screen:directory': boundedRequest,
  'screen:signal': object({
    epoch: id,
    linkId: id,
    revision,
    sequence: Type.Integer({ minimum: 1 }),
    payload: Type.Union([
      object({ type: Type.Literal('offer'), sdp: text }),
      object({ type: Type.Literal('answer'), sdp: text }),
      object({ type: Type.Literal('ice'), candidate: socketIce }),
    ]),
  }),
};

/** Validate the Socket.IO event arguments before any feature listener can run. */
export function validateClientSocketPacket(event: unknown, args: readonly unknown[]): boolean {
  if (typeof event !== 'string' || !Object.hasOwn(clientPayloads, event)) return false;
  const payload = clientPayloads[event];
  if (args.length !== (payload ? 2 : 1) || typeof args.at(-1) !== 'function') return false;
  return payload === undefined || Value.Check(payload, args[0]);
}

export function invalidClientSocketAck(event: string): unknown {
  if (event.startsWith('screen:'))
    return { ok: false, code: 'invalid', error: 'Invalid screen request.' };
  if (event === 'connection:ping') return { ok: false };
  return { ok: false, status: 400, error: 'Invalid socket request.' };
}
