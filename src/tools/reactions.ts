import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';

const channel = z.string().describe('Channel ID.');
const timestamp = z.string().describe('Timestamp of the target message.');
const name = z.string().describe('Emoji shortcode without colons (e.g. "thumbsup").');

interface ReactionsGetResult {
  message?: { reactions?: { name?: string; count?: number; users?: string[] }[] };
}

export function registerReactionTools(server: McpServer, deps: ToolDeps): void {
  registerTool(server, deps, {
    name: 'slack_add_reaction',
    title: 'Add a reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: { channel, timestamp, name },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<{ ok?: boolean }>('bot-preferred', (c) =>
        c.reactions.add({ channel: args.channel, timestamp: args.timestamp, name: args.name }),
      );
      return { ok: res.ok ?? true };
    },
  });

  registerTool(server, deps, {
    name: 'slack_remove_reaction',
    title: 'Remove a reaction',
    description: 'Remove an emoji reaction from a message.',
    inputSchema: { channel, timestamp, name },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<{ ok?: boolean }>('bot-preferred', (c) =>
        c.reactions.remove({ channel: args.channel, timestamp: args.timestamp, name: args.name }),
      );
      return { ok: res.ok ?? true };
    },
  });

  registerTool(server, deps, {
    name: 'slack_get_reactions',
    title: 'Get reactions',
    description: 'Get all reactions on a message.',
    inputSchema: {
      channel,
      timestamp,
      full: z.boolean().optional().describe('Return the complete list of reaction users.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<ReactionsGetResult>('bot-preferred', (c) =>
        c.reactions.get({
          channel: args.channel,
          timestamp: args.timestamp,
          ...(args.full !== undefined ? { full: args.full } : {}),
        }),
      );
      const reactions = res.message?.reactions ?? [];
      return {
        reactions: reactions.map((r) => ({
          name: r.name,
          count: r.count,
          users: r.users?.join(' '),
        })),
      };
    },
  });
}
