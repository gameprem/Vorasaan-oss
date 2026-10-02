import { Inject, Injectable } from '@nestjs/common';
import type { ChatProvider } from '@vorasaan/shared';
import type { ChatAppAdapter, ChatCredentials } from './adapters/adapter.ts';
import { LineAdapter } from './adapters/line.ts';
import { SlackAdapter } from './adapters/slack.ts';
import { TeamsAdapter } from './adapters/teams.ts';
import { TEAMS_KEY_SOURCE, type TeamsKeySource } from './adapters/teams-keys.ts';

/** The adapter of each chat app. */
@Injectable()
export class ChatAdapters {
  readonly LINE = new LineAdapter();
  readonly SLACK = new SlackAdapter();
  readonly TEAMS: TeamsAdapter;

  constructor(@Inject(TEAMS_KEY_SOURCE) keys: TeamsKeySource) {
    this.TEAMS = new TeamsAdapter(keys);
  }

  get<P extends ChatProvider>(provider: P): ChatAppAdapter<ChatCredentials[P]> {
    return this[provider] as unknown as ChatAppAdapter<ChatCredentials[P]>;
  }
}
