import { Readable } from 'node:stream';
import { Body, Controller, Get, Put, StreamableFile } from '@nestjs/common';
import { ReceiptSettingsInput } from '@vorasaan/shared';
import { AdminOnly } from '../auth/admin.guard.ts';
import { ReceiptsService } from './receipts.service.ts';

/**
 * Settings → AI → Receipts (ADR 0015, ticket 0070), Admins only: collection on or off,
 * retention, how many Receipts are kept, and their JSONL export
 * (`ReceiptExportLine` per line, documented in docs/receipts-export.md).
 */
@AdminOnly()
@Controller('settings/ai/receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get()
  view() {
    return this.receipts.view();
  }

  @Put()
  update(@Body({ schema: ReceiptSettingsInput }) body: ReceiptSettingsInput) {
    return this.receipts.update(body);
  }

  /** Streamed a page at a time, so a large export never sits in memory whole. */
  @Get('export')
  export() {
    const day = new Date().toISOString().slice(0, 10);
    return new StreamableFile(Readable.from(this.receipts.exportLines()), {
      type: 'application/x-ndjson; charset=utf-8',
      disposition: `attachment; filename="vorasaan-receipts-${day}.jsonl"`,
    });
  }
}
