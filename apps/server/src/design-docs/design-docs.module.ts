import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module.ts';
import { DesignDocsController } from './design-docs.controller.ts';
import { DesignDocsService } from './design-docs.service.ts';

/**
 * Design Docs per Platform (ADR 0014, ticket 0069). It listens to `SpecChanges` (a global
 * module), so the Spec, Org and Platforms services tell it about changes without importing it.
 */
@Module({
  imports: [InboxModule],
  controllers: [DesignDocsController],
  providers: [DesignDocsService],
  exports: [DesignDocsService],
})
export class DesignDocsModule {}
