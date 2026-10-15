import {
  type AiProvider,
  type AiTask as AiTaskKind,
  REASONING_DEFAULTS,
  type ReasoningLevel,
  type ReasoningSupport,
} from '@vorasaan/shared';
import { AI_TASKS, type AiTask } from './ai.config.ts';
import type { MastraModel, ResolvedProvider } from './model-config.ts';

// The Reasoning Level (ticket 0081): one setting, LOW, MEDIUM or HIGH, that the server maps
// to each provider's own control, as the AI SDK providers Mastra bundles take them:
// - Gemini (`google/…`): `providerOptions.google.thinkingConfig`, a `thinkingLevel` on
//   Gemini 3 and later, a `thinkingBudget` on 2.5 (ticket 0080's rules);
// - Anthropic: `providerOptions.anthropic.effort`, sent as `output_config.effort`;
// - OpenAI reasoning models: `providerOptions.openai.reasoningEffort`;
// - OpenRouter: `providerOptions.openrouter.reasoning`, sent as the body's `reasoning`;
// - an OpenAI-compatible endpoint: nothing (servers differ).
// A model known to refuse the parameter gets none.

/** The provider kind and model id a call runs on, as far as reasoning is concerned. */
export type ReasoningTarget = { kind: AiProvider; modelId: string } | null;

/** Mastra's "provider/" prefixes, and the kind each one is. */
const PREFIXES: Partial<Record<string, AiProvider>> = {
  anthropic: 'ANTHROPIC',
  openai: 'OPENAI',
  openrouter: 'OPENROUTER',
  google: 'GEMINI',
};

function fromRouterId(id: string): ReasoningTarget {
  const [prefix, ...rest] = id.split('/');
  const kind = prefix ? PREFIXES[prefix.toLowerCase()] : undefined;
  return kind && rest.length ? { kind, modelId: rest.join('/') } : null;
}

/** The target of a Mastra model: a config with its own URL is an OpenAI-compatible endpoint. */
export function reasoningTargetOf(model: MastraModel): ReasoningTarget {
  if (typeof model === 'string') return fromRouterId(model);
  if ('url' in model) return { kind: 'OPENAI_COMPATIBLE', modelId: model.modelId };
  return fromRouterId(model.id);
}

/** The target of a model chosen for a call (an Approved Model, or an env "provider/model"). */
export function reasoningTargetOfChoice(choice: {
  provider: ResolvedProvider | null;
  name: string;
}): ReasoningTarget {
  if (choice.provider) return { kind: choice.provider.provider, modelId: choice.provider.model };
  return fromRouterId(choice.name);
}

type Effort = 'low' | 'medium' | 'high';
const effortOf = (level: ReasoningLevel): Effort => level.toLowerCase() as Effort;

/** Gemini's thinking settings, as the AI SDK's Google provider takes them. */
export type GeminiThinkingConfig =
  | { thinkingLevel: 'low' | 'medium' | 'high' }
  | { thinkingBudget: number };

/**
 * Gemini's thinking for one model id (without `google/`), or null to send nothing
 * (ticket 0080's model-family rules):
 * - `gemini-2.5-…` takes a budget: LOW is 0 on Flash and Flash-Lite (off) and 128 on Pro
 *   (its least), MEDIUM 2,048, HIGH nothing (2.5's own dynamic thinking).
 * - Older Gemini models (`gemini-1.…`, `gemini-2.0-…`) don't think: nothing.
 * - Every other `gemini-…` (Gemini 3 and later, the `-latest` aliases) takes the level.
 * - Anything else (Gemma, `gemma-…`) refuses thinking settings: nothing.
 */
export function geminiThinkingConfig(
  modelId: string,
  level: ReasoningLevel,
): GeminiThinkingConfig | null {
  const id = modelId.trim().toLowerCase();
  if (!id.startsWith('gemini-') || /^gemini-(1\.|2\.0)/.test(id)) return null;
  if (id.startsWith('gemini-2.')) {
    if (level === 'HIGH') return null;
    if (level === 'MEDIUM') return { thinkingBudget: 2048 };
    return { thinkingBudget: id.includes('-pro') ? 128 : 0 };
  }
  return { thinkingLevel: effortOf(level) };
}

/**
 * Anthropic's `effort`, for the models that have it: Opus 4.5 and later, Sonnet 4.6 and
 * later, and every family from Claude 5 on. Older models refuse it with a 400: nothing.
 * Thinking itself is never set (no `thinking: {type: "disabled"}`, no budget): models
 * that always think refuse that, and effort already bounds it.
 */
export function anthropicEffort(modelId: string, level: ReasoningLevel): Effort | null {
  const id = modelId.trim().toLowerCase();
  const supported =
    /^claude-(opus-4-[5-9]|sonnet-4-[6-9])(-|$)/.test(id) ||
    /^claude-[a-z]+-([5-9]|[1-9]\d)(-|$)/.test(id);
  return supported ? effortOf(level) : null;
}

