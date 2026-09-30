import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.ts';
import { AttachmentsController } from './attachments.controller.ts';
import { AttachmentsService } from './attachments.service.ts';
import {
  ATTACHMENT_SNAPSHOTTERS,
  type AttachmentSnapshotter,
  FileSnapshotter,
  UrlSnapshotter,
} from './snapshotters.ts';

@Module({
  imports: [StorageModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    FileSnapshotter,
    UrlSnapshotter,
    // One snapshotter per AttachmentSource; add Confluence and Jira here.
    {
      provide: ATTACHMENT_SNAPSHOTTERS,
      useFactory: (...snapshotters: AttachmentSnapshotter[]) => snapshotters,
      inject: [FileSnapshotter, UrlSnapshotter],
    },
  ],
})
export class AttachmentsModule {}
