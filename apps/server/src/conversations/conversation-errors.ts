import { BadGatewayException, NotFoundException } from '@nestjs/common';

export function conversationNotFound() {
  return new NotFoundException('Conversation not found');
}

/** A 502 that tells a client which Conversation to retry in (ConversationReplyFailed). */
export function replyFailed(conversationId: string, message: string) {
  return new BadGatewayException({
    statusCode: 502,
    error: 'Bad Gateway',
    message,
    conversationId,
  });
}
