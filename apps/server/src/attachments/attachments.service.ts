import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { AttachmentSource, PrismaClient, User } from '@vorasaan/db';
import {
  type AddUrlAttachmentInput,
  ATTACHMENT_FILE_TYPES,
  type AttachmentView,
  type CreateRepoScanInput,
} from '@vorasaan/shared';
import { AI_PORT, type AiPort } from '../ai/ai.port.ts';
import { personLanguage } from '../ai/language.ts';
import { assertCanEditProject, projectAccess } from '../brief/brief-access.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { IndexingService } from '../retrieval/indexing.service.ts';
import {
  type FileStorage,
  InjectFileStorage,
  StoredFileNotFoundError,
} from '../storage/file-storage.ts';
import { AtlassianError } from './atlassian.ts';
import { attachmentLimits } from './attachment.config.ts';
import { attachmentInclude, toAttachmentView } from './attachment.view.ts';
import { ATTACHMENT_CONTEXT_BUDGET, clipForAi } from './attachment-context.ts';
import { UrlFetchError } from './fetch-url.ts';
import {
  capSnapshot,
  matchesMimeType,
  mimeTypeForFileName,
  snapshotText,
  UnreadableContentError,
} from './snapshot-text.ts';
import {
  ATTACHMENT_SNAPSHOTTERS,
  type AttachmentSnapshotter,
  type Snapshot,
  type SnapshotTarget,
} from './snapshotters.ts';

export type UploadedFile = { originalname: string; stream: Readable };

/** What an Attachment is attached to: one Feature, or one Project as a whole. */
export type AttachmentOwner = { featureId: string } | { projectId: string };

export type AttachmentDownload = { bytes: Uint8Array; mimeType: string; fileName: string };

const TITLE_MAX = 200;

