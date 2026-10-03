import { RequestChangesInput } from '@vorasaan/shared';
import { forwardGet, forwardPost } from '@/lib/api-proxy';
import { isId } from '@/lib/ids';
import { isRedraftSlug, redraftApiBase } from '@/lib/redrafts';

// A proposal's Redrafts (ticket 0065), for the browser:
// - GET: every Redraft, oldest first, and whether the visitor may Request changes;
// - POST: Request changes; answers once the AI has written the Redraft.

type Ctx = { params: Promise<{ kind: string; id: string }> };

async function base(ctx: Ctx): Promise<string | null> {
  const { kind, id } = await ctx.params;
  return isId(id) && isRedraftSlug(kind) ? redraftApiBase(kind, id) : null;
}

const notFound = () => Response.json({ message: 'Not found' }, { status: 404 });

export async function GET(_request: Request, ctx: Ctx) {
  const path = await base(ctx);
  return path ? forwardGet(`${path}/redrafts`) : notFound();
}

export async function POST(request: Request, ctx: Ctx) {
  const path = await base(ctx);
  return path ? forwardPost(request, `${path}/request-changes`, RequestChangesInput) : notFound();
}
