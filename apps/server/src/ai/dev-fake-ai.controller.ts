import { Body, Controller, HttpCode, Inject, NotFoundException, Post } from '@nestjs/common';
import { z } from 'zod';
import { devAuthEnabled } from '../auth/identity.guard.ts';
import type { AiPort, ChatChunk } from './ai.port.ts';
import { FakeAiPort } from './fake-ai.port.ts';
import { AI_ENGINE } from './mastra.module.ts';

/** One scripted reply: text pieces and tool calls, an optional failure at the end, a pace. */
const ScriptedReply = z.strictObject({
  chunks: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('text'), delta: z.string() }),
        z.strictObject({
          type: z.literal('tool-call'),
          call: z.strictObject({
            id: z.string().min(1),
            name: z.string().min(1),
            args: z.unknown(),
          }),
        }),
      ]),
    )
    .max(500),
  /** Fails the reply after its chunks, as a provider failing mid-stream. */
  error: z.string().min(1).optional(),
  /** Waits this long before each chunk, to watch a reply stream or stop it. */
  chunkDelayMs: z.int().min(0).max(2_000).optional(),
});

const ChatScriptInput = z.strictObject({ replies: z.array(ScriptedReply).min(1).max(20) });
type ChatScriptInput = z.infer<typeof ChatScriptInput>;

/**
 * DEV ONLY (ticket 0046): queues the fake AI's next chat replies, so the web's
 * end-to-end tests can make it call a tool and get an Action Card. It answers
 * 404 unless the server runs the fake AI (VORASAAN_AI=fake) with dev sign-in
 * (VORASAAN_DEV_AUTH=true), so it never exists next to a real model. The queue
 * is the process's own: the next chat reply anyone asks for takes the next entry.
 */
@Controller('dev/fake-ai')
export class DevFakeAiController {
  constructor(@Inject(AI_ENGINE) private readonly engine: AiPort) {}

  @Post('chat-script')
  @HttpCode(204)
  script(@Body({ schema: ChatScriptInput }) body: ChatScriptInput): void {
    if (!devAuthEnabled() || !(this.engine instanceof FakeAiPort)) throw new NotFoundException();
    this.engine.scriptChat(
      ...body.replies.map((r) => ({
        chunks: r.chunks as ChatChunk[],
        ...(r.error ? { error: new Error(r.error) } : {}),
        ...(r.chunkDelayMs ? { chunkDelayMs: r.chunkDelayMs } : {}),
      })),
    );
  }
}