@Injectable()
export class AttachmentsService {
  private readonly snapshotters: Map<AttachmentSource, AttachmentSnapshotter>;
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectFileStorage() private readonly storage: FileStorage,
    @Inject(ATTACHMENT_SNAPSHOTTERS) snapshotters: AttachmentSnapshotter[],
    @Inject(AI_PORT) private readonly ai: AiPort,
    private readonly indexing: IndexingService,
  ) {
    this.snapshotters = new Map(snapshotters.map((s) => [s.source, s]));
  }

  async list(user: User, owner: AttachmentOwner): Promise<AttachmentView[]> {
    await this.assertCanRead(user, owner);
    const attachments = await this.db.attachment.findMany({
      where: owner,
      orderBy: { createdAt: 'asc' },
      include: attachmentInclude,
    });
    return attachments.map(toAttachmentView);
  }

  /** Stores an uploaded md/txt/pdf/image file and snapshots its text. */
  async addFile(
    user: User,
    owner: AttachmentOwner,
    file: UploadedFile,
    title: string | undefined,
  ): Promise<AttachmentView> {
    await this.assertCanEdit(user, owner);
    const mimeType = mimeTypeForFileName(file.originalname);
    if (!mimeType) {
      throw new UnsupportedMediaTypeException(
        `Attach a Markdown, text, PDF or image file (${Object.keys(ATTACHMENT_FILE_TYPES).join(', ')})`,
      );
    }
    const bytes = await readCapped(file.stream, attachmentLimits().maxBytes);
    if (bytes.byteLength === 0) throw new UnprocessableEntityException('The file is empty');
    if (!matchesMimeType(bytes, mimeType)) {
      throw new UnsupportedMediaTypeException(`The file's content is not ${mimeType}`);
    }
    const text = await readable(() =>
      snapshotText(bytes, mimeType, attachmentLimits().maxSnapshotChars),
    );

    const attachmentTitle = clip(title ?? file.originalname);
    const id = randomUUID();
    const summary = await this.summarize(user, id, attachmentTitle, 'FILE', text);

    const storageKey =
      'featureId' in owner
        ? `attachments/${owner.featureId}/${id}`
        : `attachments/projects/${owner.projectId}/${id}`;
    await this.storage.put(storageKey, bytes, mimeType);
    try {
      const created = await this.db.attachment.create({
        data: {
          id,
          ...owner,
          source: 'FILE',
          title: attachmentTitle,
          storageKey,
          mimeType,
          snapshotText: text,
          snapshotAt: new Date(),
          summary,
          addedById: user.id,
        },
        include: attachmentInclude,
      });
      this.indexing.schedule({ source: 'ATTACHMENT', id });
      return toAttachmentView(created);
    } catch (error) {
      await this.storage.delete(storageKey);
      throw error;
    }
  }

  /**
   * Attaches a public web page, a Confluence page or a Jira issue and snapshots
   * its readable text.
   */
  async addUrl(
    user: User,
    owner: AttachmentOwner,
    input: AddUrlAttachmentInput,
  ): Promise<AttachmentView> {
    await this.assertCanEdit(user, owner);
    const ref =
      input.source === 'URL' ? input.url : input.source === 'CONFLUENCE' ? input.page : input.issue;
    const snapshot = await this.capture(input.source, {
      url: ref,
      storageKey: null,
      mimeType: null,
    });
    const url = snapshot.url ?? ref;
    const attachmentTitle = clip(input.title ?? snapshot.title ?? url);
    // Chosen now, so the summary's Receipt can point at the Attachment (ticket 0070).
    const id = randomUUID();
    const summary = await this.summarize(user, id, attachmentTitle, input.source, snapshot.text);
    const created = await this.db.attachment.create({
      data: {
        id,
        ...owner,
        source: input.source,
        title: attachmentTitle,
        url,
        mimeType: snapshot.mimeType ?? null,
        snapshotText: snapshot.text,
        snapshotAt: new Date(),
        summary,
        addedById: user.id,
      },
      include: attachmentInclude,
    });
    this.indexing.schedule({ source: 'ATTACHMENT', id: created.id });
    return toAttachmentView(created);
  }

  /**
   * Stores a Repo Scan summary from `vorasaan scan` as a Project Attachment with
   * no file: the Snapshot is the Markdown. It replaces the Project's previous
   * Repo Scan, so only the newest one is used as context and none go stale in
   * retrieval. Admins, POs of the Project's Teams and Role Owners of any
   * Feature in the Project may post one (they are the ones working in its code).
   */
  async addRepoScan(
    user: User,
    projectId: string,
    input: CreateRepoScanInput,
  ): Promise<AttachmentView> {
    await this.assertCanPostRepoScan(user, projectId);
    const text = capSnapshot(input.markdown, attachmentLimits().maxSnapshotChars);
    const title = clip(
      `Repo Scan: ${input.repoName}${input.commitSha ? ` @ ${input.commitSha.slice(0, 7)}` : ''}`,
    );
    const id = randomUUID();
    const summary = await this.summarize(user, id, title, 'REPO_SCAN', text);
    const { created, replaced } = await this.db.$transaction(async (tx) => {
      const previous = await tx.attachment.findMany({
        where: { projectId, source: 'REPO_SCAN' },
        select: { id: true },
      });
      await tx.attachment.deleteMany({ where: { id: { in: previous.map((a) => a.id) } } });
      const created = await tx.attachment.create({
        data: {
          id,
          projectId,
          source: 'REPO_SCAN',
          title,
          mimeType: 'text/markdown',
          snapshotText: text,
          snapshotAt: new Date(),
          summary,
          addedById: user.id,
        },
        include: attachmentInclude,
      });
      return { created, replaced: previous };
    });
    for (const { id } of replaced) this.indexing.schedule({ source: 'ATTACHMENT', id });
    this.indexing.schedule({ source: 'ATTACHMENT', id: created.id });
    return toAttachmentView(created);
  }

  /** Re-fetches a URL, Confluence page or Jira issue (or re-reads a file) and replaces the Snapshot. */
  async refresh(user: User, id: string): Promise<AttachmentView> {
    const attachment = await this.findOrThrow(id);
    await this.assertCanEdit(user, ownerOf(attachment));
    if (attachment.source === 'REPO_SCAN') {
      throw new UnprocessableEntityException(
        'A Repo Scan can’t be refreshed from here: run `vorasaan scan` in the repository again',
      );
    }
    const snapshot = await this.capture(attachment.source, attachment);
    // A summary of the old Snapshot would be stale: replace it, or clear it on failure.
    const summary = await this.summarize(
      user,
      id,
      attachment.title,
      attachment.source,
      snapshot.text,
    );
    const updated = await this.db.attachment.update({
      where: { id },
      data: {
        snapshotText: snapshot.text,
        snapshotAt: new Date(),
        summary,
        ...(snapshot.mimeType ? { mimeType: snapshot.mimeType } : {}),
      },
      include: attachmentInclude,
    });
    this.indexing.schedule({ source: 'ATTACHMENT', id });
    return toAttachmentView(updated);
  }

  async download(user: User, id: string): Promise<AttachmentDownload> {
    const attachment = await this.findOrThrow(id);
    await this.assertCanRead(user, ownerOf(attachment));
    if (!attachment.storageKey || !attachment.mimeType) {
      throw new NotFoundException('This Attachment has no file');
    }
    try {
      const bytes = await this.storage.get(attachment.storageKey);
      return {
        bytes,
        mimeType: attachment.mimeType,
        fileName: fileNameFor(attachment.title, attachment.mimeType),
      };
    } catch (error) {
      if (error instanceof StoredFileNotFoundError) {
        throw new NotFoundException('The file is missing from storage');
      }
      throw error;
    }
  }

  async remove(user: User, id: string): Promise<void> {
    const attachment = await this.findOrThrow(id);
    await this.assertCanEdit(user, ownerOf(attachment));
    await this.db.attachment.delete({ where: { id } });
    this.indexing.schedule({ source: 'ATTACHMENT', id }); // gone: its chunks are removed
    if (attachment.storageKey) await this.storage.delete(attachment.storageKey);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * The AI summary of a Snapshot, or null when there is no text or the AI call
   * fails: a missing summary never stops an Attachment from being saved.
   */
  private async summarize(
    user: Pick<User, 'id'>,
    attachmentId: string,
    title: string,
    source: AttachmentSource,
    text: string | null,
  ): Promise<string | null> {
    if (!text?.trim()) return null;
    try {
      const { summary } = await this.ai.summarizeAttachment(
        {
          attachment: { title, source, text: clipForAi(text, ATTACHMENT_CONTEXT_BUDGET.summary) },
        },
        {
          language: await personLanguage(this.db, user.id),
          receipt: {
            requestedById: user.id,
            output: { kind: 'ATTACHMENT', id: attachmentId },
          },
        },
      );
      return summary;
    } catch (error) {
      this.logger.warn(`Could not summarize Attachment "${title}": ${(error as Error).message}`);
      return null;
    }
  }

  private async capture(source: AttachmentSource, target: SnapshotTarget): Promise<Snapshot> {
    const snapshotter = this.snapshotters.get(source);
    if (!snapshotter) {
      throw new UnprocessableEntityException(`${source} Attachments can't be captured yet`);
    }
    return readable(() => snapshotter.capture(target));
  }

  private async findOrThrow(id: string) {
    const attachment = await this.db.attachment.findUnique({ where: { id } });
    if (!attachment) throw new NotFoundException('Attachment not found');
    return attachment;
  }

  /**
   * Everyone in the Organization can read a Feature's or a Project's Attachments.
   * Project Attachments follow the Project Brief's permissions.
   */
  private async assertCanRead(user: User, owner: AttachmentOwner) {
    if ('projectId' in owner) {
      await projectAccess(this.db, user, owner.projectId);
      return;
    }
    const { featureId } = owner;
    const feature = await this.db.feature.findUnique({
      where: { id: featureId },
      select: { team: { select: { project: { select: { organizationId: true } } } } },
    });
    if (!feature) throw new NotFoundException('Feature not found');
    const member = await this.db.orgMembership.count({
      where: { userId: user.id, organizationId: feature.team.project.organizationId },
    });
    if (!member) throw new ForbiddenException('You are not in this Organization');
  }

  /** The Project's editors (see `projectAccess`), or a Role Owner of any Feature in the Project. */
  private async assertCanPostRepoScan(user: User, projectId: string) {
    const access = await projectAccess(this.db, user, projectId);
    if (access.canEdit) return;
    const roleOwner = await this.db.roleOwner.count({
      where: { userId: user.id, feature: { team: { projectId } } },
    });
    if (!roleOwner) {
      throw new ForbiddenException(
        "Only an Admin, a PO of one of this Project's Teams or a Role Owner of one of its Features can send a Repo Scan",
      );
    }
  }

  /**
   * Any Role Owner of the Feature, or an Admin, can add, refresh or remove a
   * Feature's Attachments; a Project's are edited by those who edit its Brief
   * (Admins and the POs of the Project's Teams).
   */
  private async assertCanEdit(user: User, owner: AttachmentOwner) {
    if ('projectId' in owner) {
      await assertCanEditProject(this.db, user, owner.projectId);
      return;
    }
    const { featureId } = owner;
    const feature = await this.db.feature.findUnique({
      where: { id: featureId },
      select: {
        roleOwners: { where: { userId: user.id }, select: { role: true }, take: 1 },
        team: { select: { project: { select: { organizationId: true } } } },
      },
    });
    if (!feature) throw new NotFoundException('Feature not found');
    if (feature.roleOwners.length > 0) return;
    const admin = await this.db.orgMembership.count({
      where: {
        userId: user.id,
        organizationId: feature.team.project.organizationId,
        role: 'ADMIN',
      },
    });
    if (!admin) {
      throw new ForbiddenException('Only a Role Owner of this Feature or an Admin can do this');
    }
  }
}

