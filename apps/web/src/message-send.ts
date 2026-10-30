import type {
  ChatAck,
  ChatMessage,
  ClientToServerEvents,
  ServerToClientEvents,
} from '@tricord/shared';
import type { Socket } from 'socket.io-client';
import { sendPayload, type SendAttempt } from './chat-state';

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export async function deliverMessage(
  request: Request,
  socket: Socket<ServerToClientEvents, ClientToServerEvents> | null,
  conversationId: string,
  pending: SendAttempt,
): Promise<ChatMessage> {
  if (!socket?.connected)
    return (
      await request<{ message: ChatMessage }>(
        '/conversations/' + conversationId + '/messages',
        'POST',
        sendPayload(pending),
      )
    ).message;
  const ack = await new Promise<ChatAck<ChatMessage>>((resolve, reject) => {
    socket
      .timeout(10000)
      .emit('message:send', { conversationId, ...sendPayload(pending) }, (timeout, result) =>
        timeout
          ? reject(new Error('Delivery not confirmed. Retry safely with the same message.'))
          : resolve(result),
      );
  });
  if (!ack.ok) throw new Error(ack.error);
  return ack.data;
}
