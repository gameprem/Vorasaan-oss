import { forwardGet } from '@/lib/api-proxy';
import { isId } from '@/lib/ids';

// "View summary" (ticket 0066): the Conversation Summary as one compaction left it.
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string; compactionId: string }> },
) {
  const { id, compactionId } = await ctx.params;
  if (!isId(id) || !isId(compactionId)) {
    return Response.json({ message: 'Not found' }, { status: 404 });
  }
  return forwardGet(`/conversations/${id}/compactions/${compactionId}`);
}
