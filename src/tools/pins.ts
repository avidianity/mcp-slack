import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { shapeMessage } from '@/format/index.ts';

const channel = z.string().describe('Channel ID.');
const timestamp = z.string().describe('Timestamp of the target message.');

interface PinsListResult {
  items?: {
    type?: string;
    message?: Record<string, unknown>;
    created?: number;
    created_by?: string;
  }[];
}

export function registerPinTools(server: McpServer, deps: ToolDeps): void {
  registerTool(server, deps, {
    name: 'add_pin',
    title: 'Pin a message',
    description: 'Pin a message to a channel.',
    inputSchema: { channel, timestamp },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<{ ok?: boolean }>('bot-preferred', (c) =>
        c.pins.add({ channel: args.channel, timestamp: args.timestamp }),
      );
      return { ok: res.ok ?? true };
    },
  });

  registerTool(server, deps, {
    name: 'remove_pin',
    title: 'Unpin a message',
    description: 'Remove a pinned message from a channel.',
    inputSchema: { channel, timestamp },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<{ ok?: boolean }>('bot-preferred', (c) =>
        c.pins.remove({ channel: args.channel, timestamp: args.timestamp }),
      );
      return { ok: res.ok ?? true };
    },
  });

  registerTool(server, deps, {
    name: 'list_pins',
    title: 'List pinned items',
    description: 'List all pinned items in a channel.',
    inputSchema: { channel },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<PinsListResult>('bot-preferred', (c) =>
        c.pins.list({ channel: args.channel }),
      );
      return {
        pins: (res.items ?? []).map((item) => ({
          type: item.type,
          created: item.created,
          created_by: item.created_by,
          message: item.message !== undefined ? shapeMessage(item.message) : undefined,
        })),
      };
    },
  });
}
