import { expect, it } from 'vitest';
import { validateApiRequest, validateApiResponse } from './api-response.js';
import { CHAT_IMAGE_LIMITS } from './chat-image.js';
const path = '/conversations/8e73a323-b739-4c22-8501-0fb89ec05679/messages/with-attachment';
const request = {
  body: '',
  clientId: 'b357b04d-49fb-4289-9910-26f467435c37',
  attachment: { mimeType: 'image/png', base64: 'AAAA' },
};

it('accepts one image with optional text/reply while rejecting arrays, extra fields and other formats', () => {
  expect(() => validateApiRequest(path, 'POST', request)).not.toThrow();
  for (const attachment of [
    [],
    [request.attachment],
    { ...request.attachment, mimeType: 'image/svg+xml' },
    { ...request.attachment, filename: 'user-controlled' },
    { mimeType: 'image/png', base64: 1 },
  ])
    expect(() => validateApiRequest(path, 'POST', { ...request, attachment })).toThrow();
  expect(() => validateApiRequest(path, 'POST', { ...request, body: 'x'.repeat(4001) })).toThrow();
});

it('accepts bounded metadata without requiring attachments on historical message responses', () => {
  const message = {
    featureVersion: 2,
    id: 'm',
    conversationId: 'c',
    clientId: 'i',
    seq: '1',
    change: '1',
    contextChange: '1',
    author: { id: 'u', username: 'user', displayName: 'User' },
    body: '',
    createdAt: '2030-01-01T00:00:00.000Z',
    editedAt: null,
    deleted: false,
    replyTo: null,
    threadRoot: null,
    replyCount: 0,
    pinned: false,
    reactions: [],
    mentions: [],
  };
  for (const attachment of [undefined, { mimeType: 'image/png', size: CHAT_IMAGE_LIMITS.maxBytes }])
    expect(() =>
      validateApiResponse(path, 'POST', { message: { ...message, attachment } }),
    ).not.toThrow();
  for (const attachment of [
    { mimeType: 'image/png', size: 0 },
    { mimeType: 'image/jpeg', size: CHAT_IMAGE_LIMITS.maxBytes + 1 },
    { mimeType: 'application/pdf', size: 1 },
  ])
    expect(() =>
      validateApiResponse(path, 'POST', { message: { ...message, attachment } }),
    ).toThrow();
});
