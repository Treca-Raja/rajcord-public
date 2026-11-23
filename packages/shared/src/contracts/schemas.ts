import {
  FormatRegistry,
  Type,
  type TLiteral,
  type TProperties,
  type TSchema,
} from '@sinclair/typebox';
import {
  NATIVE_VIEWER_GRANT_BATCH_SIZE,
  NATIVE_VIEWER_GRANT_VERSION,
} from '../capture-authorization.js';

if (!FormatRegistry.Has('date-time'))
  FormatRegistry.Set(
    'date-time',
    (value) =>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
      Number.isFinite(Date.parse(value)),
  );

export const object = <const T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: true });
export const requestObject = <const T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const text = Type.String();
export const nonempty = Type.String({ minLength: 1 });
export const count = Type.Integer({ minimum: 0 });
export const sequence = Type.String({ pattern: '^(0|[1-9]\\d*)$' });
export const date = Type.String({ format: 'date-time' });
export const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
export const optional = <T extends TSchema>(schema: T) => Type.Optional(schema);
export const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const literal = <const T extends string | number | boolean>(value: T) => Type.Literal(value);
export const array = <T extends TSchema>(schema: T) => Type.Array(schema);
export const oneOf = <const T extends readonly (string | number | boolean)[]>(...values: T) =>
  Type.Union(
    values.map((value) => literal(value)) as unknown as [
      TLiteral<T[number]>,
      ...TLiteral<T[number]>[],
    ],
  );

export const accountStatus = oneOf('pending', 'approved', 'rejected', 'suspended', 'removed');
export const user = object({
  id: nonempty,
  username: nonempty,
  displayName: text,
  status: accountStatus,
  isOwner: Type.Boolean(),
});
export const auth = object({
  user,
  csrfToken: nonempty,
  expiresAt: date,
  remember: Type.Boolean(),
});
export const category = object({ id: nonempty, name: text, position: count, revision: sequence });
export const conversation = object({
  id: nonempty,
  kind: oneOf('channel', 'dm', 'group'),
  name: text,
  archived: Type.Boolean(),
  topic: text,
  category: nullable(category),
  position: count,
  metadataRevision: sequence,
  unreadCount: count,
  mentionCount: count,
  lastReadSeq: sequence,
  activity: sequence,
  managerId: nullable(nonempty),
  members: array(
    object({
      id: nonempty,
      username: nonempty,
      displayName: text,
      status: accountStatus,
    }),
  ),
});
export const author = object({ id: nonempty, username: nonempty, displayName: text });
export const reference = Type.Union([
  object({ available: literal(false) }),
  object({
    available: literal(true),
    id: nonempty,
    seq: sequence,
    change: sequence,
    author,
    body: nullable(text),
    deleted: Type.Boolean(),
  }),
]);
export const messageFields = {
  id: nonempty,
  conversationId: nonempty,
  clientId: nonempty,
  seq: sequence,
  change: sequence,
  author,
  body: nullable(text),
  createdAt: date,
  editedAt: nullable(date),
  deleted: Type.Boolean(),
};
export const message = Type.Union([
  object({ ...messageFields, featureVersion: optional(Type.Never()) }),
  object({
    ...messageFields,
    featureVersion: oneOf(1, 2),
    contextChange: sequence,
    replyTo: nullable(reference),
    threadRoot: nullable(reference),
    replyCount: count,
    pinned: Type.Boolean(),
    reactions: array(object({ emoji: nonempty, count, mine: Type.Boolean() })),
    mentions: array(object({ id: nonempty, username: nonempty })),
  }),
]);
export const messagePage = object({
  messages: array(message),
  nextBefore: nullable(sequence),
  change: sequence,
  hasMore: Type.Boolean(),
});
export const messageResult = object({ message });
export const alertMode = oneOf('all', 'mentions', 'muted');
export const gifProvider = oneOf('giphy', 'tenor', 'klipy');
export const errorResponse = object({ error: text });
export const ok = object({ ok: literal(true) });
export const cancelled = object({ cancelled: literal(true) });
export const capture = object({ id: nonempty, remainingMs: Type.Number({ minimum: 0 }) });
export const publicationCheck = object({
  ...capture.properties,
  native: optional(
    object({
      viewers: Type.Array(
        object({
          id: uuid,
          remainingMs: count,
          answerHash: nullable(Type.String({ pattern: '^[0-9a-f]{64}$' })),
        }),
        { maxItems: NATIVE_VIEWER_GRANT_BATCH_SIZE },
      ),
      iceServers: Type.Array(
        object({ urls: array(nonempty), username: optional(text), credential: optional(text) }),
        { maxItems: 4 },
      ),
    }),
  ),
});
export const voiceJoin = object({
  id: nonempty,
  channelId: nonempty,
  credential: nonempty,
  useServerIceServers: optional(Type.Boolean()),
});
export const pageQuery = requestObject({ before: optional(text), limit: optional(text) });

