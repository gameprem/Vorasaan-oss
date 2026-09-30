import type { Prisma } from '@vorasaan/db';
import type { AttachmentView } from '@vorasaan/shared';

export const attachmentInclude = {
  addedBy: { select: { id: true, name: true } },
} satisfies Prisma.AttachmentInclude;

export type AttachmentWithRelations = Prisma.AttachmentGetPayload<{
  include: typeof attachmentInclude;
}>;

export function toAttachmentView(a: AttachmentWithRelations): AttachmentView {
  return {
    id: a.id,
    featureId: a.featureId,
    source: a.source,
    title: a.title,
    url: a.url,
    mimeType: a.mimeType,
    hasFile: a.storageKey !== null,
    snapshotText: a.snapshotText,
    snapshotAt: a.snapshotAt?.toISOString() ?? null,
    addedBy: a.addedBy,
    createdAt: a.createdAt.toISOString(),
  };
}
