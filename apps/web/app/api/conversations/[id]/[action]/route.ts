import { SendConversationMessageInput } from '@vorasaan/shared';
import { forwardPost } from '@/lib/api-proxy';
import { isId } from '@/lib/ids';

// In one of the visitor's Conversations:
// - messages: their next message; answers once the AI's reply is stored;
// - retry: after a failed reply, asks the AI again to reply to the last message;
// - stop: stops the reply being written; what it wrote so far is kept.
const ACTIONS = {
  messages: SendConversationMessageInput,
  retry: undefined,
  stop: undefined,
} as const;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await ctx.params;
  if (!isId(id) || !Object.hasOwn(ACTIONS, action)) {
    return Response.json({ message: 'Not found' }, { status: 404 });
  }
  const name = action as keyof typeof ACTIONS;
  return forwardPost(request, `/conversations/${id}/${name}`, ACTIONS[name]);
}
