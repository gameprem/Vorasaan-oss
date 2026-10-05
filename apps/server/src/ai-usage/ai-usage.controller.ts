import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { AiBudgetInput, AiUsageQuery } from '@vorasaan/shared';
import { AdminOnly } from '../auth/admin.guard.ts';
import { AiUsageService } from './ai-usage.service.ts';

/**
 * Settings → AI usage (ticket 0075), Admins only: what the AI costs, where and what it
 * buys, from the Receipts; and the Organization's monthly AI budget.
 */
@AdminOnly()
@Controller('settings/ai/usage')
export class AiUsageController {
  constructor(private readonly usage: AiUsageService) {}

  @Get()
  view(@Query({ schema: AiUsageQuery }) query: AiUsageQuery) {
    return this.usage.view(query);
  }

  @Put('budget')
  setBudget(@Body({ schema: AiBudgetInput }) body: AiBudgetInput) {
    return this.usage.setBudget(body);
  }
}
