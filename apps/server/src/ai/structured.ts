import type { z } from 'zod';
import { AiOutputError } from './ai.port.ts';
import type { Prompt } from './prompt-cache.ts';

/**
 * One structured LLM call: returns the raw object the model produced. A Prompt
 * carries its cache breakpoints (ticket 0061); a string has none.
 */
export type StructuredGenerate = (prompt: Prompt | string, schema: z.ZodType) => Promise<unknown>;

/**
 * Calls the model and validates the result against `schema`.
 * Invalid output (or a failed call) is retried once, then surfaces as AiOutputError.
 */
export async function generateStructured<T extends z.ZodType>(
  generate: StructuredGenerate,
  task: string,
  prompt: Prompt | string,
  schema: T,
): Promise<z.infer<T>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await generate(prompt, schema);
      const parsed = schema.safeParse(raw);
      if (parsed.success) return parsed.data;
      lastError = parsed.error;
    } catch (error) {
      lastError = error;
    }
  }
  throw new AiOutputError(task, lastError);
}
