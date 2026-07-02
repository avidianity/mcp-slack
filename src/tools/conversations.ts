import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, cursorOption, limitOption } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { resolveLimit, shapeChannel, shapeMessage } from '@/format/index.ts';
import { collectPages, DEFAULT_MAX_PAGES } from '@/tools/paginate.ts';
import { fuzzyRank } from '@/tools/fuzzy.ts';
import type { ShapedChannel, ShapedMessage } from '@/format/index.ts';

const channel = z.string().describe('Channel ID (e.g. C0123456789).');

const LIST_MAX = 1000;
const HISTORY_MAX = 1000;
const MEMBERS_MAX = 1000;
const SEARCH_RESULT_MAX = 100;

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

/**
 * Keep a channel unless the token identity is explicitly not a member. IMs and
 * MPIMs carry no `is_member` flag (you are inherently a participant), so an
 * undefined value counts as a member.
 */
function isMember(channel: ShapedChannel): boolean {
  return channel.is_member !== false;
}

export function registerConversationTools(server: McpServer, deps: ToolDeps): void {
  registerTool(server, deps, {
    name: 'slack_list_channels',
    title: 'List channels',
    description:
      'List channels in the workspace. By default only channels the token identity has joined ' +
      'are returned; set `include_non_member` to also include channels it has not joined.',
    inputSchema: {
      types: z
        .array(z.enum(CHANNEL_TYPES))
        .optional()
        .describe('Channel types to include. Defaults to public channels.'),
      exclude_archived: z.boolean().optional().describe('Exclude archived channels.'),
      include_non_member: z
        .boolean()
        .optional()
        .describe('Include channels the token identity has not joined. Defaults to false.'),
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
      let channels = (res.channels ?? []).map(shapeChannel);
      if (!(args.include_non_member ?? false)) {
        channels = channels.filter(isMember);
      }
      return {
        channels,
        nextCursor: res.response_metadata?.next_cursor,
      };
    },
  });

  registerTool(server, deps, {
    name: 'slack_search_channels',
    title: 'Search channels',
    description:
      'Find channels by fuzzy-matching a query against channel name, topic, and purpose. ' +
      'The server paginates and filters internally, so a single call replaces walking every ' +
      'page of slack_list_channels. Respects the SLACK_CHANNEL_IDS allowlist. Results are ' +
      'ranked best-match first; `truncated` is true if the scan cap was hit before the ' +
      'workspace was exhausted.',
    inputSchema: {
      query: z
        .string()
        .min(2)
        .describe('Text to fuzzy-match against channel name, topic, and purpose (min 2 chars).'),
      types: z
        .array(z.enum(CHANNEL_TYPES))
        .optional()
        .describe('Channel types to include. Defaults to public channels.'),
      exclude_archived: z.boolean().optional().describe('Exclude archived channels.'),
      include_non_member: z
        .boolean()
        .optional()
        .describe('Include channels the token identity has not joined. Defaults to false.'),
      limit: limitOption,
    },
    handler: async (args, ctx) => {
      const allow = ctx.slack.channelIds;
      let candidates: RawChannelShape[];
      let truncated = false;

      if (allow.length > 0) {
        // Allowlist configured: search only within it. Resolve each id directly
        // (deterministic, and a channel the token cannot see is dropped).
        const infos = await Promise.allSettled(
          allow.map((id) =>
            ctx.slack.call<InfoResult>('bot-preferred', (c) =>
              c.conversations.info({ channel: id }),
            ),
          ),
        );
        candidates = infos
          .filter((r): r is PromiseFulfilledResult<InfoResult> => r.status === 'fulfilled')
          .map((r) => r.value.channel)
          .filter((ch): ch is RawChannelShape => ch !== undefined);
      } else {
        const types = (args.types ?? ['public_channel']).join(',');
        const excludeArchived = args.exclude_archived ?? true;
        const collected = await collectPages<RawChannelShape>(async (cursor) => {
          const res = await ctx.slack.call<ListResult>('bot-preferred', (c) =>
            c.conversations.list({
              types,
              exclude_archived: excludeArchived,
              limit: LIST_MAX,
              ...(cursor !== undefined ? { cursor } : {}),
              ...(ctx.slack.teamId !== undefined ? { team_id: ctx.slack.teamId } : {}),
            }),
          );
          return { items: res.channels ?? [], nextCursor: res.response_metadata?.next_cursor };
        });
        candidates = collected.items;
        truncated = collected.truncated;
      }

      let shaped = candidates.map(shapeChannel);
      // On the workspace-wide path, drop channels the token is not a member of
      // unless asked. The allowlist path is left as-is: it is already an explicit,
      // curated set the operator chose.
      if (allow.length === 0 && !(args.include_non_member ?? false)) {
        shaped = shaped.filter(isMember);
      }
      const ranked = fuzzyRank(args.query, shaped, [
        { name: 'name', weight: 3 },
        { name: 'topic', weight: 1 },
        { name: 'purpose', weight: 1 },
      ]);
      const limit = resolveLimit(args.limit, ctx.format, SEARCH_RESULT_MAX);
      return { channels: ranked.slice(0, limit), truncated, scanned: shaped.length };
    },
  });

  registerTool(server, deps, {
    name: 'slack_get_channel_history',
    title: 'Get channel history',
    description:
      'Retrieve recent messages from a channel. Set `user` to return only messages from a ' +
      'single sender: the server pages through history internally until it has gathered at ' +
      'least `limit` of them (a full final page may return a few more) or the scan cap is hit, ' +
      'so you avoid fetching a page and filtering it yourself. `nextCursor` resumes the scan ' +
      'from the next page without dropping or repeating messages.',
    inputSchema: {
      channel,
      user: z
        .string()
        .optional()
        .describe('Only return messages from this user ID (e.g. U0123456789).'),
      limit: limitOption,
      cursor: cursorOption,
      oldest: z.string().optional().describe('Only messages after this timestamp.'),
      latest: z.string().optional().describe('Only messages before this timestamp.'),
    },
    handler: async (args, ctx) => {
      const limit = resolveLimit(args.limit, ctx.format, HISTORY_MAX);

      const fetchPage = (cursor: string | undefined, pageSize: number) =>
        ctx.slack.call<HistoryResult>('bot-preferred', (c) =>
          c.conversations.history({
            channel: args.channel,
            limit: pageSize,
            ...(cursor !== undefined ? { cursor } : {}),
            ...(args.oldest !== undefined ? { oldest: args.oldest } : {}),
            ...(args.latest !== undefined ? { latest: args.latest } : {}),
          }),
        );

      // No user filter: single page sized to `limit`, agent-controlled (the
      // `nextCursor`/`has_more` it returns reflect that page size — unchanged).
      if (args.user === undefined) {
        const res = await fetchPage(args.cursor, limit);
        return {
          messages: (res.messages ?? []).map(shapeMessage),
          has_more: res.has_more ?? false,
          nextCursor: res.response_metadata?.next_cursor,
        };
      }

      // User filter: page internally, keeping only this sender's messages, until
      // we have `limit` of them, the channel is exhausted, or the scan cap hits.
      const target = args.user;
      const matches: ShapedMessage[] = [];
      let cursor = args.cursor;
      let nextCursor: string | undefined;
      let truncated = false;
      for (let page = 0; page < DEFAULT_MAX_PAGES; page++) {
        const res = await fetchPage(cursor, HISTORY_MAX);
        for (const message of (res.messages ?? []).map(shapeMessage)) {
          if (message.user === target) {
            matches.push(message);
          }
        }
        const raw = res.response_metadata?.next_cursor;
        nextCursor = raw !== undefined && raw !== '' ? raw : undefined;
        if (matches.length >= limit || nextCursor === undefined) {
          break;
        }
        if (page === DEFAULT_MAX_PAGES - 1) {
          truncated = true;
        }
        cursor = nextCursor;
      }
      // Return every match from the pages we scanned (not sliced to `limit`):
      // `nextCursor` is a page boundary, so slicing here would strand the
      // same-page overflow — resuming from it would skip those messages.
      return {
        messages: matches,
        // A cursor remains when we stopped early (limit reached) or hit the cap.
        has_more: nextCursor !== undefined,
        nextCursor,
        truncated,
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
