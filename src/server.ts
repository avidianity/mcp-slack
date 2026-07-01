import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '@/config.ts';
import { SlackClient } from '@/slack/client.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { registerChatTools } from '@/tools/chat.ts';
import { registerConversationTools } from '@/tools/conversations.ts';
import { registerReactionTools } from '@/tools/reactions.ts';
import { registerPinTools } from '@/tools/pins.ts';
import { registerBookmarkTools } from '@/tools/bookmarks.ts';
import { registerUserTools } from '@/tools/users.ts';
import { registerSearchTools } from '@/tools/search.ts';
import { registerFileTools } from '@/tools/files.ts';
import packageJson from '../package.json' with { type: 'json' };

const SERVER_NAME: string = packageJson.name;
const SERVER_VERSION: string = packageJson.version;

/**
 * Build a fully configured MCP server with every Slack tool registered.
 *
 * All tools are always registered so the tool list is stable and discoverable;
 * `user-required` tools error clearly at call time when no user token is set.
 */
export function createServer(
  config: Config,
  slack: SlackClient = new SlackClient(config),
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const deps: ToolDeps = { slack, config };

  registerChatTools(server, deps);
  registerConversationTools(server, deps);
  registerReactionTools(server, deps);
  registerPinTools(server, deps);
  registerBookmarkTools(server, deps);
  registerUserTools(server, deps);
  registerSearchTools(server, deps);
  registerFileTools(server, deps);

  return server;
}
