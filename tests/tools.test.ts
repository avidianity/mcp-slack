import { beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WebClient } from '@slack/web-api';
import { loadConfig } from '@/config.ts';
import { SlackClient } from '@/slack/client.ts';
import { createServer } from '@/server.ts';
import type { TokenPolicy } from '@/slack/client.ts';

const CANNED = {
  ok: true,
  channel: 'C1',
  ts: '111.222',
  message: { text: 'hello', ts: '111.222' },
  messages: [{ ts: '1.0', text: 'hi', user: 'U1', files: [{ id: 'F1', mimetype: 'image/png' }] }],
  channels: [
    { id: 'C1', name: 'general' },
    { id: 'C9', name: 'secret' },
  ],
  members: ['U1', 'U2'],
  user: { id: 'U1', name: 'ace' },
  permalink: 'https://slack/x',
  scheduled_message_id: 'Q1',
  files: [{ id: 'F1', name: 'f.txt' }],
  response_metadata: { next_cursor: 'CUR' },
};

interface RecordedCall {
  policy: TokenPolicy;
  method: string;
  args: Record<string, unknown>;
}

function cannedFor(method: string, args: Record<string, unknown>): unknown {
  // conversations.info drives the allowlist path of list_channels; echo
  // the requested id back as a proper channel object. 'CBAD' simulates a channel
  // the token cannot see, so the allowlist path must tolerate a failed lookup.
  if (method === 'conversations.info') {
    if (args['channel'] === 'CBAD') {
      return Promise.reject({ data: { error: 'channel_not_found' } });
    }
    return { ok: true, channel: { id: args['channel'], name: 'general' } };
  }
  // search.messages / scheduledMessages.list return items across two channels so
  // allowlist filtering can be asserted.
  if (method === 'search.messages') {
    return {
      ok: true,
      messages: {
        total: 2,
        pagination: { page: 1, page_count: 1 },
        matches: [
          { ts: '1', text: 'a', channel: { id: 'C1', name: 'general' } },
          { ts: '2', text: 'b', channel: { id: 'C2', name: 'secret' } },
        ],
      },
    };
  }
  // conversations.list / users.list back the directory-search tools. Single
  // page (no next_cursor) so the internal paginator terminates.
  if (method === 'conversations.list') {
    return {
      ok: true,
      channels: [
        { id: 'C1', name: 'general', is_member: true },
        { id: 'C2', name: 'random', is_member: false },
      ],
    };
  }
  if (method === 'conversations.history') {
    // Two U1 messages share a single page (no next_cursor) so the user-filter
    // path can be exercised for both correctness and no-slice behavior.
    return {
      ok: true,
      messages: [
        { ts: '12.0', text: 'later', user: 'U1' },
        { ts: '11.0', text: 'hi', user: 'U2' },
        { ts: '10.0', text: 'morning', user: 'U1' },
      ],
    };
  }
  if (method === 'users.list') {
    return {
      ok: true,
      members: [
        {
          id: 'U1',
          name: 'ace',
          profile: { real_name: 'Ada Lovelace', display_name: 'ada', email: 'ada@x.io' },
        },
        {
          id: 'U2',
          name: 'bob',
          deleted: true,
          profile: { real_name: 'Bob Stone', display_name: 'bobby', email: 'bob@x.io' },
        },
      ],
    };
  }
  if (method === 'files.info') {
    return {
      ok: true,
      file: {
        id: args['file'],
        name: 'shot.png',
        mimetype: 'image/png',
        size: 3,
        url_private: 'https://slack/files/shot.png',
        url_private_download: 'https://slack/files/shot.png?dl=1',
      },
    };
  }
  if (method === 'chat.scheduledMessages.list') {
    return {
      ok: true,
      scheduled_messages: [
        { id: 'Q1', channel_id: 'C1' },
        { id: 'Q2', channel_id: 'C2' },
      ],
    };
  }
  return CANNED;
}

