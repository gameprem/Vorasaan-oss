import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
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

  /** Deletes a Feature (its rows cascade), then its Attachments' files. */
  async deleteFeature(featureId: string): Promise<void> {
    const keys = await this.db.$transaction(async (tx) => {
      const files = await tx.attachment.findMany({
        where: { featureId, storageKey: { not: null } },
        select: { storageKey: true },
      });
      const { count } = await tx.feature.deleteMany({ where: { id: featureId } });
      if (count === 0) throw new NotFoundException('Feature not found');
      return files.map((f) => f.storageKey as string);
    });
    await this.deleteFiles(keys);
  }

  /** Deletes a Project (its Teams, Features and rows cascade), then all those Attachments' files. */
  async deleteProject(projectId: string): Promise<void> {
    const keys = await this.db.$transaction(async (tx) => {
      const files = await tx.attachment.findMany({
        where: {
          storageKey: { not: null },
          OR: [{ projectId }, { feature: { team: { projectId } } }],
        },
        select: { storageKey: true },
      });
      const { count } = await tx.project.deleteMany({ where: { id: projectId } });
      if (count === 0) throw new NotFoundException('Project not found');
      return files.map((f) => f.storageKey as string);
    });
    await this.deleteFiles(keys);
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
