import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, limitOption } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { resolveLimit } from '@/format/index.ts';

const SEARCH_MAX = 100;

const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;
const USER_ID = /^[UW][A-Z0-9]{6,}$/;

/**
 * Fold optional `channel` / `user` scoping into a Slack search query as `in:` /
 * `from:` operators, so callers need not know the operator syntax. IDs are
 * encoded as `<#C…>` / `<@U…>` mentions (the form Slack search resolves
 * reliably); anything else is treated as a name/handle.
 */
/**
 * A `channel` / `user` scoping value. Slack's `in:` / `from:` operators take a
 * single token with no quoting for spaces (confirmed against the search.messages
 * docs), so a multi-word display name cannot be expressed. Reject internal
 * whitespace and steer the caller to an ID or single-word handle.
 */
const scopeToken = (field: string) =>
  z
    .string()
    .refine(
      (v) => !/\s/.test(v.trim()),
      `${field} cannot contain spaces: Slack search operators take no quoted or multi-word ` +
        `values. Pass an ID (e.g. U0123456789 / C0123456789) or a single-word handle, or ` +
        `resolve the name first with search_users / search_channels.`,
    );

function buildQuery(query: string, channel: string | undefined, user: string | undefined): string {
  const parts = [query.trim()];
  if (channel !== undefined && channel.trim() !== '') {
    const c = channel.trim();
    parts.push(`in:${CHANNEL_ID.test(c) ? `<#${c}>` : `#${c.replace(/^#/, '')}`}`);
  }
  if (user !== undefined && user.trim() !== '') {
    const u = user.trim();
    parts.push(`from:${USER_ID.test(u) ? `<@${u}>` : `@${u.replace(/^@/, '')}`}`);
  }
  return parts.join(' ').trim();
}

interface SearchResult {
  messages?: {
    total?: number;
    pagination?: { page?: number; page_count?: number; total_count?: number };
    matches?: {
      ts?: string;
      user?: string;
      username?: string;
      text?: string;
      permalink?: string;
      channel?: { id?: string; name?: string };
    }[];
  };
}

export function registerSearchTools(server: McpServer, deps: ToolDeps): void {
  registerTool(server, deps, {
    name: 'search_messages',
    title: 'Search messages',
    description:
      'Search messages across the workspace. Requires a user token (SLACK_USER_TOKEN); ' +
      'bots cannot call search.',
    inputSchema: {
      query: z
        .string()
        .describe('Search query (supports Slack operators such as from:, in:, before:, after:).'),
      channel: scopeToken('channel')
        .optional()
        .describe('Restrict to this channel (ID or single-word name); added as an `in:` operator.'),
      user: scopeToken('user')
        .optional()
        .describe(
          'Restrict to messages from this user (ID or single-word handle); added as a `from:` operator.',
        ),
      sort: z.enum(['score', 'timestamp']).optional().describe('Sort by relevance or time.'),
      sort_dir: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
      limit: limitOption,
      page: z.number().int().positive().optional().describe('1-based result page.'),
    },
    handler: async (args, ctx) => {
      const query = buildQuery(args.query, args.channel, args.user);
      const res = await ctx.slack.call<SearchResult>('user-required', (c) =>
        c.search.messages({
          query,
          count: resolveLimit(args.limit, ctx.format, SEARCH_MAX),
          ...(args.sort !== undefined ? { sort: args.sort } : {}),
          ...(args.sort_dir !== undefined ? { sort_dir: args.sort_dir } : {}),
          ...(args.page !== undefined ? { page: args.page } : {}),
        }),
      );
      // Search is workspace-wide, so honor the channel allowlist as a boundary
      // by dropping matches from channels outside it.
      const allow = ctx.slack.channelIds;
      let matches = res.messages?.matches ?? [];
      if (allow.length > 0) {
        const allowSet = new Set(allow);
        matches = matches.filter((m) => m.channel?.id !== undefined && allowSet.has(m.channel.id));
      }
      return {
        total: res.messages?.total,
        page: res.messages?.pagination?.page,
        page_count: res.messages?.pagination?.page_count,
        matches: matches.map((m) => ({
          ts: m.ts,
          user: m.user ?? m.username,
          channel_id: m.channel?.id,
          channel_name: m.channel?.name,
          text: m.text,
          permalink: m.permalink,
        })),
      };
    },
  });
}
