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
  messages: [{ ts: '1.0', text: 'hi', user: 'U1' }],
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
  // conversations.info drives the allowlist path of slack_list_channels; echo
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
      name: 'slack_post_message',
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
      name: 'slack_post_message',
      arguments: { channel: 'C1', text: 'hi', format: 'json' },
    });
    expect(JSON.parse(textOf(result))).toMatchObject({ ts: '111.222' });
  });

  test('update_message uses the user-preferred policy', async () => {
    await ctx.client.callTool({
      name: 'slack_update_message',
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
      name: 'slack_list_channels',
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
      name: 'slack_post_message',
      arguments: { channel: 'C2', text: 'nope' },
    });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toMatch(/allowlist/i);
    // The disallowed call never reached Slack.
    expect(scoped.calls.some((c) => c.method === 'chat.postMessage')).toBe(false);

    const allowed = await scoped.client.callTool({
      name: 'slack_post_message',
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
      name: 'slack_list_channels',
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
      name: 'slack_search_messages',
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
      name: 'slack_list_scheduled_messages',
      arguments: { format: 'json' },
    });
    const parsed = JSON.parse(textOf(result)) as { scheduled_messages: { id: string }[] };
    expect(parsed.scheduled_messages.map((m) => m.id)).toEqual(['Q1']);
    await scoped.client.close();
  });

  test('upload_file rejects when both content and file_path are given', async () => {
    const result = await ctx.client.callTool({
      name: 'slack_upload_file',
      arguments: { filename: 'a.txt', content: 'hi', file_path: '/tmp/a.txt' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/only one/i);
    expect(ctx.calls.some((c) => c.method.startsWith('files'))).toBe(false);
  });

  test('search_messages errors clearly without a user token', async () => {
    // Real (unmocked) client so the user-required policy is enforced.
    const config = loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1' });
    const server = createServer(config);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const result = await client.callTool({
      name: 'slack_search_messages',
      arguments: { query: 'hello' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/SLACK_USER_TOKEN/);
    await client.close();
  });
});
