import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, cursorOption, limitOption } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { resolveLimit, shapeUser } from '@/format/index.ts';
import { collectPages } from '@/tools/paginate.ts';
import { fuzzyRank } from '@/tools/fuzzy.ts';

const USERS_MAX = 1000;
const SEARCH_RESULT_MAX = 100;

interface UsersListResult {
  members?: Record<string, unknown>[];
  response_metadata?: { next_cursor?: string };
}

interface UserInfoResult {
  user?: Record<string, unknown>;
}

export function registerUserTools(server: McpServer, deps: ToolDeps): void {
  registerTool(server, deps, {
    name: 'slack_get_users',
    title: 'List users',
    description:
      'List workspace users with basic profile information. Deactivated (deleted) users are ' +
      'excluded unless `include_deleted` is set.',
    inputSchema: {
      include_deleted: z
        .boolean()
        .optional()
        .describe('Include deactivated users. Defaults to false.'),
      limit: limitOption,
      cursor: cursorOption,
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<UsersListResult>('bot-preferred', (c) =>
        c.users.list({
          limit: resolveLimit(args.limit, ctx.format, USERS_MAX),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(ctx.slack.teamId !== undefined ? { team_id: ctx.slack.teamId } : {}),
        }),
      );
      let users = (res.members ?? []).map(shapeUser);
      if (!(args.include_deleted ?? false)) {
        users = users.filter((u) => u.deleted !== true);
      }
      return {
        users,
        nextCursor: res.response_metadata?.next_cursor,
      };
    },
  });

  registerTool(server, deps, {
    name: 'slack_search_users',
    title: 'Search users',
    description:
      'Find users by fuzzy-matching a query against username, real name, display name, and ' +
      'email. The server paginates users.list internally, so a single call replaces walking ' +
      'every page of slack_get_users. Results are ranked best-match first; `truncated` is true ' +
      'if the scan cap was hit before the directory was exhausted.',
    inputSchema: {
      query: z
        .string()
        .min(2)
        .describe(
          'Text to fuzzy-match against username, real name, display name, and email (min 2 chars).',
        ),
      include_deleted: z
        .boolean()
        .optional()
        .describe('Include deactivated users. Defaults to false.'),
      limit: limitOption,
    },
    handler: async (args, ctx) => {
      const collected = await collectPages<Record<string, unknown>>(async (cursor) => {
        const res = await ctx.slack.call<UsersListResult>('bot-preferred', (c) =>
          c.users.list({
            limit: USERS_MAX,
            ...(cursor !== undefined ? { cursor } : {}),
            ...(ctx.slack.teamId !== undefined ? { team_id: ctx.slack.teamId } : {}),
          }),
        );
        return { items: res.members ?? [], nextCursor: res.response_metadata?.next_cursor };
      });

      let shaped = collected.items.map(shapeUser);
      if (!(args.include_deleted ?? false)) {
        shaped = shaped.filter((u) => u.deleted !== true);
      }
      const ranked = fuzzyRank(args.query, shaped, [
        { name: 'name', weight: 2 },
        { name: 'real_name', weight: 2 },
        { name: 'display_name', weight: 1 },
        { name: 'email', weight: 1 },
      ]);
      const limit = resolveLimit(args.limit, ctx.format, SEARCH_RESULT_MAX);
      return {
        users: ranked.slice(0, limit),
        truncated: collected.truncated,
        scanned: shaped.length,
      };
    },
  });

  registerTool(server, deps, {
    name: 'slack_get_user_profile',
    title: 'Get user profile',
    description: 'Get detailed profile information for a single user.',
    inputSchema: {
      user: z.string().describe('User ID (e.g. U0123456789).'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<UserInfoResult>('bot-preferred', (c) =>
        c.users.info({ user: args.user }),
      );
      return res.user !== undefined ? shapeUser(res.user) : { id: args.user };
    },
  });
}
