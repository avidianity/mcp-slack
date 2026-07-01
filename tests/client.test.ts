import { describe, expect, test } from 'bun:test';
import { ErrorCode } from '@slack/web-api';
import { loadConfig } from '@/config.ts';
import { SlackApiError, SlackAuthError, SlackClient } from '@/slack/client.ts';

function botOnly(): SlackClient {
  return new SlackClient(loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1' }));
}

function withUser(): SlackClient {
  return new SlackClient(
    loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_USER_TOKEN: 'xoxp-1', SLACK_TEAM_ID: 'T1' }),
  );
}

describe('token policies', () => {
  test('bot-preferred resolves a client with only a bot token', () => {
    expect(botOnly().clientFor('bot-preferred')).toBeDefined();
  });

  test('user-preferred falls back to the bot client when no user token', () => {
    expect(botOnly().clientFor('user-preferred')).toBeDefined();
  });

  test('user-required throws without a user token', () => {
    expect(() => botOnly().clientFor('user-required')).toThrow(SlackAuthError);
    expect(() => botOnly().clientFor('user-required')).toThrow(/SLACK_USER_TOKEN/);
  });

  test('user-required resolves with a user token', () => {
    expect(withUser().clientFor('user-required')).toBeDefined();
  });

  test('exposes team id and channel allowlist', () => {
    const client = new SlackClient(
      loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T9', SLACK_CHANNEL_IDS: 'C1,C2' }),
    );
    expect(client.teamId).toBe('T9');
    expect(client.channelIds).toEqual(['C1', 'C2']);
  });
});

describe('error normalization', () => {
  test('maps an ok:false platform error to its slack error code', async () => {
    const client = botOnly();
    const promise = client.call('bot-preferred', () =>
      Promise.reject({ data: { error: 'channel_not_found' } }),
    );
    await expect(promise).rejects.toBeInstanceOf(SlackApiError);
    await expect(promise).rejects.toThrow(/channel_not_found/);
  });

  test('captures retry-after on a rate-limit error', async () => {
    const client = botOnly();
    try {
      await client.call('bot-preferred', () =>
        Promise.reject({ code: ErrorCode.RateLimitedError, retryAfter: 7 }),
      );
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SlackApiError);
      expect((error as SlackApiError).retryAfter).toBe(7);
    }
  });

  test('re-throws auth errors untouched', async () => {
    const client = botOnly();
    const promise = client.call('user-required', () => Promise.resolve({ ok: true }));
    await expect(promise).rejects.toBeInstanceOf(SlackAuthError);
  });
});
