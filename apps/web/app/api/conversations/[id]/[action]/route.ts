import {
  CompactConversationInput,
  ConversationUsageQuery,
  ListConversationMessagesQuery,
  SendConversationMessageInput,
} from '@vorasaan/shared';
import { forwardGet, forwardPost } from '@/lib/api-proxy';
import { isId } from '@/lib/ids';

// In one of the visitor's Conversations:
// - messages: their next message; answers once the AI's reply is stored;
// - retry: after a failed reply, asks the AI again to reply to the last message;
// - stop: stops the reply being written; what it wrote so far is kept;
// - compact: "Compact now" and /compact [focus] (ticket 0066).
const ACTIONS = {
  messages: SendConversationMessageInput,
  retry: undefined,
  stop: undefined,
  compact: CompactConversationInput,
} as const;

// GET (ticket 0066):
// - messages: a page of messages (`before`, `after` or `around`, and `limit`);
// - usage: how full the Conversation is, for its model or `approvedModelId`.
const READS = {
  messages: ListConversationMessagesQuery,
  usage: ConversationUsageQuery,
} as const;

type Ctx = { params: Promise<{ id: string; action: string }> };
const notFound = () => Response.json({ message: 'Not found' }, { status: 404 });

export async function POST(request: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  if (!isId(id) || !Object.hasOwn(ACTIONS, action)) return notFound();
  const name = action as keyof typeof ACTIONS;
  return forwardPost(request, `/conversations/${id}/${name}`, ACTIONS[name]);
}

export async function GET(request: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  if (!isId(id) || !Object.hasOwn(READS, action)) return notFound();
  const name = action as keyof typeof READS;
  // Only a query the API's own schema accepts is forwarded.
  const parsed = READS[name].safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return Response.json(
      { message: parsed.error.issues[0]?.message ?? 'The request is not valid' },
      { status: 400 },
    );
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const qs = query.toString();
  return forwardGet(`/conversations/${id}/${name}${qs ? `?${qs}` : ''}`);
}
