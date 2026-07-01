import { encode } from '@toon-format/toon';
import type { OutputFormat } from '@/config.ts';

/** Default page size when the agent does not specify `limit`, by format. */
const DEFAULT_LIMIT_TOON = 200;
const DEFAULT_LIMIT_JSON = 100;

/**
 * Resolve the effective output format.
 *
 * Precedence: per-call param → configured default → `"toon"`.
 */
export function resolveFormat(
  param: OutputFormat | undefined,
  fallback: OutputFormat,
): OutputFormat {
  return param ?? fallback;
}

/** Encode shaped data as a string in the requested format. */
export function formatResponse(data: unknown, format: OutputFormat): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }
  return encode(data);
}

/** Default page size for a format when the agent omits `limit`. */
export function defaultLimit(format: OutputFormat): number {
  return format === 'toon' ? DEFAULT_LIMIT_TOON : DEFAULT_LIMIT_JSON;
}

/**
 * Resolve the page size for a paginated call.
 *
 * Uses the agent-provided `requested` value, or a format-dependent default,
 * then clamps to Slack's per-method maximum. There is intentionally no env knob
 * for limits — the agent controls paging per call.
 */
export function resolveLimit(
  requested: number | undefined,
  format: OutputFormat,
  slackMax: number,
): number {
  const value = requested ?? defaultLimit(format);
  return Math.max(1, Math.min(value, slackMax));
}

export * from '@/format/shape.ts';
