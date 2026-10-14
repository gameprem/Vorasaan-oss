import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@vorasaan/db';
import type { AttachmentFileSweepResult } from '@vorasaan/shared';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { type FileStorage, InjectFileStorage } from '../storage/file-storage.ts';

/** Where uploaded Attachment files are stored (see `AttachmentsService.addFile`). */
const ATTACHMENT_FILES_PREFIX = 'attachments/';

/**
 * How old a stored file must be before the sweep may delete it. An upload stores its
 * file just before it creates its Attachment, so a younger file may still be claimed.
 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * Keeps stored Attachment files in step with the database: deleting a Feature or a
 * Project deletes its Attachments' files, and the sweep catches any file left behind
 * (e.g. when storage was unreachable during such a delete).
 */
@Injectable()
export class AttachmentFilesService {
  private readonly logger = new Logger(AttachmentFilesService.name);

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectFileStorage() private readonly storage: FileStorage,
  ) {}

  /**
   * Deletes a Feature (its rows cascade), then its Attachments' files. `within` runs in the
   * same transaction first, once the Feature is locked (ticket 0049: who to tell, rows that
   * name it by a plain id); what it returns is returned once the files are gone.
   */
  async deleteFeature<T = void>(
    featureId: string,
    within?: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const { keys, result } = await this.db.$transaction(async (tx) => {
      // Locked first, so an Attachment added meanwhile waits for the delete (and then fails
      // on its foreign key) instead of slipping in after its file was listed.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Feature" WHERE id = ${featureId} FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Feature not found');
      const result = (await within?.(tx)) as T;
      const files = await tx.attachment.findMany({
        where: { featureId, storageKey: { not: null } },
        select: { storageKey: true },
      });
      await tx.feature.delete({ where: { id: featureId } });
      return { keys: files.map((f) => f.storageKey as string), result };
    });
    await this.deleteFiles(keys);
    return result;
  }

  /**
   * Deletes a Project (its Teams, Features and rows cascade), then all those Attachments'
   * files. `within` runs in the same transaction first, as for `deleteFeature`.
   */
  async deleteProject<T = void>(
    projectId: string,
    within?: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const { keys, result } = await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Project not found');
      // Its Features too: a Feature Attachment being added locks only its Feature.
      await tx.$queryRaw`
        SELECT f.id FROM "Feature" f JOIN "Team" t ON t.id = f."teamId"
        WHERE t."projectId" = ${projectId} FOR UPDATE OF f`;
      const result = (await within?.(tx)) as T;
      const files = await tx.attachment.findMany({
        where: {
          storageKey: { not: null },
          OR: [{ projectId }, { feature: { team: { projectId } } }],
        },
        select: { storageKey: true },
      });
      await tx.project.delete({ where: { id: projectId } });
      return { keys: files.map((f) => f.storageKey as string), result };
    });
    await this.deleteFiles(keys);
    return result;
  }

  /** Deletes stored Attachment files that no Attachment refers to any more. */
  async sweepOrphans(now = new Date()): Promise<AttachmentFileSweepResult> {
    const stored = [];
    for await (const file of this.storage.list(ATTACHMENT_FILES_PREFIX)) stored.push(file);
    // Read after listing, so an Attachment created meanwhile still protects its file.
    const live = new Set(
      (
        await this.db.attachment.findMany({
          where: { storageKey: { not: null } },
          select: { storageKey: true },
        })
      ).map((a) => a.storageKey),
    );
    const cutoff = now.getTime() - ORPHAN_GRACE_MS;
    const orphans = stored
      .filter((f) => !live.has(f.key) && f.lastModified.getTime() < cutoff)
      .map((f) => f.key);
    const removed = await this.deleteFiles(orphans);
    if (removed > 0) this.logger.log(`Swept ${removed} orphaned Attachment file(s)`);
    return { checked: stored.length, removed };
  }

  /**
   * Runs after the database change commits. A file that fails to delete is only
   * logged: the rows are already gone, and the sweep removes it later.
   */
  private async deleteFiles(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      try {
        await this.storage.delete(key);
        deleted++;
      } catch (error) {
        this.logger.warn(`Could not delete stored file "${key}": ${(error as Error).message}`);
      }
    }
    return deleted;
  }
}
