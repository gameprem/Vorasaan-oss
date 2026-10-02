import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileStreamInterceptor,
  type MultipartFileStream,
} from '@nestjs/platform-fastify/multipart';
import type { User } from '@vorasaan/db';
import {
  AddUrlAttachmentInput,
  type AttachmentFileSweepResult,
  type AttachmentView,
  CreateRepoScanInput,
  UploadAttachmentFields,
} from '@vorasaan/shared';
import { z } from 'zod';
import { AdminOnly } from '../auth/admin.guard.ts';
import { CurrentUser } from '../auth/identity.guard.ts';
import { attachmentLimits } from './attachment.config.ts';
import { AttachmentFilesService } from './attachment-files.service.ts';
import { type AttachmentOwner, AttachmentsService } from './attachments.service.ts';

const uploadStream = FileStreamInterceptor('file', {
  // Per request, so ATTACHMENT_MAX_BYTES applies without a restart.
  limits: () => ({ fileSize: attachmentLimits().maxBytes, files: 1, fields: 4, parts: 5 }),
  // Browsers send UTF-8 file names.
  defParamCharset: 'utf8',
});

@Controller()
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly files: AttachmentFilesService,
  ) {}

  @Get('features/:id/attachments')
  list(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) featureId: string,
  ): Promise<AttachmentView[]> {
    return this.attachments.list(user, { featureId });
  }

  /**
   * multipart/form-data (`title` field, then a `file` part) uploads a file;
   * a JSON body (`AddUrlAttachmentInput`) attaches a public URL, a Confluence
   * page or a Jira issue.
   */
  @Post('features/:id/attachments')
  @UseInterceptors(uploadStream)
  add(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) featureId: string,
    @Req() req: AttachRequest,
  ): Promise<AttachmentView> {
    return this.addTo(user, { featureId }, req);
  }

  /** Project-level Attachments: read by the Organization, edited by the Project Brief's editors. */
  @Get('projects/:id/attachments')
  listForProject(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) projectId: string,
  ): Promise<AttachmentView[]> {
    return this.attachments.list(user, { projectId });
  }

  /** The same bodies as `POST /features/:id/attachments`. */
  @Post('projects/:id/attachments')
  @UseInterceptors(uploadStream)
  addToProject(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Req() req: AttachRequest,
  ): Promise<AttachmentView> {
    return this.addTo(user, { projectId }, req);
  }

  /**
   * A Repo Scan summary from `vorasaan scan`, stored as a Project Attachment
   * (`source` "REPO_SCAN") that replaces the Project's previous one.
   */
  @Post('projects/:id/repo-scans')
  addRepoScan(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body({ schema: CreateRepoScanInput }) body: CreateRepoScanInput,
  ): Promise<AttachmentView> {
    return this.attachments.addRepoScan(user, projectId, body);
  }

  private addTo(user: User, owner: AttachmentOwner, req: AttachRequest): Promise<AttachmentView> {
    if (req.isMultipart()) {
      if (!req.file) throw new BadRequestException('Add the file in a "file" part');
      const fields = parse(UploadAttachmentFields, req.body ?? {});
      return this.attachments.addFile(user, owner, req.file, fields.title);
    }
    return this.attachments.addUrl(user, owner, parse(AddUrlAttachmentInput, req.body));
  }

  @Get('attachments/:id/file')
  async file(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown },
  ): Promise<StreamableFile> {
    const { bytes, mimeType, fileName } = await this.attachments.download(user, id);
    // Uploaded content is served as data, never as a page of this origin.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    return new StreamableFile(bytes, {
      type: mimeType.startsWith('text/') ? `${mimeType}; charset=utf-8` : mimeType,
      length: bytes.byteLength,
      disposition: `${mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
  }

  @Post('attachments/:id/refresh')
  refresh(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AttachmentView> {
    return this.attachments.refresh(user, id);
  }

  @Delete('attachments/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.attachments.remove(user, id);
  }

  /** Admin only: deletes stored files whose Attachment no longer exists. */
  @Post('attachments/sweep-orphaned-files')
  @AdminOnly()
  @HttpCode(200)
  sweepOrphanedFiles(): Promise<AttachmentFileSweepResult> {
    return this.files.sweepOrphans();
  }
}

type AttachRequest = { file?: MultipartFileStream; body?: unknown; isMultipart(): boolean };

/** The body shape depends on the content type, so it is validated here, not by the pipe. */
function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(z.prettifyError(result.error));
  return result.data;
}
