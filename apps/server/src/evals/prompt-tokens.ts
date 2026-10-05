import type { AiTask } from '../ai/ai.config.ts';
import type { AiCallOptions, AiPort, ChatChunk } from '../ai/ai.port.ts';
import { toolTokens } from '../ai/context-budget.ts';
import type { LanguageStrategy } from '../ai/language.ts';
import { cacheBreakpoints, type Prompt } from '../ai/prompt-cache.ts';
import { chatPrompt, type PromptOptions, type PromptTask, TASK_PROMPTS } from '../ai/prompts.ts';
import { estimateMessageTokens } from '../ai/token-count.ts';
import { estimateTokens } from '../retrieval/token-estimate.ts';

// Token measurements of every AI task (ticket 0076). A real provider reports what a call
// cost in its Receipt; without one (tests, the eval guard, `bun run tokens:tasks`), this
// port renders the exact prompt `MastraAiPort` would send (`TASK_PROMPTS`) and reports its
// size by the script-aware estimate (ticket 0059) as the call's usage, so its Receipt
// carries what the call would cost. The answer comes from the port it wraps (the fake).

/** What one call's prompt costs, by the estimate. */
export type PromptMeasure = {
  task: AiTask;
  /** The whole prompt (a chat: its instructions, messages and tools). */
  tokens: number;
  /** The part a provider can cache: the prefix through the last marked cut (ticket 0061). */
  cacheable: number;
  /** The rest, sent and paid in full on every call. */
  uncached: number;
  /** The answer, as JSON (a chat: its text). */
  output: number;
};

/** How much of a prompt can be cached: the prefix through its last marked part. */
export function cacheableTokens(prompt: Prompt): number {
  const marked = cacheBreakpoints(prompt.parts);
  const last = marked.at(-1);
  if (last === undefined) return 0;
  return estimateTokens(prompt.parts.slice(0, last + 1).join(''));
}

function measureOf(task: AiTask, prompt: Prompt, extra: number, output: number): PromptMeasure {
  const tokens = estimateTokens(prompt.text) + extra;
  const cacheable = cacheableTokens(prompt);
  return { task, tokens, cacheable, uncached: tokens - cacheable, output };
}

/**
 * An `AiPort` that measures every call's prompt and answers with `inner`. Each call's
 * usage (for its Receipt) is its measure: input tokens, output tokens, no cache use.
 */
export function measuringAiPort(
  inner: AiPort,
  options: { strategy?: LanguageStrategy; onMeasure?: (measure: PromptMeasure) => void } = {},
): AiPort {
  const lang = (call: AiCallOptions | undefined): PromptOptions => ({
    language: call?.language,
    strategy: options.strategy ?? 'direct',
    template: call?.prompt?.template ?? null,
  });
  const report = (measure: PromptMeasure, call: AiCallOptions | undefined) => {
    options.onMeasure?.(measure);
    call?.onUsage?.({
      inputTokens: measure.tokens,
      outputTokens: measure.output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  };
  // The inner port's own usage is not reported: the measure replaces it.
  const quiet = (call: AiCallOptions | undefined): AiCallOptions | undefined =>
    call ? { ...call, onUsage: undefined } : call;

  const port: Partial<Record<keyof AiPort, unknown>> = {
    countTokens: (input: Parameters<AiPort['countTokens']>[0], call?: AiCallOptions) =>
      inner.countTokens(input, call),
    chat: async function* (
      input: Parameters<AiPort['chat']>[0],
      call?: AiCallOptions,
    ): AsyncIterable<ChatChunk> {
      const prompt = await chatPrompt(input, lang(call));
      const extra =
        input.recentMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0) +
        toolTokens(input.tools);
      let text = '';
      for await (const chunk of inner.chat(input, quiet(call))) {
        if (chunk.type === 'usage') continue;
        if (chunk.type === 'text') text += chunk.delta;
        yield chunk;
      }
      const measure = measureOf('chat', prompt, extra, estimateTokens(text));
      report(measure, call);
      yield {
        type: 'usage',
        usage: { inputTokens: measure.tokens, cacheReadTokens: 0 },
      };
    },
  };
  for (const task of Object.keys(TASK_PROMPTS) as PromptTask[]) {
    port[task] = async (input: never, call?: AiCallOptions) => {
      const render = TASK_PROMPTS[task] as (i: never, l: PromptOptions) => Promise<Prompt>;
      const prompt = await render(input, lang(call));
      const method = inner[task] as (i: never, o?: AiCallOptions) => Promise<unknown>;
      const output = await method.call(inner, input, quiet(call));
      report(measureOf(task, prompt, 0, estimateTokens(JSON.stringify(output) ?? '')), call);
      return output;
    };
  }
  return port as AiPort;
}
