import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, cursorOption, limitOption } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { resolveLimit, shapeChannel, shapeMessage } from '@/format/index.ts';

const channel = z.string().describe('Channel ID (e.g. C0123456789).');

const LIST_MAX = 1000;
const HISTORY_MAX = 1000;
const MEMBERS_MAX = 1000;

const CHANNEL_TYPES = ['public_channel', 'private_channel', 'mpim', 'im'] as const;

type RawChannelShape = Record<string, unknown>;

interface ListResult {
  channels?: RawChannelShape[];
  response_metadata?: { next_cursor?: string };
}

interface HistoryResult {
  messages?: RawChannelShape[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface InfoResult {
  channel?: RawChannelShape;
}

interface MembersResult {
  members?: string[];
  response_metadata?: { next_cursor?: string };
}

export function registerConversationTools(server: McpServer, deps: ToolDeps): void {
  registerTool(server, deps, {
    name: 'slack_list_channels',
    title: 'List channels',
    description: 'List channels in the workspace.',
    inputSchema: {
      types: z
        .array(z.enum(CHANNEL_TYPES))
        .optional()
        .describe('Channel types to include. Defaults to public channels.'),
      exclude_archived: z.boolean().optional().describe('Exclude archived channels.'),
      limit: limitOption,
      cursor: cursorOption,
    },
    handler: async (args, ctx) => {
      // When an allowlist is configured, resolve each allowed channel directly
      // via conversations.info. This is deterministic and complete, avoiding the
      // "short/empty page" problem of filtering a single paginated list page.
      const allow = ctx.slack.channelIds;
      if (allow.length > 0) {
        // Resolve each allowlisted id independently; a channel the token cannot
        // see (channel_not_found / not_in_channel) is dropped rather than
        // failing the whole call.
        const infos = await Promise.allSettled(
          allow.map((id) =>
            ctx.slack.call<InfoResult>('bot-preferred', (c) =>
              c.conversations.info({ channel: id }),
            ),
          ),
        );
        return {
          channels: infos
            .filter((r): r is PromiseFulfilledResult<InfoResult> => r.status === 'fulfilled')
            .map((r) => r.value.channel)
            .filter((ch): ch is RawChannelShape => ch !== undefined)
            .map(shapeChannel),
          nextCursor: undefined,
        };
      }

      const res = await ctx.slack.call<ListResult>('bot-preferred', (c) =>
        c.conversations.list({
          types: (args.types ?? ['public_channel']).join(','),
          exclude_archived: args.exclude_archived ?? true,
          limit: resolveLimit(args.limit, ctx.format, LIST_MAX),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(ctx.slack.teamId !== undefined ? { team_id: ctx.slack.teamId } : {}),
        }),
      );
      return {
        channels: (res.channels ?? []).map(shapeChannel),
        nextCursor: res.response_metadata?.next_cursor,
      };
    },
  });

  registerTool(server, deps, {
    name: 'slack_get_channel_history',
    title: 'Get channel history',
    description: 'Retrieve recent messages from a channel.',
    inputSchema: {
      channel,
      limit: limitOption,
      cursor: cursorOption,
      oldest: z.string().optional().describe('Only messages after this timestamp.'),
      latest: z.string().optional().describe('Only messages before this timestamp.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<HistoryResult>('bot-preferred', (c) =>
        c.conversations.history({
          channel: args.channel,
          limit: resolveLimit(args.limit, ctx.format, HISTORY_MAX),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(args.oldest !== undefined ? { oldest: args.oldest } : {}),
          ...(args.latest !== undefined ? { latest: args.latest } : {}),
        }),
      );
      return {
        messages: (res.messages ?? []).map(shapeMessage),
        has_more: res.has_more ?? false,
        nextCursor: res.response_metadata?.next_cursor,
      };
    },
  });

  registerTool(server, deps, {
    name: 'slack_get_thread_replies',
    title: 'Get thread replies',
    description: 'Fetch all replies in a message thread.',
    inputSchema: {
      channel,
      ts: z.string().describe('Timestamp of the parent message.'),
      limit: limitOption,
      cursor: cursorOption,
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<HistoryResult>('bot-preferred', (c) =>
        c.conversations.replies({
          channel: args.channel,
          ts: args.ts,
          limit: resolveLimit(args.limit, ctx.format, HISTORY_MAX),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        }),
      );
      return {
        messages: (res.messages ?? []).map(shapeMessage),
        has_more: res.has_more ?? false,
        nextCursor: res.response_metadata?.next_cursor,
      };
    },
  });

  registerTool(server, deps, {
    name: 'slack_get_channel_info',
    title: 'Get channel info',
    description: 'Get metadata about a single channel.',
    inputSchema: { channel },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<InfoResult>('bot-preferred', (c) =>
        c.conversations.info({ channel: args.channel }),
      );
      return res.channel !== undefined ? shapeChannel(res.channel) : { id: args.channel };
    },
  });

  registerTool(server, deps, {
    name: 'slack_get_channel_members',
    title: 'Get channel members',
    description: 'List the user IDs that are members of a channel.',
    inputSchema: {
      channel,
      limit: limitOption,
      cursor: cursorOption,
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<MembersResult>('bot-preferred', (c) =>
        c.conversations.members({
          channel: args.channel,
          limit: resolveLimit(args.limit, ctx.format, MEMBERS_MAX),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        }),
      );
      return {
        members: res.members ?? [],
        nextCursor: res.response_metadata?.next_cursor,
      };
    },
  });

  registerTool(server, deps, {
    name: 'slack_join_channel',
    title: 'Join a channel',
    description: 'Join a public channel (as the token identity).',
    inputSchema: { channel },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<InfoResult>('bot-preferred', (c) =>
        c.conversations.join({ channel: args.channel }),
      );
      return {
        ok: true,
        channel: res.channel !== undefined ? shapeChannel(res.channel) : undefined,
      };
    },
  });

  registerTool(server, deps, {
    name: 'slack_mark_read',
    title: 'Mark channel read',
    description: 'Move the read cursor in a channel to a message timestamp.',
    inputSchema: {
      channel,
      ts: z.string().describe('Timestamp to mark as most recently read.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<{ ok?: boolean }>('bot-preferred', (c) =>
        c.conversations.mark({ channel: args.channel, ts: args.ts }),
      );
      return { ok: res.ok ?? true };
    },
  });
}
