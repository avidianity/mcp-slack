import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';

const channelId = z.string().describe('Channel ID that owns the bookmark.');

interface RawBookmark {
  id?: string;
  channel_id?: string;
  title?: string;
  link?: string;
  emoji?: string;
  type?: string;
}

interface BookmarkResult {
  bookmark?: RawBookmark;
}

interface BookmarksListResult {
  bookmarks?: RawBookmark[];
}

function shapeBookmark(bookmark: RawBookmark): Record<string, unknown> {
  return {
    id: bookmark.id,
    channel_id: bookmark.channel_id,
    title: bookmark.title,
    link: bookmark.link,
    emoji: bookmark.emoji,
    type: bookmark.type,
  };
}

export function registerBookmarkTools(server: McpServer, deps: ToolDeps): void {
  registerTool(server, deps, {
    name: 'add_bookmark',
    title: 'Add a bookmark',
    description: 'Add a bookmark to a channel.',
    inputSchema: {
      channel_id: channelId,
      title: z.string().describe('Bookmark title.'),
      type: z.literal('link').default('link').describe('Bookmark type (only "link" is supported).'),
      link: z.url().describe('URL the bookmark points to.'),
      emoji: z.string().optional().describe('Optional emoji shortcode for the bookmark.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<BookmarkResult>('bot-preferred', (c) =>
        c.bookmarks.add({
          channel_id: args.channel_id,
          title: args.title,
          type: args.type,
          link: args.link,
          ...(args.emoji !== undefined ? { emoji: args.emoji } : {}),
        }),
      );
      return res.bookmark !== undefined ? shapeBookmark(res.bookmark) : { ok: true };
    },
  });

  registerTool(server, deps, {
    name: 'remove_bookmark',
    title: 'Remove a bookmark',
    description: 'Remove a bookmark from a channel.',
    inputSchema: {
      channel_id: channelId,
      bookmark_id: z.string().describe('ID of the bookmark to remove.'),
    },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<{ ok?: boolean }>('bot-preferred', (c) =>
        c.bookmarks.remove({ channel_id: args.channel_id, bookmark_id: args.bookmark_id }),
      );
      return { ok: res.ok ?? true };
    },
  });

  registerTool(server, deps, {
    name: 'list_bookmarks',
    title: 'List bookmarks',
    description: 'List all bookmarks in a channel.',
    inputSchema: { channel_id: channelId },
    handler: async (args, ctx) => {
      const res = await ctx.slack.call<BookmarksListResult>('bot-preferred', (c) =>
        c.bookmarks.list({ channel_id: args.channel_id }),
      );
      return { bookmarks: (res.bookmarks ?? []).map(shapeBookmark) };
    },
  });
}
