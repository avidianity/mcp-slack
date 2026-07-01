# @avidian/mcp-slack

[![Release](https://github.com/avidianity/mcp-slack/actions/workflows/release.yml/badge.svg)](https://github.com/avidianity/mcp-slack/actions/workflows/release.yml)

A modern [Model Context Protocol](https://modelcontextprotocol.io) server for Slack, built on
Bun + TypeScript. It exposes Slack's Web API to any MCP-compatible AI agent and returns
results in [TOON](https://github.com/toon-format/toon) by default for large token savings —
with per-call JSON opt-out.

This is a rewrite of [`zencoderai/slack-mcp-server`](https://github.com/zencoderai/slack-mcp-server),
adding **dual-token auth** (bot _and_ user), the ability to **edit and delete your own
messages**, **message search**, a much wider API surface, and both **stdio** and
**Streamable HTTP** transports.

> Available on npm as [`@avidian/mcp-slack`](https://www.npmjs.com/package/@avidian/mcp-slack).

## Why TOON?

Slack responses are highly tabular (lists of channels, users, messages). TOON encodes uniform
arrays of objects as a compact header + rows, typically using **30–60% fewer tokens** than
JSON while staying lossless. Any tool call can override the format per request when the agent
prefers JSON.

## Features

- **Dual-token auth** — bot token (`xoxb-`) and/or user token (`xoxp-`), routed per tool.
- **Edit & delete your own messages** — `chat.update` / `chat.delete` via user token.
- **Message search** — `search.messages` (user token).
- **TOON-first output** with per-call `format: "toon" | "json"`.
- **Agent-controlled paging** — `limit` is set per call; TOON gets a higher default.
- **Two transports** — stdio (default) and Streamable HTTP with Bearer auth.
- **Resilient** — built-in `Retry-After` (429) handling.

## Install

Run directly (no install):

```bash
bunx @avidian/mcp-slack      # or: npx @avidian/mcp-slack
```

Or add as a dependency:

```bash
bun add @avidian/mcp-slack
```

## Slack app setup

Create a Slack app and install it to your workspace. Grant scopes for the features you need:

**Bot token scopes** (`SLACK_BOT_TOKEN`)

```
channels:read  channels:history  groups:read  groups:history
im:history  mpim:history  chat:write  reactions:read  reactions:write
users:read  users.profile:read  pins:read  pins:write
bookmarks:read  bookmarks:write  files:read  files:write
```

**User token scopes** (`SLACK_USER_TOKEN`) — required for editing/deleting your own messages
and search

```
chat:write  search:read
```

You need **at least one** of the two tokens. The user token unlocks the user-scoped tools.

## Configuration

| Variable                    | Required        | Description                                                           |
| --------------------------- | --------------- | --------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`           | one of bot/user | Bot token, `xoxb-…`                                                   |
| `SLACK_USER_TOKEN`          | one of bot/user | User token, `xoxp-…` (edit/delete own, search)                        |
| `SLACK_TEAM_ID`             | no              | Workspace id, `T…`; scopes listings for org-level tokens              |
| `SLACK_CHANNEL_IDS`         | no              | Comma-separated channel-ID allowlist (enforced boundary)              |
| `AUTH_TOKEN`                | no              | Bearer token for HTTP transport (auto-generated if unset)             |
| `SLACK_MCP_DEFAULT_FORMAT`  | no              | `toon` (default) or `json`                                            |
| `SLACK_MCP_ALLOWED_HOSTS`   | no              | HTTP: extra `Host` values to accept (enables protection on `0.0.0.0`) |
| `SLACK_MCP_ALLOWED_ORIGINS` | no              | HTTP: allowed `Origin` values for browser clients                     |

Transport options are passed as CLI flags: `--transport stdio\|http`, `--port <n>`, `--host <h>`.

When `SLACK_CHANNEL_IDS` is set it is a real access boundary, not just a list filter:
every channel-scoped tool call must target a channel ID in the list, or it is rejected
before reaching Slack. `slack_list_channels`, `slack_search_messages`, and
`slack_list_scheduled_messages` return only allowlisted channels. The allowlist matches on
channel **IDs**, so pass IDs (not names) to channel-scoped tools when it is set.

`SLACK_TEAM_ID` is optional and only relevant for org-level (Enterprise Grid) tokens, where
it scopes workspace-wide listings (`slack_list_channels`, `slack_get_users`) to one team.

### HTTP transport security

The HTTP transport requires a Bearer token and enables DNS-rebinding protection automatically
when bound to a concrete host (loopback or a specific address). For a wildcard bind
(`--host 0.0.0.0`) no canonical host can be derived, so set `SLACK_MCP_ALLOWED_HOSTS` to the
public `host:port` value(s) to keep protection on — otherwise it is disabled with a warning
and only Bearer auth applies. Set `SLACK_MCP_ALLOWED_ORIGINS` for browser-based clients.

## Usage

### Claude Desktop / MCP client (stdio)

```json
{
  "mcpServers": {
    "slack": {
      "command": "bunx",
      "args": ["@avidian/mcp-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-…",
        "SLACK_USER_TOKEN": "xoxp-…",
        "SLACK_TEAM_ID": "T…"
      }
    }
  }
}
```

### Streamable HTTP

```bash
SLACK_BOT_TOKEN=xoxb-… SLACK_TEAM_ID=T… AUTH_TOKEN=secret \
  bunx @avidian/mcp-slack --transport http --port 3000
```

Then point your MCP client at `http://localhost:3000/mcp` with header
`Authorization: Bearer secret`.

## Tools

Every tool accepts an optional `format` (`"toon"` | `"json"`). Paginated tools accept an
optional `limit` (agent-controlled; clamped only to Slack's per-method maximum).

**Messaging (`chat.*`)**

| Tool                             | Slack method                     | Token      |
| -------------------------------- | -------------------------------- | ---------- |
| `slack_post_message`             | `chat.postMessage`               | bot        |
| `slack_reply_to_thread`          | `chat.postMessage` (`thread_ts`) | bot        |
| `slack_update_message`           | `chat.update`                    | user → bot |
| `slack_delete_message`           | `chat.delete`                    | user → bot |
| `slack_post_ephemeral`           | `chat.postEphemeral`             | bot        |
| `slack_schedule_message`         | `chat.scheduleMessage`           | bot        |
| `slack_list_scheduled_messages`  | `chat.scheduledMessages.list`    | bot        |
| `slack_delete_scheduled_message` | `chat.deleteScheduledMessage`    | bot        |
| `slack_get_permalink`            | `chat.getPermalink`              | bot        |

**Conversations**

| Tool                        | Slack method            |
| --------------------------- | ----------------------- |
| `slack_list_channels`       | `conversations.list`    |
| `slack_get_channel_history` | `conversations.history` |
| `slack_get_thread_replies`  | `conversations.replies` |
| `slack_get_channel_info`    | `conversations.info`    |
| `slack_get_channel_members` | `conversations.members` |
| `slack_join_channel`        | `conversations.join`    |
| `slack_mark_read`           | `conversations.mark`    |

**Reactions / Pins / Bookmarks**

| Tool                                                                    | Slack method                  |
| ----------------------------------------------------------------------- | ----------------------------- |
| `slack_add_reaction` / `slack_remove_reaction` / `slack_get_reactions`  | `reactions.add\|remove\|get`  |
| `slack_add_pin` / `slack_remove_pin` / `slack_list_pins`                | `pins.add\|remove\|list`      |
| `slack_add_bookmark` / `slack_remove_bookmark` / `slack_list_bookmarks` | `bookmarks.add\|remove\|list` |

**Users / Search / Files**

| Tool                     | Slack method                       | Token    |
| ------------------------ | ---------------------------------- | -------- |
| `slack_get_users`        | `users.list`                       | bot      |
| `slack_get_user_profile` | `users.info` / `users.profile.get` | bot      |
| `slack_search_messages`  | `search.messages`                  | **user** |
| `slack_upload_file`      | `filesUploadV2`                    | bot      |

## Development

```bash
bun install
bun run typecheck     # strict TypeScript
bun run lint          # typescript-eslint (strict, type-checked)
bun run format:check  # Prettier
bun test              # bun:test
```

## License

MIT
