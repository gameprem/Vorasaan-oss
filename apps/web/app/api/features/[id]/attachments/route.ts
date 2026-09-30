import { forwardAttachmentUpload } from '@/lib/attachment-upload';

// Uploads a file as an Attachment of a Feature (see lib/attachment-upload.ts).
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return forwardAttachmentUpload(request, { kind: 'features', id });
}
