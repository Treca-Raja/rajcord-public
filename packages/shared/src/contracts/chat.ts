import { Type } from '@sinclair/typebox';
import * as s from './schemas.js';
import { contract } from './route.js';

export const chatContracts = [
  contract(
    'GET',
    '/channel-categories',
    s.object({
      categories: s.array(s.category),
      nextAfter: s.nullable(s.nonempty),
    }),
    { query: s.requestObject({ after: s.optional(s.text), limit: s.optional(s.text) }) },
  ),
  contract('POST', '/channel-categories', s.object({ category: s.category }), {
    body: s.request.categoryCreate,
    status: 201,
  }),
  contract('PATCH', '/channel-categories/:id', s.object({ category: s.category }), {
    body: s.request.categoryUpdate,
  }),
  contract('DELETE', '/channel-categories/:id', s.object({ removed: s.literal(true) }), {
    body: s.requestObject({ expectedRevision: s.sequence }),
  }),
  contract('GET', '/conversations', s.object({ conversations: s.array(s.conversation) })),
  contract('POST', '/conversations', s.object({ conversation: s.conversation }), {
    body: s.request.conversationCreate,
    status: 201,
  }),
  contract('GET', '/conversations/:id', s.object({ conversation: s.conversation })),
  contract('PATCH', '/conversations/:id', s.object({ conversation: s.conversation }), {
    body: s.request.conversationUpdate,
  }),
  contract('POST', '/conversations/:id/read', s.object({ lastReadSeq: s.sequence }), {
    body: s.request.read,
  }),
  contract(
    'GET',
    '/invitations',
    s.object({
      invitations: s.array(
        s.object({
          id: s.nonempty,
          conversationId: s.nonempty,
          name: s.text,
          inviter: s.text,
        }),
      ),
    }),
  ),
  contract('POST', '/conversations/:id/invitations', s.object({ id: s.nonempty }), {
    body: s.request.invite,
  }),
  contract('POST', '/invitations/:id', s.object({ conversationId: s.nonempty }), {
    body: s.request.invitation,
  }),
  contract('POST', '/conversations/:id/membership', s.ok, { body: s.request.membership }),
  contract(
    'GET',
    '/conversations/:id/pins',
    s.object({
      messages: s.array(s.message),
      nextBefore: s.nullable(s.sequence),
      total: s.count,
    }),
    { query: s.pageQuery },
  ),
  contract(
    'GET',
    '/conversations/:id/threads/:anchorId',
    s.object({
      ...s.messagePage.properties,
      root: s.nullable(s.message),
    }),
    { query: s.pageQuery },
  ),
  contract(
    'GET',
    '/conversations/:id/messages/:messageId/context',
    s.object({
      ...s.messagePage.properties,
      hasNewer: Type.Boolean(),
      anchorId: s.nonempty,
    }),
    { query: s.pageQuery },
  ),
  contract(
    'GET',
    '/conversations/:id/messages/unread-context',
    s.object({
      ...s.messagePage.properties,
      hasNewer: Type.Boolean(),
      anchorId: s.nonempty,
    }),
  ),
  contract('GET', '/conversations/:id/messages', s.messagePage, {
    query: s.requestObject({
      before: s.optional(s.text),
      afterChange: s.optional(s.text),
      limit: s.optional(s.text),
    }),
  }),
  contract('POST', '/conversations/:id/messages', s.messageResult, { body: s.request.messageSend }),
  contract('POST', '/conversations/:id/messages/with-attachment', s.messageResult, {
    body: s.request.messageWithAttachment,
  }),
  contract('GET', '/conversations/:id/messages/:messageId', s.messageResult),
  contract('PATCH', '/conversations/:id/messages/:messageId', s.messageResult, {
    body: s.request.messageEdit,
  }),
  contract('DELETE', '/conversations/:id/messages/:messageId', s.messageResult),
  contract('PUT', '/conversations/:id/messages/:messageId/pin', s.messageResult),
  contract('DELETE', '/conversations/:id/messages/:messageId/pin', s.messageResult),
  contract('PUT', '/conversations/:id/messages/:messageId/reactions', s.messageResult, {
    body: s.request.reaction,
  }),
  contract('DELETE', '/conversations/:id/messages/:messageId/reactions', s.messageResult, {
    body: s.request.reaction,
  }),
  contract(
    'GET',
    '/conversations/:id/notification-preference',
    s.object({
      conversationId: s.nonempty,
      mode: s.alertMode,
      defaultMode: s.alertMode,
      overridden: Type.Boolean(),
    }),
  ),
  contract(
    'PATCH',
    '/conversations/:id/notification-preference',
    s.object({
      conversationId: s.nonempty,
      mode: s.alertMode,
      defaultMode: s.alertMode,
      overridden: Type.Boolean(),
    }),
    { body: s.request.conversationPreference },
  ),
  contract(
    'GET',
    '/sender-alert-preferences',
    s.object({
      senders: s.array(
        s.object({
          senderId: s.nonempty,
          muted: Type.Boolean(),
          priority: Type.Boolean(),
          username: s.nonempty,
          displayName: s.text,
        }),
      ),
      nextCursor: s.nullable(s.nonempty),
    }),
    { query: s.requestObject({ after: s.optional(s.text), limit: s.optional(s.text) }) },
  ),
  contract(
    'PATCH',
    '/sender-alert-preferences/:id',
    s.object({
      senderId: s.nonempty,
      muted: Type.Boolean(),
      priority: Type.Boolean(),
    }),
    { body: s.request.senderPreference },
  ),
] as const;
