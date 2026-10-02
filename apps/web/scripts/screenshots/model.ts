// A scripted stand-in for an OpenAI-compatible model, for the README screenshots only.
//
// The server talks to it as an ordinary "custom endpoint" AI Provider, so every AI
// output on screen goes through the real code path (Mastra, structured output, chat
// tools, Action Cards). What it answers comes from story.ts: it recognises each task by
// the structure it is asked for and each request by its title or question.

import type { Server } from 'bun';
import { CHOICES, type ChatReply, FOLLOW_UPS, GRILLING_QUESTIONS, SPEC_PROPOSALS } from './story';

type ChatMessage = { role: string; content?: string | { type: string; text?: string }[] };
type Completion = {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: unknown[];
  response_format?: { json_schema?: { schema?: { properties?: Record<string, unknown> } } };
};
type Delta = { role?: string; content?: string; tool_calls?: unknown[] };

export type ScriptedModel = {
  url: string;
  /** Queues the next chat replies; a reply with a tool call needs a second one after it. */
  chat: (...replies: ChatReply[]) => void;
  /** The chat replies queued and not asked for yet (0 once the turns are done). */
  pending: () => number;
  stop: () => void;
};

const text = (m: ChatMessage | undefined) =>
  typeof m?.content === 'string'
    ? m.content
    : (m?.content ?? []).map((part) => part.text ?? '').join('');

/** The value after `- Title: ` in a task prompt (the Decision Request's title). */
const titleIn = (prompt: string) => /^- Title: (.+)$/m.exec(prompt)?.[1]?.trim() ?? '';

function lookup<T>(table: Record<string, T>, key: string, task: string): T {
  const found = table[key];
  if (found === undefined) throw new Error(`The screenshot model has no ${task} for "${key}"`);
  return found;
}

/** The structured answer for one task prompt, by the properties it must have. */
function structured(properties: string[], prompt: string): unknown {
  const has = (...names: string[]) => names.every((n) => properties.includes(n));
  if (has('suggestedRole', 'choices')) return lookup(CHOICES, titleIn(prompt), 'Choices');
  if (has('proposedMarkdown', 'summary')) {
    return lookup(SPEC_PROPOSALS, titleIn(prompt), 'Spec Proposal');
  }
  if (has('questions')) {
    const round = /This is the \*\*(\w+)\*\* round/.exec(prompt)?.[1] ?? '';
    return { questions: lookup(GRILLING_QUESTIONS, round, 'Grilling round') };
  }
  if (has('followUp')) {
    const followUp = FOLLOW_UPS.find((f) => prompt.includes(f.when) && !prompt.includes(f.until));
    return { followUp: followUp?.ask ?? null };
  }
  if (has('summary')) return { summary: 'A short summary of the earlier messages.' };
  throw new Error(`The screenshot model can't answer a task with ${properties.join(', ')}`);
}

/** Splits text into word-sized pieces, as a model streams it. */
const pieces = (s: string) => s.match(/\S+\s*|\s+/g) ?? [];

function sse(model: string, deltas: Delta[], finish: 'stop' | 'tool_calls'): Response {
  const encoder = new TextEncoder();
  const chunk = (delta: Delta, finishReason: string | null) =>
    encoder.encode(
      `data: ${JSON.stringify({
        id: 'chatcmpl-screens',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(finishReason
          ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
          : {}),
      })}\n\n`,
    );
  return new Response(
    new ReadableStream({
      start(controller) {
        deltas.forEach((delta, i) => {
          controller.enqueue(chunk(i === 0 ? { role: 'assistant', ...delta } : delta, null));
        });
        controller.enqueue(chunk({}, finish));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

export function startScriptedModel(port: number): ScriptedModel {
  const queue: ChatReply[] = [];

  const answer = (body: Completion): Response => {
    const properties = Object.keys(body.response_format?.json_schema?.schema?.properties ?? {});
    if (properties.length) {
      const prompt = text(body.messages.findLast((m) => m.role === 'user'));
      const json = JSON.stringify(structured(properties, prompt));
      return sse(
        body.model,
        pieces(json).map((content) => ({ content })),
        'stop',
      );
    }
    // A Conversation turn: the next scripted reply. Anything else (a connection test).
    const isChat = body.messages.some((m) => text(m).includes('You are in a **Conversation**'));
    const reply = isChat ? queue.shift() : { text: 'OK' };
    if (!reply) throw new Error('The screenshot model was asked for a chat reply it has not got');
    const deltas: Delta[] = pieces(reply.text).map((content) => ({ content }));
    if (reply.tool) {
      deltas.push({
        tool_calls: [
          {
            index: 0,
            id: `call_${reply.tool.name}_${Date.now().toString(36)}`,
            type: 'function',
            function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
          },
        ],
      });
    }
    return sse(body.model, deltas, reply.tool ? 'tool_calls' : 'stop');
  };

  const server: Server<undefined> = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
        return new Response('Not found', { status: 404 });
      }
      try {
        return answer((await request.json()) as Completion);
      } catch (error) {
        console.error(`  ✖ ${(error as Error).message}`);
        return Response.json({ error: { message: (error as Error).message } }, { status: 500 });
      }
    },
  });

  return {
    url: `http://localhost:${port}/v1`,
    chat: (...replies) => queue.push(...replies),
    pending: () => queue.length,
    stop: () => server.stop(true),
  };
}
