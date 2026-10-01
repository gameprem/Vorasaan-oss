import { ApproveActionCardInput, DeclineActionCardInput } from '@vorasaan/shared';
import { forwardPost } from '@/lib/api-proxy';
import { isId } from '@/lib/ids';

// An Action Card in one of the visitor's Conversations:
// - approve: the target's own service sends, approves or accepts it;
// - decline: the draft is withdrawn, the proposal rejected, the suggestion dismissed.
const ACTIONS = { approve: ApproveActionCardInput, decline: DeclineActionCardInput } as const;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await ctx.params;
  if (!isId(id) || !Object.hasOwn(ACTIONS, action)) {
    return Response.json({ message: 'Not found' }, { status: 404 });
  }
  const name = action as keyof typeof ACTIONS;
  return forwardPost(request, `/action-cards/${id}/${name}`, ACTIONS[name]);
}
