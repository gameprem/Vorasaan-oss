import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  ChatAppSettingsInput,
  ChatPreferencesInput,
  type ChatProvider,
  ChatProviderSlug,
  chatProviderOfSlug,
} from '@vorasaan/shared';
import { AdminOnly } from '../auth/admin.guard.ts';
import { CurrentUser, Public } from '../auth/identity.guard.ts';
import { VerbatimBody, type VerbatimRequest } from '../http/verbatim-body.ts';
import { ChatAccountsService } from './chat-accounts.service.ts';
import { ChatAppSettingsService } from './chat-app-settings.service.ts';
import { ChatEventsService } from './chat-events.service.ts';

/** `line`, `slack` or `teams` in a path; anything else is 404. */
function providerOf(slug: string): ChatProvider {
  const parsed = ChatProviderSlug.safeParse(slug);
  if (!parsed.success) throw new NotFoundException('No such chat app');
  return chatProviderOfSlug(parsed.data);
}

/** Settings → Chat apps (Admins). Secrets are write-only. */
@AdminOnly()
@Controller('settings/chat-apps')
export class ChatAppSettingsController {
  constructor(private readonly settings: ChatAppSettingsService) {}

  @Get()
  view() {
    return this.settings.view();
  }

  @Put()
  save(@Body({ schema: ChatAppSettingsInput }) body: ChatAppSettingsInput) {
    return this.settings.save(body);
  }

  /** Turns the chat app off: its credentials, every link to it and pending codes go. */
  @Delete(':provider')
  turnOff(@Param('provider') slug: string) {
    return this.settings.turnOff(providerOf(slug));
  }
}

/** A person's own chat accounts and chat preferences (Settings → Notifications). */
@Controller('me')
export class MyChatAppsController {
  constructor(private readonly accounts: ChatAccountsService) {}

  @Get('chat-apps')
  mine(@CurrentUser() user: User) {
    return this.accounts.mine(user);
  }

  @Post('chat-apps/:provider/link-code')
  linkCode(@CurrentUser() user: User, @Param('provider') slug: string) {
    return this.accounts.createLinkCode(user, providerOf(slug));
  }

  @Delete('chat-apps/:provider')
  @HttpCode(204)
  async unlink(@CurrentUser() user: User, @Param('provider') slug: string): Promise<void> {
    await this.accounts.unlink(user, providerOf(slug));
  }

  @Get('chat-preferences')
  preferences(@CurrentUser() user: User) {
    return this.accounts.preferences(user);
  }

  @Put('chat-preferences')
  savePreferences(
    @CurrentUser() user: User,
    @Body({ schema: ChatPreferencesInput }) body: ChatPreferencesInput,
  ) {
    return this.accounts.savePreferences(user, body);
  }
}

/**
 * Callbacks from LINE, Slack and Teams. No Vorasaan identity: the provider's signature
 * is the only authentication, checked over the raw bytes before the body is read.
 */
@Public()
@Controller('chat-apps')
export class ChatEventsController {
  constructor(private readonly events: ChatEventsService) {}

  @Post(':provider/events')
  @HttpCode(200)
  @VerbatimBody()
  async receive(@Param('provider') slug: string, @Req() request: VerbatimRequest) {
    const response = await this.events.handle(providerOf(slug), {
      body: request.verbatimBody ?? Buffer.alloc(0),
      headers: request.headers,
      contentType: request.verbatimContentType,
    });
    return response ?? '';
  }
}
