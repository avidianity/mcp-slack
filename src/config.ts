import { z } from 'zod';

/** Supported output encodings for tool results. */
export const OUTPUT_FORMATS = ['toon', 'json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Treat empty / whitespace-only env values as unset. Process environments
 * routinely surface unset variables as `""` (empty `.env` placeholders, blank
 * shell exports, container passthrough), which should not be a hard error for
 * optional fields nor override a default.
 */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalToken = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalList = z.preprocess(emptyToUndefined, z.string().trim().optional());

const rawEnvSchema = z.object({
  SLACK_BOT_TOKEN: optionalToken,
  SLACK_USER_TOKEN: optionalToken,
  SLACK_TEAM_ID: optionalToken,
  SLACK_CHANNEL_IDS: optionalList,
  AUTH_TOKEN: optionalToken,
  SLACK_MCP_DEFAULT_FORMAT: z.preprocess(emptyToUndefined, z.enum(OUTPUT_FORMATS).default('toon')),
  SLACK_MCP_ALLOWED_HOSTS: optionalList,
  SLACK_MCP_ALLOWED_ORIGINS: optionalList,
});

/** Fully validated, readonly runtime configuration. */
export interface Config {
  readonly botToken: string | undefined;
  readonly userToken: string | undefined;
  readonly teamId: string | undefined;
  readonly channelIds: readonly string[];
  readonly authToken: string | undefined;
  readonly defaultFormat: OutputFormat;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly hasBotToken: boolean;
  readonly hasUserToken: boolean;
}

function parseList(value: string | undefined): readonly string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Load and validate configuration from environment variables.
 *
 * Throws a formatted error (aggregating all issues) when the environment is
 * invalid, so startup fails loudly and early.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = rawEnvSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const data = parsed.data;

  if (data.SLACK_BOT_TOKEN === undefined && data.SLACK_USER_TOKEN === undefined) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - At least one of SLACK_BOT_TOKEN or SLACK_USER_TOKEN must be set.',
    );
  }

  return Object.freeze({
    botToken: data.SLACK_BOT_TOKEN,
    userToken: data.SLACK_USER_TOKEN,
    teamId: data.SLACK_TEAM_ID,
    channelIds: parseList(data.SLACK_CHANNEL_IDS),
    authToken: data.AUTH_TOKEN,
    defaultFormat: data.SLACK_MCP_DEFAULT_FORMAT,
    allowedHosts: parseList(data.SLACK_MCP_ALLOWED_HOSTS),
    allowedOrigins: parseList(data.SLACK_MCP_ALLOWED_ORIGINS),
    hasBotToken: data.SLACK_BOT_TOKEN !== undefined,
    hasUserToken: data.SLACK_USER_TOKEN !== undefined,
  });
}
