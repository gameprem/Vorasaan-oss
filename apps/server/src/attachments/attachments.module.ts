import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.ts';
import { AttachmentsController } from './attachments.controller.ts';
import { AttachmentsService } from './attachments.service.ts';
import {
  ATTACHMENT_SNAPSHOTTERS,
  type AttachmentSnapshotter,
  ConfluenceSnapshotter,
  FileSnapshotter,
  JiraSnapshotter,
  UrlSnapshotter,
} from './snapshotters.ts';

@Module({
  imports: [StorageModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    FileSnapshotter,
    UrlSnapshotter,
    ConfluenceSnapshotter,
    JiraSnapshotter,
    // One snapshotter per AttachmentSource.
    {
      provide: ATTACHMENT_SNAPSHOTTERS,
      useFactory: (...snapshotters: AttachmentSnapshotter[]) => snapshotters,
      inject: [FileSnapshotter, UrlSnapshotter, ConfluenceSnapshotter, JiraSnapshotter],
    },
  ],
})
export class AttachmentsModule {}
