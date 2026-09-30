import { Global, Logger, Module } from '@nestjs/common';
import { ContentChunkRepository } from './content-chunk.repository.ts';
import { EMBEDDING_PORT_FACTORY, type EmbeddingPortFactory } from './embedding.port.ts';
import { EmbeddingSettingsController } from './embedding-settings.controller.ts';
import { EmbeddingSettingsService } from './embedding-settings.service.ts';
import { FakeEmbeddingPort } from './fake-embedding.port.ts';
import { IndexingService } from './indexing.service.ts';
import { OpenAiCompatibleEmbeddingPort } from './openai-embedding.port.ts';

/**
 * Chunks, embeddings and indexing for retrieval (ADR 0007). Global so the services
 * that change content (Attachments, Spec, Decisions) can schedule indexing.
 * VORASAAN_AI=fake embeds with the deterministic fake, like the AI port.
 * Tests replace EMBEDDING_PORT_FACTORY via overrideProvider.
 */
@Global()
@Module({
  controllers: [EmbeddingSettingsController],
  providers: [
    {
      provide: EMBEDDING_PORT_FACTORY,
      useFactory: (): EmbeddingPortFactory => {
        if (process.env.VORASAAN_AI === 'fake') {
          new Logger('RetrievalModule').warn('VORASAAN_AI=fake: using fake embeddings');
          return (config) => new FakeEmbeddingPort(config.model);
        }
        return (config) => new OpenAiCompatibleEmbeddingPort(config);
      },
    },
    ContentChunkRepository,
    EmbeddingSettingsService,
    IndexingService,
  ],
  exports: [ContentChunkRepository, EmbeddingSettingsService, IndexingService],
})
export class RetrievalModule {}
