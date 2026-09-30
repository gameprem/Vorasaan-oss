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
} from '@vorasaan/shared';
import { AI_PORT, type AiPort } from '../ai/ai.port.ts';
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

  async list(user: User, featureId: string): Promise<AttachmentView[]> {
    await this.assertCanRead(user, featureId);
    const attachments = await this.db.attachment.findMany({
      where: { featureId },
      orderBy: { createdAt: 'asc' },
      include: attachmentInclude,
    });
    return attachments.map(toAttachmentView);
  }

  /** Stores an uploaded md/txt/pdf/image file and snapshots its text. */
  async addFile(
    user: User,
    featureId: string,
    file: UploadedFile,
    title: string | undefined,
  ): Promise<AttachmentView> {
    await this.assertCanEdit(user, featureId);
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
    const summary = await this.summarize(attachmentTitle, 'FILE', text);

    const id = randomUUID();
    const storageKey = `attachments/${featureId}/${id}`;
    await this.storage.put(storageKey, bytes, mimeType);
    try {
      const created = await this.db.attachment.create({
        data: {
          id,
          featureId,
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
    featureId: string,
    input: AddUrlAttachmentInput,
  ): Promise<AttachmentView> {
    await this.assertCanEdit(user, featureId);
    const ref =
      input.source === 'URL' ? input.url : input.source === 'CONFLUENCE' ? input.page : input.issue;
    const snapshot = await this.capture(input.source, {
      url: ref,
      storageKey: null,
      mimeType: null,
    });
    const url = snapshot.url ?? ref;
    const attachmentTitle = clip(input.title ?? snapshot.title ?? url);
    const summary = await this.summarize(attachmentTitle, input.source, snapshot.text);
    const created = await this.db.attachment.create({
      data: {
        featureId,
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

  /** Re-fetches a URL, Confluence page or Jira issue (or re-reads a file) and replaces the Snapshot. */
  async refresh(user: User, id: string): Promise<AttachmentView> {
    const attachment = await this.findOrThrow(id);
    await this.assertCanEdit(user, attachment.featureId);
    const snapshot = await this.capture(attachment.source, attachment);
    // A summary of the old Snapshot would be stale: replace it, or clear it on failure.
    const summary = await this.summarize(attachment.title, attachment.source, snapshot.text);
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
    await this.assertCanRead(user, attachment.featureId);
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
    await this.assertCanEdit(user, attachment.featureId);
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
    title: string,
    source: AttachmentSource,
    text: string | null,
  ): Promise<string | null> {
    if (!text?.trim()) return null;
    try {
      const { summary } = await this.ai.summarizeAttachment({
        attachment: { title, source, text: clipForAi(text, ATTACHMENT_CONTEXT_BUDGET.summary) },
      });
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

  /** Everyone in the Feature's Organization can read its Attachments. */
  private async assertCanRead(user: User, featureId: string) {
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

  /** Any Role Owner of the Feature, or an Admin, can add, refresh or remove. */
  private async assertCanEdit(user: User, featureId: string) {
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