function makeRecorder(record: (method: string, args: Record<string, unknown>) => void): WebClient {
  const build = (path: string[]): unknown =>
    new Proxy(function noop(): void {}, {
      get: (_t, prop) => build([...path, String(prop)]),
      apply: (_t, _this, argsList: unknown[]) => {
        const method = path.join('.');
        const args = (argsList[0] ?? {}) as Record<string, unknown>;
        record(method, args);
        return Promise.resolve(cannedFor(method, args));
      },
    });
  return build([]) as WebClient;
}

async function connect(config = loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1' })) {
  const slack = new SlackClient(config);
  const calls: RecordedCall[] = [];
  const recorder = makeRecorder((method, args) => {
    calls.push({ policy: lastPolicy, method, args });
  });
  let lastPolicy: TokenPolicy = 'bot-preferred';
  (slack as unknown as { call: SlackClient['call'] }).call = ((policy: TokenPolicy, fn) => {
    lastPolicy = policy;
    return fn(recorder);
  }) as SlackClient['call'];

  const server = createServer(config, slack);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, calls };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text: string }[];
  return content[0]?.text ?? '';
}

describe('tool behavior', () => {
  let ctx: Awaited<ReturnType<typeof connect>>;

  beforeEach(async () => {
    ctx = await connect();
  });

  test('post_message maps args to chat.postMessage', async () => {
    const result = await ctx.client.callTool({
      name: 'post_message',
      arguments: { channel: 'C1', text: 'hi there' },
    });
    expect(result.isError).toBeFalsy();
    const call = ctx.calls.at(-1);
    expect(call?.method).toBe('chat.postMessage');
    expect(call?.args).toMatchObject({ channel: 'C1', text: 'hi there' });
    expect(textOf(result)).toContain('111.222');
  });

  test('respects the json format override', async () => {
    const result = await ctx.client.callTool({
      name: 'post_message',
      arguments: { channel: 'C1', text: 'hi', format: 'json' },
    });
    expect(JSON.parse(textOf(result))).toMatchObject({ ts: '111.222' });
  });

  test('update_message uses the user-preferred policy', async () => {
    await ctx.client.callTool({
      name: 'update_message',
      arguments: { channel: 'C1', ts: '111.222', text: 'edited' },
    });
    const call = ctx.calls.at(-1);
    expect(call?.method).toBe('chat.update');
    expect(call?.policy).toBe('user-preferred');
  });

  test('list_channels resolves exactly the allowlisted channels', async () => {
    const scoped = await connect(
      loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1', SLACK_CHANNEL_IDS: 'C1,C2' }),
    );
    const result = await scoped.client.callTool({
      name: 'list_channels',
      arguments: { format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { channels: { id: string }[] };
    // Deterministic: one conversations.info per allowlisted id, not a filtered page.
    expect(parsed.channels.map((c) => c.id)).toEqual(['C1', 'C2']);
    expect(scoped.calls.every((c) => c.method === 'conversations.info')).toBe(true);
    await scoped.client.close();
  });

  test('allowlist blocks a channel-scoped call to a disallowed channel', async () => {
    const scoped = await connect(
      loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1', SLACK_CHANNEL_IDS: 'C1' }),
    );
    const blocked = await scoped.client.callTool({
      name: 'post_message',
      arguments: { channel: 'C2', text: 'nope' },
    });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toMatch(/allowlist/i);
    // The disallowed call never reached Slack.
    expect(scoped.calls.some((c) => c.method === 'chat.postMessage')).toBe(false);

    const allowed = await scoped.client.callTool({
      name: 'post_message',
      arguments: { channel: 'C1', text: 'ok' },
    });
    expect(allowed.isError).toBeFalsy();
    await scoped.client.close();
  });

  test('list_channels tolerates an inaccessible allowlisted channel', async () => {
    const scoped = await connect(
      loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1', SLACK_CHANNEL_IDS: 'C1,CBAD' }),
    );
    const result = await scoped.client.callTool({
      name: 'list_channels',
      arguments: { format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { channels: { id: string }[] };
    // The failed lookup for CBAD is dropped; C1 still returned.
    expect(parsed.channels.map((c) => c.id)).toEqual(['C1']);
    await scoped.client.close();
  });

  test('search_messages filters matches to the allowlist', async () => {
    const scoped = await connect(
      loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1', SLACK_CHANNEL_IDS: 'C1' }),
    );
    const result = await scoped.client.callTool({
      name: 'search_messages',
      arguments: { query: 'x', format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { matches: { channel_id: string }[] };
    expect(parsed.matches.map((m) => m.channel_id)).toEqual(['C1']);
    await scoped.client.close();
  });

  test('list_scheduled_messages filters to the allowlist', async () => {
    const scoped = await connect(
      loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1', SLACK_CHANNEL_IDS: 'C1' }),
    );
    const result = await scoped.client.callTool({
      name: 'list_scheduled_messages',
      arguments: { format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { scheduled_messages: { id: string }[] };
    expect(parsed.scheduled_messages.map((m) => m.id)).toEqual(['Q1']);
    await scoped.client.close();
  });

  test('search_channels fuzzy-matches and ranks channels', async () => {
    const result = await ctx.client.callTool({
      name: 'search_channels',
      arguments: { query: 'general', include_non_member: true, format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as {
      channels: { name: string }[];
      truncated: boolean;
      scanned: number;
    };
    expect(parsed.channels.map((c) => c.name)).toEqual(['general']);
    expect(parsed.truncated).toBe(false);
    expect(parsed.scanned).toBe(2);
  });

  test('search_channels excludes non-member channels by default', async () => {
    const result = await ctx.client.callTool({
      name: 'search_channels',
      arguments: { query: 'random', format: 'json' }, // "random" (C2) is a non-member channel
    });
    const parsed = JSON.parse(textOf(result)) as { channels: { id: string }[] };
    expect(parsed.channels).toEqual([]);
  });

  test('search_channels searches within the allowlist only', async () => {
    const scoped = await connect(
      loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1', SLACK_CHANNEL_IDS: 'C1' }),
    );
    const result = await scoped.client.callTool({
      name: 'search_channels',
      arguments: { query: 'general', format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { channels: { id: string }[] };
    expect(parsed.channels.map((c) => c.id)).toEqual(['C1']);
    // Resolved via conversations.info, never the workspace-wide list.
    expect(scoped.calls.every((c) => c.method === 'conversations.info')).toBe(true);
    await scoped.client.close();
  });

  test('list_channels returns only member channels by default', async () => {
    const result = await ctx.client.callTool({
      name: 'list_channels',
      arguments: { format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { channels: { id: string }[] };
    expect(parsed.channels.map((c) => c.id)).toEqual(['C1']);
  });

  test('list_channels includes non-member channels when asked', async () => {
    const result = await ctx.client.callTool({
      name: 'list_channels',
      arguments: { include_non_member: true, format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { channels: { id: string }[] };
    expect(parsed.channels.map((c) => c.id)).toEqual(['C1', 'C2']);
  });

  test('get_users hides deactivated users by default', async () => {
    const result = await ctx.client.callTool({
      name: 'get_users',
      arguments: { format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { users: { id: string }[] };
    expect(parsed.users.map((u) => u.id)).toEqual(['U1']);
  });

  test('get_users includes deactivated users when asked', async () => {
    const result = await ctx.client.callTool({
      name: 'get_users',
      arguments: { include_deleted: true, format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { users: { id: string }[] };
    expect(parsed.users.map((u) => u.id)).toEqual(['U1', 'U2']);
  });

  test('get_channel_history filters to a single sender when user is set', async () => {
    const result = await ctx.client.callTool({
      name: 'get_channel_history',
      arguments: { channel: 'C1', user: 'U1', format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { messages: { user: string }[] };
    expect(parsed.messages.map((m) => m.user)).toEqual(['U1', 'U1']);
  });

  test('get_channel_history returns all same-page matches even beyond limit', async () => {
    const result = await ctx.client.callTool({
      name: 'get_channel_history',
      arguments: { channel: 'C1', user: 'U1', limit: 1, format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as {
      messages: { user: string }[];
      nextCursor?: string;
    };
    // Slicing to limit=1 would strand the second U1 message on the same page,
    // while nextCursor points to the next page — so both are returned and the
    // single (exhausted) page exposes no cursor.
    expect(parsed.messages.map((m) => m.user)).toEqual(['U1', 'U1']);
    expect(parsed.nextCursor).toBeUndefined();
  });

  test('search_messages folds channel and user into in:/from: operators', async () => {
    await ctx.client.callTool({
      name: 'search_messages',
      arguments: { query: 'checkout', channel: 'C0123456789', user: 'U04KPEGV0RW', format: 'json' },
    });
    const call = ctx.calls.at(-1);
    expect(call?.method).toBe('search.messages');
    const query = String(call?.args['query']);
    expect(query).toContain('checkout');
    expect(query).toContain('in:<#C0123456789>');
    expect(query).toContain('from:<@U04KPEGV0RW>');
  });

  test('search_messages treats non-ID channel/user as names', async () => {
    await ctx.client.callTool({
      name: 'search_messages',
      arguments: { query: 'x', channel: 'ge-daily-dev', user: 'me', format: 'json' },
    });
    const query = String(ctx.calls.at(-1)?.args['query']);
    expect(query).toContain('in:#ge-daily-dev');
    expect(query).toContain('from:@me');
  });

  test('search_messages rejects a channel/user value containing spaces', async () => {
    const result = await ctx.client.callTool({
      name: 'search_messages',
      arguments: { query: 'x', user: 'John Michael', format: 'json' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/space/i);
    // Rejected at validation; the call never reached Slack.
    expect(ctx.calls.some((c) => c.method === 'search.messages')).toBe(false);
  });

  test('search_channels rejects a one-character query', async () => {
    const result = await ctx.client.callTool({
      name: 'search_channels',
      arguments: { query: 'a', format: 'json' },
    });
    expect(result.isError).toBe(true);
  });

  test('search_users fuzzy-matches and hides deactivated users by default', async () => {
    const result = await ctx.client.callTool({
      name: 'search_users',
      arguments: { query: 'lovelace', format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { users: { id: string }[]; scanned: number };
    expect(parsed.users.map((u) => u.id)).toEqual(['U1']);
    // Deactivated Bob is excluded from the scanned set.
    expect(parsed.scanned).toBe(1);
  });

  test('search_users can include deactivated users', async () => {
    const result = await ctx.client.callTool({
      name: 'search_users',
      arguments: { query: 'stone', include_deleted: true, format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { users: { id: string }[] };
    expect(parsed.users.map((u) => u.id)).toEqual(['U2']);
  });

  test('upload_file rejects when both content and file_path are given', async () => {
    const result = await ctx.client.callTool({
      name: 'upload_file',
      arguments: { filename: 'a.txt', content: 'hi', file_path: '/tmp/a.txt' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/only one/i);
    expect(ctx.calls.some((c) => c.method.startsWith('files'))).toBe(false);
  });

  test('get_thread_replies surfaces attached files as id:mimetype', async () => {
    const result = await ctx.client.callTool({
      name: 'get_thread_replies',
      arguments: { channel: 'C1', ts: '1.0', format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { messages: { files?: string }[] };
    expect(parsed.messages[0]?.files).toBe('F1:image/png');
  });

  test('get_file downloads a supported image and returns an image content block', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      )) as unknown as typeof fetch;
    try {
      const result = await ctx.client.callTool({
        name: 'get_file',
        arguments: { file_id: 'F1' },
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as { type: string; data?: string; mimeType?: string }[];
      const image = content.find((c) => c.type === 'image');
      expect(image?.mimeType).toBe('image/png');
      // 3 raw bytes → base64 of [1,2,3].
      expect(image?.data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
      expect(ctx.calls.at(-1)?.method).toBe('files.info');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('get_file returns metadata only when the file exceeds max_bytes', async () => {
    const result = await ctx.client.callTool({
      name: 'get_file',
      arguments: { file_id: 'F1', max_bytes: 1, format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { download_url: string; note: string };
    expect(parsed.download_url).toContain('dl=1');
    expect(parsed.note).toMatch(/max_bytes/);
  });

  test('search_messages errors clearly without a user token', async () => {
    // Real (unmocked) client so the user-required policy is enforced.
    const config = loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1' });
    const server = createServer(config);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const result = await client.callTool({
      name: 'search_messages',
      arguments: { query: 'hello' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/SLACK_USER_TOKEN/);
    await client.close();
  });
});
