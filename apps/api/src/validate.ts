import type { z } from 'zod';
import { ApiError } from './errors.ts';

/**
 * Parse untrusted input, converting a Zod failure into a 400 that names the
 * offending fields. Handlers get a fully typed value and never see `unknown`.
 */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);

  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    throw ApiError.badRequest(detail, 'validation_failed');
  }

  return result.data;
}