/**
 * OpenAI's `reasoningEffort`, for its reasoning models only, by the same rule as the AI
 * SDK's OpenAI provider: the o-series, and GPT-5 and later except the chat models.
 */
export function openAiReasoningEffort(modelId: string, level: ReasoningLevel): Effort | null {
  const id = modelId.trim().toLowerCase();
  if (/^o\d+(-|$)/.test(id)) return effortOf(level);
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(id);
  if (!gpt) return null;
  const isChat = gpt[2] === undefined && (gpt[3]?.startsWith('chat') ?? false);
  return Number(gpt[1]) >= 5 && !isChat ? effortOf(level) : null;
}

/**
 * OpenRouter's `reasoning: { effort }`, which it maps to each model's own control and
 * leaves out for models without one. Gemma refuses any thinking setting: nothing.
 */
export function openRouterReasoning(
  modelId: string,
  level: ReasoningLevel,
): { effort: Effort } | null {
  const name = modelId.trim().toLowerCase().split('/').pop() ?? '';
  return name.startsWith('gemma-') ? null : { effort: effortOf(level) };
}

/** Per-call provider options for Mastra's `agent.stream`: the reasoning parameter. */
export type ModelProviderOptions =
  | { google: { thinkingConfig: GeminiThinkingConfig } }
  | { anthropic: { effort: Effort } }
  | { openai: { reasoningEffort: Effort } }
  | { openrouter: { reasoning: { effort: Effort } } };

/** The reasoning parameter for one target and level, or null to send nothing. */
export function reasoningOptionsFor(
  target: ReasoningTarget,
  level: ReasoningLevel | null,
): ModelProviderOptions | null {
  if (!target || !level) return null;
  switch (target.kind) {
    case 'GEMINI': {
      const thinkingConfig = geminiThinkingConfig(target.modelId, level);
      return thinkingConfig ? { google: { thinkingConfig } } : null;
    }
    case 'ANTHROPIC': {
      const effort = anthropicEffort(target.modelId, level);
      return effort ? { anthropic: { effort } } : null;
    }
    case 'OPENAI': {
      const reasoningEffort = openAiReasoningEffort(target.modelId, level);
      return reasoningEffort ? { openai: { reasoningEffort } } : null;
    }
    case 'OPENROUTER': {
      const reasoning = openRouterReasoning(target.modelId, level);
      return reasoning ? { openrouter: { reasoning } } : null;
    }
    case 'OPENAI_COMPATIBLE':
      return null;
  }
}

/** The provider options a call on this model carries at this level, or null. */
export function providerOptionsOf(
  model: MastraModel,
  level: ReasoningLevel | null,
): ModelProviderOptions | null {
  return reasoningOptionsFor(reasoningTargetOf(model), level);
}

const LEVELS: readonly ReasoningLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

/** Whether a model's thinking can be set at all, and why not. */
export function reasoningSupport(target: ReasoningTarget): ReasoningSupport {
  if (!target || target.kind === 'OPENAI_COMPATIBLE') {
    return { supported: false, reason: 'Not supported by this provider' };
  }
  if (LEVELS.some((level) => reasoningOptionsFor(target, level))) {
    return { supported: true, reason: null };
  }
  return { supported: false, reason: 'This model has no reasoning control' };
}

/** The level a call sends to its model: null when the model has no control. */
export function sentReasoningLevel(
  target: ReasoningTarget,
  level: ReasoningLevel | null,
): ReasoningLevel | null {
  return reasoningOptionsFor(target, level) ? level : null;
}

// ─── The level of a call ──────────────────────────────────────────────────

/** Calls of a Settings task whose default differs from the task's (`REASONING_DEFAULTS`). */
const CALL_DEFAULTS: Partial<Record<AiTask, ReasoningLevel>> = {
  draftSpecFromAttachments: 'MEDIUM',
  redraftDesignDoc: 'LOW',
};

/**
 * The level a call runs at until an Admin sets its task's: LOW for the structured tasks
 * (Choices, summaries, Redrafts, suggestions, Grilling…), MEDIUM for chat, a Spec drafted
 * from Attachments and Design Docs.
 */
export function defaultReasoningLevel(task: AiTask): ReasoningLevel {
  return CALL_DEFAULTS[task] ?? REASONING_DEFAULTS[AI_TASKS[task].kind].level;
}

/** A level from the env, or `OFF`: send no reasoning parameter at all. */
export type EnvReasoning = ReasoningLevel | 'OFF';

/** `low`, `medium`, `high`, or `off` (also `default`, as 0080's variable took it). */
function parseEnvReasoning(value: string | undefined): EnvReasoning | undefined {
  const v = value?.trim().toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v.toUpperCase() as ReasoningLevel;
  if (v === 'off' || v === 'default') return 'OFF';
  return undefined;
}

