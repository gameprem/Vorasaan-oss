import { CONTEXT_WINDOW_LIMITS, knownContextWindow } from '@vorasaan/shared';

// How many tokens one call to a model may hold, prompt and reply together
// (ADR 0012, ticket 0060). An Approved Model stores its own `contextWindow`,
// prefilled when it is created (KNOWN_CONTEXT_WINDOWS in @vorasaan/shared, else
// the default) and editable by an Admin. An env model (VORASAAN_MODEL*) uses
// VORASAAN_CONTEXT_WINDOW when it is set, else the known window, else the default.

/** The window of a model nobody knows, unless VORASAAN_CONTEXT_WINDOW says otherwise. */
export const DEFAULT_CONTEXT_WINDOW = 32_000;

/** VORASAAN_CONTEXT_WINDOW, when it is a whole number within the limits; else undefined. */
export function envContextWindow(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.VORASAAN_CONTEXT_WINDOW?.trim().replaceAll('_', '');
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) return undefined;
  if (value < CONTEXT_WINDOW_LIMITS.min || value > CONTEXT_WINDOW_LIMITS.max) return undefined;
  return value;
}

/** The window a new Approved Model gets when the Admin doesn't give one. */
export function prefilledContextWindow(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): number {
  return knownContextWindow(modelId) ?? envContextWindow(env) ?? DEFAULT_CONTEXT_WINDOW;
}

/** The window of an env model ("provider/model"): VORASAAN_CONTEXT_WINDOW wins, then the known one. */
export function envModelContextWindow(
  name: string,
  env: Record<string, string | undefined> = process.env,
): number {
  return envContextWindow(env) ?? knownContextWindow(name) ?? DEFAULT_CONTEXT_WINDOW;
}
