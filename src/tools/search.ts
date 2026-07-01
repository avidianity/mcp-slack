import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, limitOption } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { resolveLimit } from '@/format/index.ts';

const SEARCH_MAX = 100;

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
    name: 'slack_search_messages',
    title: 'Search messages',
    description:
      'Search messages across the workspace. Requires a user token (SLACK_USER_TOKEN); ' +
      'bots cannot call search.',
    inputSchema: {
      query: z.string().describe('Search query (supports Slack search operators).'),
      sort: z.enum(['score', 'timestamp']).optional().describe('Sort by relevance or time.'),
      sort_dir: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
      limit: limitOption,
      page: z.number().int().positive().optional().describe('1-based result page.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<SearchResult>('user-required', (c) =>
        c.search.messages({
          query: args.query,
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
