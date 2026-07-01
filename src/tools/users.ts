import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, cursorOption, limitOption } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { resolveLimit, shapeUser } from '@/format/index.ts';

const USERS_MAX = 1000;

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
    description: 'List workspace users with basic profile information.',
    inputSchema: {
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
      return {
        users: (res.members ?? []).map(shapeUser),
        nextCursor: res.response_metadata?.next_cursor,
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
