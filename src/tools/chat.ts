import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, cursorOption, limitOption } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { resolveLimit, shapeMessage } from '@/format/index.ts';

const channel = z.string().describe('Channel ID (e.g. C0123456789) or name.');
const blocks = z
  .array(z.looseObject({ type: z.string() }))
  .optional()
  .describe(
    'Optional Slack Block Kit blocks: an array of block objects, each with a string `type` ' +
      '(e.g. "section", "divider", "actions"). Other fields are passed through to Slack, which ' +
      'validates them authoritatively.',
  );

const SCHEDULED_MAX = 100;

interface PostResult {
  ok?: boolean;
  channel?: string;
  ts?: string;
  message?: { text?: string };
}

interface PermalinkResult {
  permalink?: string;
  channel?: string;
}

interface ScheduledListResult {
  scheduled_messages?: {
    id?: string;
    channel_id?: string;
    post_at?: number;
    date_created?: number;
    text?: string;
  }[];
  response_metadata?: { next_cursor?: string };
}

export function registerChatTools(server: McpServer, deps: ToolDeps): void {
  registerTool(server, deps, {
    name: 'slack_post_message',
    title: 'Post a message',
    description: 'Post a new message to a Slack channel.',
    inputSchema: {
      channel,
      text: z.string().describe('Message text (supports mrkdwn).'),
      thread_ts: z.string().optional().describe('Reply in this thread if set.'),
      blocks,
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<PostResult>('bot-preferred', (c) =>
        c.chat.postMessage({
          channel: args.channel,
          text: args.text,
          ...(args.thread_ts !== undefined ? { thread_ts: args.thread_ts } : {}),
          ...(args.blocks !== undefined ? { blocks: args.blocks } : {}),
        }),
      );
      return { ok: res.ok ?? true, channel: res.channel, ts: res.ts };
    },
  });

  registerTool(server, deps, {
    name: 'slack_reply_to_thread',
    title: 'Reply to a thread',
    description: 'Reply to an existing thread in a channel.',
    inputSchema: {
      channel,
      thread_ts: z.string().describe('Timestamp of the parent message.'),
      text: z.string().describe('Reply text (supports mrkdwn).'),
      blocks,
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<PostResult>('bot-preferred', (c) =>
        c.chat.postMessage({
          channel: args.channel,
          thread_ts: args.thread_ts,
          text: args.text,
          ...(args.blocks !== undefined ? { blocks: args.blocks } : {}),
        }),
      );
      return { ok: res.ok ?? true, channel: res.channel, ts: res.ts };
    },
  });

  registerTool(server, deps, {
    name: 'slack_update_message',
    title: 'Update a message',
    description:
      'Edit an existing message. Uses the user token when available (to edit your own ' +
      'messages), falling back to the bot token for bot-authored messages.',
    inputSchema: {
      channel,
      ts: z.string().describe('Timestamp of the message to update.'),
      text: z.string().describe('New message text.'),
      blocks,
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<PostResult>('user-preferred', (c) =>
        c.chat.update({
          channel: args.channel,
          ts: args.ts,
          text: args.text,
          ...(args.blocks !== undefined ? { blocks: args.blocks } : {}),
        }),
      );
      return { ok: res.ok ?? true, channel: res.channel, ts: res.ts };
    },
  });

  registerTool(server, deps, {
    name: 'slack_delete_message',
    title: 'Delete a message',
    description:
      'Delete a message. Uses the user token when available (to delete your own messages), ' +
      'falling back to the bot token for bot-authored messages.',
    inputSchema: {
      channel,
      ts: z.string().describe('Timestamp of the message to delete.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<PostResult>('user-preferred', (c) =>
        c.chat.delete({ channel: args.channel, ts: args.ts }),
      );
      return { ok: res.ok ?? true, channel: res.channel, ts: res.ts };
    },
  });

  registerTool(server, deps, {
    name: 'slack_post_ephemeral',
    title: 'Post an ephemeral message',
    description: 'Post a message visible only to a single user in a channel.',
    inputSchema: {
      channel,
      user: z.string().describe('User ID who will see the message.'),
      text: z.string().describe('Message text.'),
      thread_ts: z.string().optional().describe('Reply in this thread if set.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<{ ok?: boolean; message_ts?: string }>(
        'bot-preferred',
        (c) =>
          c.chat.postEphemeral({
            channel: args.channel,
            user: args.user,
            text: args.text,
            ...(args.thread_ts !== undefined ? { thread_ts: args.thread_ts } : {}),
          }),
      );
      return { ok: res.ok ?? true, message_ts: res.message_ts };
    },
  });

  registerTool(server, deps, {
    name: 'slack_schedule_message',
    title: 'Schedule a message',
    description: 'Schedule a message to be sent to a channel at a future time.',
    inputSchema: {
      channel,
      text: z.string().describe('Message text.'),
      post_at: z.number().int().positive().describe('Unix timestamp (seconds) to send at.'),
      thread_ts: z.string().optional().describe('Reply in this thread if set.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<{ scheduled_message_id?: string; channel?: string }>(
        'bot-preferred',
        (c) =>
          c.chat.scheduleMessage({
            channel: args.channel,
            text: args.text,
            post_at: args.post_at,
            ...(args.thread_ts !== undefined ? { thread_ts: args.thread_ts } : {}),
          }),
      );
      return {
        ok: true,
        scheduled_message_id: res.scheduled_message_id,
        channel: res.channel,
      };
    },
  });

  registerTool(server, deps, {
    name: 'slack_list_scheduled_messages',
    title: 'List scheduled messages',
    description: 'List messages scheduled for future delivery.',
    inputSchema: {
      channel: channel.optional(),
      limit: limitOption,
      cursor: cursorOption,
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<ScheduledListResult>('bot-preferred', (c) =>
        c.chat.scheduledMessages.list({
          ...(args.channel !== undefined ? { channel: args.channel } : {}),
          limit: resolveLimit(args.limit, ctx.format, SCHEDULED_MAX),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        }),
      );
      // Honor the channel allowlist even when no channel is targeted.
      const allow = ctx.slack.channelIds;
      let scheduled = res.scheduled_messages ?? [];
      if (allow.length > 0) {
        const allowSet = new Set(allow);
        scheduled = scheduled.filter(
          (m) => m.channel_id !== undefined && allowSet.has(m.channel_id),
        );
      }
      return {
        scheduled_messages: scheduled,
        nextCursor: res.response_metadata?.next_cursor,
      };
    },
  });

  registerTool(server, deps, {
    name: 'slack_delete_scheduled_message',
    title: 'Delete a scheduled message',
    description: 'Cancel a previously scheduled message.',
    inputSchema: {
      channel,
      scheduled_message_id: z.string().describe('ID from slack_schedule_message.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<{ ok?: boolean }>('bot-preferred', (c) =>
        c.chat.deleteScheduledMessage({
          channel: args.channel,
          scheduled_message_id: args.scheduled_message_id,
        }),
      );
      return { ok: res.ok ?? true };
    },
  });

  registerTool(server, deps, {
    name: 'slack_get_permalink',
    title: 'Get message permalink',
    description: 'Get a permalink URL for a specific message.',
    inputSchema: {
      channel,
      message_ts: z.string().describe('Timestamp of the message.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<PermalinkResult>('bot-preferred', (c) =>
        c.chat.getPermalink({ channel: args.channel, message_ts: args.message_ts }),
      );
      return { permalink: res.permalink, channel: res.channel };
    },
  });
}

/** Exported for tests that exercise message shaping. */
export { shapeMessage };
