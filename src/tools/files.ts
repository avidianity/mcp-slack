import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FilesUploadV2Arguments } from '@slack/web-api';
import { registerTool } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { shapeFile } from '@/format/index.ts';

interface UploadResult {
  files?: Record<string, unknown>[];
  file?: Record<string, unknown>;
}

export function registerFileTools(server: McpServer, deps: ToolDeps): void {
  registerTool(server, deps, {
    name: 'upload_file',
    title: 'Upload a file',
    description:
      'Upload a file to Slack via the modern upload flow (filesUploadV2). Provide inline ' +
      '`content` or a local `file_path`.',
    inputSchema: {
      filename: z.string().describe('File name including extension.'),
      content: z
        .string()
        .optional()
        .describe('Inline file content (mutually exclusive with file_path).'),
      file_path: z.string().optional().describe('Local path to a file to upload.'),
      channel_id: z.string().optional().describe('Channel to share the file into.'),
      title: z.string().optional().describe('Title shown in Slack.'),
      initial_comment: z.string().optional().describe('Message posted alongside the file.'),
      thread_ts: z.string().optional().describe('Share into this thread.'),
    },
    handler: async (args, ctx) => {
      if (args.content === undefined && args.file_path === undefined) {
        throw new Error('Provide either `content` or `file_path`.');
      }
      if (args.content !== undefined && args.file_path !== undefined) {
        throw new Error('Provide only one of `content` or `file_path`, not both.');
      }
      const uploadArgs = {
        filename: args.filename,
        ...(args.content !== undefined ? { content: args.content } : {}),
        ...(args.file_path !== undefined ? { file: args.file_path } : {}),
        ...(args.channel_id !== undefined ? { channel_id: args.channel_id } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.initial_comment !== undefined ? { initial_comment: args.initial_comment } : {}),
        ...(args.thread_ts !== undefined ? { thread_ts: args.thread_ts } : {}),
      } as FilesUploadV2Arguments;
      const res = await ctx.slack.call<UploadResult>('bot-preferred', (c) =>
        c.filesUploadV2(uploadArgs),
      );
      const files = res.files ?? (res.file !== undefined ? [res.file] : []);
      return { ok: true, files: files.map(shapeFile) };
    },
  });
}
