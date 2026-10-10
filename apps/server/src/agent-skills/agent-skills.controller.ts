import type { Readable } from 'node:stream';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Put,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileStreamInterceptor,
  type MultipartFileStream,
} from '@nestjs/platform-fastify/multipart';
import type { User } from '@vorasaan/db';
import {
  type AgentSkillDiff,
  type AgentSkillsView,
  type AgentSkillUpdateResult,
  type AgentSkillView,
  InstallAgentSkillInput,
  SetAgentSkillProjectsInput,
  UploadAgentSkillFields,
} from '@vorasaan/shared';
import { AdminOnly } from '../auth/admin.guard.ts';
import { CurrentUser } from '../auth/identity.guard.ts';
import { agentSkillLimits } from './agent-skills.config.ts';
import { AgentSkillsService } from './agent-skills.service.ts';

const zipStream = FileStreamInterceptor('file', {
  // Per request, so VORASAAN_AGENT_SKILL_MAX_ARCHIVE_BYTES applies without a restart.
  limits: () => ({ fileSize: agentSkillLimits().maxArchiveBytes, files: 1, fields: 2, parts: 3 }),
  defParamCharset: 'utf8',
});

type UploadRequest = {
  file?: MultipartFileStream;
  body?: Record<string, unknown>;
};

/**
 * Settings → Agent Skills (ADR 0017, ticket 0078): only an Admin installs, updates, approves,
 * declines, enables or uninstalls an Agent Skill, or reads one. Anyone else gets 403 before
 * anything is fetched or stored.
 */
@Controller('settings/agent-skills')
@AdminOnly()
export class AgentSkillsController {
  constructor(private readonly skills: AgentSkillsService) {}

  @Get()
  list(@CurrentUser() user: User): Promise<AgentSkillsView> {
    return this.skills.list(user);
  }

  /** Installs from a GitHub URL (JSON `InstallAgentSkillInput`): version 1, waiting for approval. */
  @Post()
  install(
    @CurrentUser() user: User,
    @Body({ schema: InstallAgentSkillInput }) body: InstallAgentSkillInput,
  ): Promise<AgentSkillView> {
    return this.skills.installFromGitHub(user, body);
  }

  /** Installs from a zip (multipart: an optional `subpath` field, then the `file` part). */
  @Post('zip')
  @UseInterceptors(zipStream)
  async installZip(@CurrentUser() user: User, @Req() req: UploadRequest): Promise<AgentSkillView> {
    const { zip, subpath } = await readUpload(req);
    return this.skills.installFromZip(user, zip, subpath);
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string): Promise<AgentSkillView> {
    return this.skills.get(user, id);
  }

  /** Fetches the ref it came from again: a newer commit waits for approval with its diff. */
  @Post(':id/update')
  @HttpCode(200)
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentSkillUpdateResult> {
    return this.skills.update(user, id);
  }

  /** A new zip of a Skill installed from a zip: it waits for approval with its diff. */
  @Post(':id/update/zip')
  @HttpCode(200)
  @UseInterceptors(zipStream)
  async updateZip(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: UploadRequest,
  ): Promise<AgentSkillUpdateResult> {
    const { zip, subpath } = await readUpload(req);
    return this.skills.updateFromZip(user, id, zip, subpath);
  }

  @Get(':id/diff')
  diff(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string): Promise<AgentSkillDiff> {
    return this.skills.diff(user, id);
  }

  @Post(':id/versions/:number/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('number', ParseIntPipe) number: number,
  ): Promise<AgentSkillView> {
    return this.skills.approve(user, id, number);
  }

  @Post(':id/versions/:number/decline')
  @HttpCode(200)
  decline(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('number', ParseIntPipe) number: number,
  ): Promise<AgentSkillView> {
    return this.skills.decline(user, id, number);
  }

  @Put(':id/projects')
  setProjects(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SetAgentSkillProjectsInput }) body: SetAgentSkillProjectsInput,
  ): Promise<AgentSkillView> {
    return this.skills.setProjects(user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async uninstall(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.skills.uninstall(user, id);
  }
}

/** The uploaded zip, buffered up to the archive limit, and the `subpath` field. */
async function readUpload(req: UploadRequest): Promise<{ zip: Uint8Array; subpath?: string }> {
  if (!req.file) throw new BadRequestException('Add the zip in a "file" part');
  const fields = UploadAgentSkillFields.safeParse(req.body ?? {});
  if (!fields.success) {
    req.file.stream.resume();
    throw new BadRequestException(fields.error.issues[0]?.message ?? 'Invalid fields');
  }
  const max = agentSkillLimits().maxArchiveBytes;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.file.stream as Readable as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > max) {
      req.file.stream.destroy();
      throw new PayloadTooLargeException(`The zip is larger than ${max} bytes`);
    }
    chunks.push(chunk);
  }
  if ((req.file.stream as Readable & { truncated?: boolean }).truncated) {
    throw new PayloadTooLargeException(`The zip is larger than ${max} bytes`);
  }
  return { zip: Buffer.concat(chunks), subpath: fields.data.subpath || undefined };
}
