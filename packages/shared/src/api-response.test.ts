import { expect, it } from 'vitest';
import {
  InvalidApiRequestError,
  InvalidApiResponseError,
  validateApiRequest,
  validateApiResponse,
} from './api-response.js';
import type { ApiRequestBodyFor, ApiResponseFor } from './api-response.js';

const user = {
  id: 'friend',
  username: 'friend',
  displayName: 'Friend',
  status: 'approved',
  isOwner: false,
};
const auth = {
  user,
  csrfToken: 'fixture-only',
  expiresAt: '2030-01-01T00:00:00.000Z',
  remember: false,
};
const message = {
  id: 'message',
  conversationId: 'conversation',
  clientId: 'attempt',
  seq: '1',
  change: '2',
  author: { id: 'friend', username: 'friend', displayName: 'Friend' },
  body: 'Synthetic fixture',
  createdAt: '2026-01-01T00:00:00.000Z',
  editedAt: null,
  deleted: false,
};
const modern = {
  ...message,
  featureVersion: 2,
  contextChange: '2',
  replyTo: null,
  threadRoot: null,
  replyCount: 0,
  pinned: false,
  reactions: [],
  mentions: [],
};

it('accepts verified authentication shapes and forward-compatible additional fields', () => {
  expect(() =>
    validateApiResponse('/auth/me', 'GET', { ...auth, futureField: true }),
  ).not.toThrow();
  expect(() => validateApiResponse('/auth/login', 'POST', auth)).not.toThrow();
});
it.each([
  null,
  [],
  {},
  { ...auth, user: { ...user, status: 'unexpected' } },
  { ...auth, csrfToken: '' },
  { ...auth, expiresAt: 'not a date' },
  { ...auth, remember: 'false' },
  { ...auth, user: { ...user, isOwner: 'true' } },
])('rejects malformed authentication before state can use it: %j', (value) => {
  expect(() => validateApiResponse('/auth/me', 'GET', value)).toThrow(InvalidApiResponseError);
});
it('supports both historical and current message payloads', () => {
  for (const value of [message, modern])
    expect(() =>
      validateApiResponse('/conversations/c/messages/m', 'GET', { message: value }),
    ).not.toThrow();
});
it.each([
  { ...modern, seq: 'NaN' },
  { ...modern, change: '-1' },
  { ...modern, contextChange: 3 },
  { ...modern, reactions: [{ emoji: '👍', count: -1, mine: false }] },
  { ...modern, replyTo: { available: true } },
  { ...modern, featureVersion: 9 },
  { ...modern, author: null },
  { ...modern, mentions: null },
])('rejects malformed nested messages and unsafe ordering values: %j', (value) => {
  expect(() =>
    validateApiResponse('/conversations/c/messages', 'POST', { message: value }),
  ).toThrow(InvalidApiResponseError);
});
it('validates pagination and query-bearing routes without changing the data', () => {
  const value = { messages: [modern], nextBefore: null, change: '2', hasMore: false };
  expect(() =>
    validateApiResponse('/conversations/c/messages?before=20', 'GET', value),
  ).not.toThrow();
  expect(value.messages[0]).toBe(modern);
  expect(() =>
    validateApiResponse('/conversations/c/messages', 'GET', { ...value, hasMore: 'false' }),
  ).toThrow();
  expect(() =>
    validateApiResponse('/conversations/c/messages', 'GET', { ...value, messages: {} }),
  ).toThrow();
});
it('validates request bodies, query strings, and route-method pairs', () => {
  expect(() =>
    validateApiRequest('/auth/login', 'POST', {
      username: 'friend',
      password: 'fixture-only',
      remember: false,
    }),
  ).not.toThrow();
  expect(() =>
    validateApiRequest('/auth/login', 'POST', {
      username: 'friend',
      password: 'fixture-only',
      unrecognized: 'private-fixture',
    }),
  ).toThrow(InvalidApiRequestError);
  expect(() =>
    validateApiRequest('/conversations/c/messages?limit=50', 'GET', undefined),
  ).not.toThrow();
  expect(() =>
    validateApiRequest('/conversations/c/messages?unrecognized=value', 'GET', undefined),
  ).toThrow(InvalidApiRequestError);
  expect(() => validateApiRequest('/auth/login', 'GET', undefined)).toThrow(InvalidApiRequestError);
});
it('validates voice credentials and concrete participant shapes', () => {
  expect(() =>
    validateApiResponse('/voice/join', 'POST', {
      id: 'lease',
      channelId: 'room',
      credential: 'fixture-only',
      useServerIceServers: false,
    }),
  ).not.toThrow();
  expect(() =>
    validateApiResponse('/voice/join', 'POST', { id: 'lease', channelId: 'room' }),
  ).toThrow();
  expect(() =>
    validateApiResponse('/voice/channels', 'GET', {
      channels: [{ id: 'room', name: 'Lounge', participants: [{ id: 'friend', name: 'Friend' }] }],
    }),
  ).not.toThrow();
  expect(() => validateApiResponse('/voice/channels', 'GET', { channels: [null] })).toThrow();
});
it('derives compile-time request and response types from the wire schemas', () => {
  const login: ApiRequestBodyFor<'/auth/login', 'POST'> = {
    username: 'friend',
    password: 'fixture-only',
    remember: false,
  };
  const verified: ApiResponseFor<'/auth/me', 'GET'> = {
    ...auth,
    user: { ...user, status: 'approved' },
  };
  expect(login.username).toBe('friend');
  expect(verified.user.status).toBe('approved');
});
it('requires new endpoints and methods to declare a response contract', () => {
  for (const [path, method] of [
    ['/future', 'GET'],
    ['/auth/me', 'DELETE'],
  ])
    expect(() => validateApiResponse(path!, method!, { ok: true })).toThrow(
      InvalidApiResponseError,
    );
});
it('never includes response contents or credentials in a validation error', () => {
  try {
    validateApiResponse('/auth/me', 'GET', { csrfToken: 'private-fixture' });
  } catch (cause) {
    expect(cause).toBeInstanceOf(InvalidApiResponseError);
    expect(String(cause)).not.toContain('private-fixture');
    return;
  }
  throw new Error('Expected validation failure');
});
