import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EmbeddingSettingsInput, ReindexInput } from '@vorasaan/shared';
import { AdminOnly } from '../auth/admin.guard.ts';
import { EmbeddingSettingsService } from './embedding-settings.service.ts';
import { IndexingService } from './indexing.service.ts';

/** The embeddings endpoint used for retrieval (ADR 0007). The API key is never returned. */
@AdminOnly()
@Controller('settings/embeddings')
export class EmbeddingSettingsController {
  constructor(
    private readonly settings: EmbeddingSettingsService,
    private readonly indexing: IndexingService,
  ) {}

  @Get()
  view() {
    return this.settings.view();
  }

  /** Saving a new model does not re-embed anything: follow with a `stale` re-index. */
  @Put()
  save(@Body({ schema: EmbeddingSettingsInput }) body: EmbeddingSettingsInput) {
    return this.settings.save(body);
  }

  /** Embeds a short text with these settings, without saving them, and reports the dimension. */
  @Post('test')
  @HttpCode(200)
  test(@Body({ schema: EmbeddingSettingsInput }) body: EmbeddingSettingsInput) {
    return this.settings.test(body);
  }

  /** Queues re-indexing in the background and answers at once with how many sources. */
  @Post('reindex')
  @HttpCode(202)
  async reindex(@Body({ schema: ReindexInput }) body: ReindexInput) {
    const organizationId = await this.settings.organizationId();
    if (!organizationId) throw new UnprocessableEntityException('Run setup first');
    return this.indexing.reindex(organizationId, body.scope);
  }
}