function ownerOf(attachment: {
  featureId: string | null;
  projectId: string | null;
}): AttachmentOwner {
  if (attachment.featureId) return { featureId: attachment.featureId };
  if (attachment.projectId) return { projectId: attachment.projectId };
  // The database's CHECK constraint makes this unreachable.
  throw new Error('An Attachment must belong to a Feature or a Project');
}

/** Maps content and fetch failures to 422, keeping their message. */
async function readable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof UnreadableContentError ||
      error instanceof UrlFetchError ||
      error instanceof AtlassianError
    ) {
      throw new UnprocessableEntityException(error.message);
    }
    if (error instanceof StoredFileNotFoundError) {
      throw new UnprocessableEntityException('The file is missing from storage');
    }
    throw error;
  }
}

/**
 * Buffers an upload, failing as soon as it passes `maxBytes`. The multipart
 * parser enforces the same cap; this keeps the service safe on its own.
 */
async function readCapped(stream: Readable, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      stream.destroy();
      throw new PayloadTooLargeException(`Files can be at most ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function clip(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > TITLE_MAX ? trimmed.slice(0, TITLE_MAX) : trimmed || 'Untitled';
}

/** A safe download name: the title, with the type's extension if it lacks one. */
function fileNameFor(title: string, mimeType: string): string {
  const extensions = Object.entries(ATTACHMENT_FILE_TYPES)
    .filter(([, m]) => m === mimeType)
    .map(([extension]) => extension);
  const base = title.replace(/[^\p{L}\p{N} ._-]+/gu, '_').trim() || 'attachment';
  const hasExtension = extensions.some((e) => base.toLowerCase().endsWith(`.${e}`));
  return hasExtension || !extensions[0] ? base : `${base}.${extensions[0]}`;
}
