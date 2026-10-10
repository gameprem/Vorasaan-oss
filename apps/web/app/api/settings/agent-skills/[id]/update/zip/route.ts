import { forwardUpload, maxSkillZipBytes } from '@/lib/attachment-upload';
import { isId } from '@/lib/ids';

// A new zip of an Agent Skill installed from a zip (ticket 0078): it waits for an Admin's approval.
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isId(id)) return Response.json({ message: 'Not found' }, { status: 404 });
  return forwardUpload(request, `/settings/agent-skills/${id}/update/zip`, maxSkillZipBytes());
}