export const request = {
  authRegister: requestObject({ username: text, displayName: text, password: text }),
  authLogin: requestObject({
    username: text,
    password: text,
    remember: optional(Type.Boolean()),
    deviceLabel: optional(text),
  }),
  account: requestObject({ displayName: text }),
  password: requestObject({ currentPassword: text, newPassword: text }),
  passwordReset: requestObject({ username: text, code: text, newPassword: text }),
  passwordRecovery: requestObject({ currentPassword: text }),
  adminAccount: requestObject({
    action: oneOf('approve', 'reject', 'suspend', 'remove', 'restore'),
  }),
  ownerTransfer: requestObject({ userId: uuid }),
  categoryCreate: requestObject({ name: text, position: optional(Type.Integer()) }),
  categoryUpdate: requestObject({
    name: optional(text),
    position: optional(Type.Integer()),
    expectedRevision: sequence,
  }),
  conversationCreate: requestObject({
    kind: oneOf('channel', 'dm', 'group'),
    name: optional(text),
    userId: optional(uuid),
    userIds: optional(array(uuid)),
    topic: optional(text),
    categoryId: optional(nullable(uuid)),
    position: optional(Type.Integer()),
  }),
  conversationUpdate: requestObject({
    name: optional(text),
    archived: optional(Type.Boolean()),
    topic: optional(text),
    categoryId: optional(nullable(uuid)),
    position: optional(Type.Integer()),
    expectedRevision: optional(sequence),
  }),
  read: requestObject({ seq: sequence }),
  invite: requestObject({ userId: uuid }),
  invitation: requestObject({ accept: Type.Boolean() }),
  membership: requestObject({
    action: oneOf('leave', 'remove', 'transfer'),
    userId: optional(uuid),
  }),
  messageSend: requestObject({
    body: text,
    clientId: uuid,
    replyToId: optional(nullable(uuid)),
  }),
  messageEdit: requestObject({ body: text }),
  reaction: requestObject({ emoji: text }),
  conversationPreference: requestObject({ mode: nullable(alertMode) }),
  senderPreference: Type.Union([
    requestObject({ muted: Type.Boolean() }),
    requestObject({ priority: Type.Boolean() }),
    requestObject({ muted: Type.Boolean(), priority: Type.Boolean() }),
  ]),
  gifSearch: requestObject({ provider: gifProvider, query: text, cursor: optional(text) }),
  voiceChannel: requestObject({ name: text }),
  voiceJoin: requestObject({ channelId: uuid, leaseId: optional(uuid) }),
  voiceLease: requestObject({ leaseId: uuid }),
  capturePrepare: requestObject({
    requestId: uuid,
    sound: oneOf('none', 'system', 'application', 'source'),
    epoch: uuid,
  }),
  captureVerify: requestObject({ id: uuid }),
  captureCancel: requestObject({ requestId: uuid }),
  captureHandoff: requestObject({
    id: uuid,
    epoch: uuid,
    shareId: uuid,
    sourceGeneration: Type.Integer({ minimum: 1 }),
    requestId: uuid,
    nativeViewers: optional(literal(NATIVE_VIEWER_GRANT_VERSION)),
  }),
  publicationCheck: requestObject({
    nativeViewers: optional(literal(1)),
    id: uuid,
    requestId: uuid,
    revision: Type.Integer({ minimum: 1 }),
  }),
  publicationCancel: requestObject({ id: uuid }),
};
