import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OUTPUT_FORMATS } from '@/config.ts';
import type { Config, OutputFormat } from '@/config.ts';
import { SlackApiError, SlackAuthError } from '@/slack/client.ts';
import type { SlackClient } from '@/slack/client.ts';
import { formatResponse, resolveFormat } from '@/format/index.ts';

/** Shared, reusable input options. */
export const formatOption = z
  .enum(OUTPUT_FORMATS)
  .optional()
  .describe('Output format: "toon" (default, token-efficient) or "json".');

export const limitOption = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Maximum items to return. Agent-controlled; clamped to the Slack API maximum.');

export const cursorOption = z
  .string()
  .optional()
  .describe('Pagination cursor returned as `nextCursor` by a previous call.');

/** Dependencies shared by every tool. */
export interface ToolDeps {
  readonly slack: SlackClient;
  readonly config: Config;
}

/** Per-invocation context handed to a tool handler. */
export interface ToolContext {
  readonly slack: SlackClient;
  readonly config: Config;
  readonly format: OutputFormat;
}

type InferShape<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

interface ToolDefinition<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Shape;
  readonly handler: (args: InferShape<Shape>, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Sentinel wrapper letting a handler emit raw MCP content (e.g. an `image`
 * block) instead of a value that gets encoded to TOON/JSON text. Handlers that
 * return a plain object take the normal formatting path; those that need to
 * return bytes the model can view wrap their content with `rawToolResult`.
 */
const RAW_RESULT = Symbol('mcpRawToolResult');

export interface RawToolResult {
  readonly [RAW_RESULT]: true;
  readonly content: CallToolResult['content'];
}

export function rawToolResult(content: CallToolResult['content']): RawToolResult {
  return { [RAW_RESULT]: true, content };
}

function isRawToolResult(value: unknown): value is RawToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[RAW_RESULT] === true
  );
}

/** Convert any thrown value into a clean, agent-readable message. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof SlackAuthError || error instanceof SlackApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Register a tool on the server. Automatically:
 * - adds the shared `format` option to the input schema,
 * - resolves the effective format,
 * - runs the handler, encodes its result, and wraps it as tool content,
 * - normalizes errors into `isError` results.
 */
/**
 * Minimal structural view of `McpServer.registerTool` used to sidestep the
 * SDK's heavy generic inference when wrapping it generically. Correctness is
 * enforced by this module, not the SDK's inferred callback type.
 */
type ToolRegistrar = (
  name: string,
  config: { description: string; inputSchema: z.ZodRawShape; title?: string },
  cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
) => unknown;

export function registerTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  deps: ToolDeps,
  def: ToolDefinition<Shape>,
): void {
  const inputSchema: z.ZodRawShape = { ...def.inputSchema, format: formatOption };
  const register = server.registerTool.bind(server) as unknown as ToolRegistrar;

  register(
    def.name,
    {
      description: def.description,
      inputSchema,
      ...(def.title !== undefined ? { title: def.title } : {}),
    },
    async (args): Promise<CallToolResult> => {
      const format = resolveFormat(
        args['format'] as OutputFormat | undefined,
        deps.config.defaultFormat,
      );
      const ctx: ToolContext = { slack: deps.slack, config: deps.config, format };
      try {
        // Enforce the channel allowlist as a real boundary for every
        // channel-scoped tool. All such tools name the argument `channel` or
        // `channel_id`, so a single check here covers them (and future ones).
        const channelArg = args['channel'] ?? args['channel_id'];
        if (typeof channelArg === 'string') {
          deps.slack.assertChannelAllowed(channelArg);
        }
        const data = await def.handler(args as InferShape<Shape>, ctx);
        if (isRawToolResult(data)) {
          return { content: data.content };
        }
        return { content: [{ type: 'text', text: formatResponse(data, format) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: toErrorMessage(error) }] };
      }
    },
  );
}