/** `VORASAAN_REASONING_<TASK>`: the same suffix as the task's `VORASAAN_MODEL_<TASK>`. */
export function reasoningEnvName(task: AiTask): string {
  return AI_TASKS[task].env.replace(/^VORASAAN_MODEL_/, 'VORASAAN_REASONING_');
}

/** For every task. */
export const GLOBAL_REASONING_ENV = 'VORASAAN_REASONING';
/** Ticket 0080's Gemini-only variable (`low`, `high`, `default`), still read for Gemini. */
export const GEMINI_THINKING_ENV = 'VORASAAN_GEMINI_THINKING';

/**
 * The operator's level for a call, and the variable it came from: the task's
 * `VORASAAN_REASONING_<TASK>`, else `VORASAAN_REASONING`, else, on a Gemini model only,
 * `VORASAAN_GEMINI_THINKING` (`default` there means off). Unknown values are ignored.
 */
export function envReasoningOverride(
  task: AiTask,
  target: ReasoningTarget,
  env: Record<string, string | undefined> = process.env,
): { value: EnvReasoning; from: string } | undefined {
  const names = [reasoningEnvName(task), GLOBAL_REASONING_ENV];
  if (target?.kind === 'GEMINI') names.push(GEMINI_THINKING_ENV);
  for (const from of names) {
    const value = parseEnvReasoning(env[from]);
    if (value) return { value, from };
  }
  return undefined;
}

/**
 * The level of a connection test (no task): LOW, unless the operator set
 * `VORASAAN_REASONING` (or, on Gemini, `VORASAAN_GEMINI_THINKING`); `off` sends nothing.
 */
export function connectionTestReasoning(
  target: ReasoningTarget,
  env: Record<string, string | undefined> = process.env,
): ReasoningLevel | null {
  const names = [GLOBAL_REASONING_ENV, ...(target?.kind === 'GEMINI' ? [GEMINI_THINKING_ENV] : [])];
  for (const name of names) {
    const value = parseEnvReasoning(env[name]);
    if (value) return value === 'OFF' ? null : value;
  }
  return 'LOW';
}

/** The reasoning variables set for one Settings task (shown in Settings, since they win). */
export function reasoningEnvOverridesFor(
  kind: AiTaskKind,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const names = (Object.keys(AI_TASKS) as AiTask[])
    .filter((task) => AI_TASKS[task].kind === kind)
    .map(reasoningEnvName);
  return [...names, GLOBAL_REASONING_ENV].filter((name) => parseEnvReasoning(env[name]));
}

/** The Reasoning Level one call runs at, and where it came from; `level` null sends nothing. */
export type ReasoningChoice = {
  level: ReasoningLevel | null;
  source: 'MESSAGE' | 'ENV' | 'SETTINGS' | 'DEFAULT';
};

/**
 * The level of one call: the message's ("Think deeper"), else the operator's env
 * override, else the Admin's setting for the task, else the task's default. `off` in the
 * env sends nothing, whatever the message asks.
 */
export function chooseReasoning(input: {
  task: AiTask;
  target: ReasoningTarget;
  message?: ReasoningLevel | null;
  setting?: ReasoningLevel | null;
  env?: Record<string, string | undefined>;
}): ReasoningChoice {
  const override = envReasoningOverride(input.task, input.target, input.env ?? process.env);
  if (override?.value === 'OFF') return { level: null, source: 'ENV' };
  if (input.message) return { level: input.message, source: 'MESSAGE' };
  if (override) return { level: override.value, source: 'ENV' };
  if (input.setting) return { level: input.setting, source: 'SETTINGS' };
  return { level: defaultReasoningLevel(input.task), source: 'DEFAULT' };
}

/**
 * Whether "Think deeper" can work on a chat on this model: the model has a control, and
 * the operator hasn't turned reasoning off for chat.
 */
export function chatReasoningSupport(
  target: ReasoningTarget,
  env: Record<string, string | undefined> = process.env,
): ReasoningSupport {
  const support = reasoningSupport(target);
  if (!support.supported) return support;
  const override = envReasoningOverride('chat', target, env);
  if (override?.value === 'OFF') {
    return { supported: false, reason: `Turned off on the server (${override.from})` };
  }
  return support;
}

// ─── A provider refusing the parameter ────────────────────────────────────

/** Words a provider's 400 uses for the reasoning parameter it refused. */
const REASONING_WORDS = /think|reasoning|effort|budget|output_config/i;

/**
 * Whether a failed call is a 400 caused by the reasoning parameter: the AI SDK's
 * `APICallError` (anywhere in the cause chain) with status 400 whose message or body
 * names thinking, reasoning, effort, a budget or `output_config`. A call failing so is retried once
 * without the parameter.
 */
export function isReasoningRefusal(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const e = current as { statusCode?: unknown; message?: unknown; responseBody?: unknown };
    if (e.statusCode === 400) {
      const text = `${String(e.message ?? '')} ${String(e.responseBody ?? '')}`;
      if (REASONING_WORDS.test(text)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
