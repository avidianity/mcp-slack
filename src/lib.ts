/**
 * Programmatic entry point (`import { createServer } from '@avidian/mcp-slack'`).
 *
 * Unlike `index.ts` (the CLI, which parses argv and starts a transport on
 * import), this module is side-effect free: it only re-exports the pieces
 * needed to embed the server — build a `Config`, construct the `McpServer`,
 * and serve it over stdio or Streamable HTTP.
 */

export { loadConfig, OUTPUT_FORMATS } from '@/config.ts';
export type { Config, OutputFormat } from '@/config.ts';

export { SlackClient, SlackApiError, SlackAuthError } from '@/slack/client.ts';
export type { TokenPolicy } from '@/slack/client.ts';

export { createServer } from '@/server.ts';

export { startStdio } from '@/transports/stdio.ts';
export { startHttp } from '@/transports/http.ts';
export type { HttpOptions } from '@/transports/http.ts';
