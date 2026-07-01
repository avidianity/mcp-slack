import { describe, expect, test } from 'bun:test';
import { loadConfig } from '@/config.ts';

describe('loadConfig', () => {
  test('accepts a bot-only configuration', () => {
    const config = loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1' });
    expect(config.hasBotToken).toBe(true);
    expect(config.hasUserToken).toBe(false);
    expect(config.defaultFormat).toBe('toon');
  });

  test('accepts a user-only configuration', () => {
    const config = loadConfig({ SLACK_USER_TOKEN: 'xoxp-1', SLACK_TEAM_ID: 'T1' });
    expect(config.hasUserToken).toBe(true);
    expect(config.hasBotToken).toBe(false);
  });

  test('accepts both tokens', () => {
    const config = loadConfig({
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_USER_TOKEN: 'xoxp-1',
      SLACK_TEAM_ID: 'T1',
    });
    expect(config.hasBotToken).toBe(true);
    expect(config.hasUserToken).toBe(true);
  });

  test('rejects when neither token is set', () => {
    expect(() => loadConfig({ SLACK_TEAM_ID: 'T1' })).toThrow(/at least one/i);
  });

  test('team id is optional', () => {
    const config = loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1' });
    expect(config.teamId).toBeUndefined();
    expect(config.hasBotToken).toBe(true);
  });

  test('parses allowed hosts and origins lists', () => {
    const config = loadConfig({
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_TEAM_ID: 'T1',
      SLACK_MCP_ALLOWED_HOSTS: 'example.com:3000, mcp.internal ',
      SLACK_MCP_ALLOWED_ORIGINS: 'https://app.example.com',
    });
    expect(config.allowedHosts).toEqual(['example.com:3000', 'mcp.internal']);
    expect(config.allowedOrigins).toEqual(['https://app.example.com']);
  });

  test('parses a comma-separated channel allowlist', () => {
    const config = loadConfig({
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_TEAM_ID: 'T1',
      SLACK_CHANNEL_IDS: ' C1, C2 ,C3 ',
    });
    expect(config.channelIds).toEqual(['C1', 'C2', 'C3']);
  });

  test('treats empty-string optional vars as unset', () => {
    const config = loadConfig({
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_USER_TOKEN: '',
      SLACK_TEAM_ID: 'T1',
      AUTH_TOKEN: '   ',
      SLACK_CHANNEL_IDS: '',
      SLACK_MCP_DEFAULT_FORMAT: '',
    });
    expect(config.hasUserToken).toBe(false);
    expect(config.authToken).toBeUndefined();
    expect(config.channelIds).toEqual([]);
    expect(config.defaultFormat).toBe('toon');
  });

  test('rejects when both tokens are empty strings', () => {
    expect(() =>
      loadConfig({ SLACK_BOT_TOKEN: '', SLACK_USER_TOKEN: '', SLACK_TEAM_ID: 'T1' }),
    ).toThrow(/at least one/i);
  });

  test('rejects an invalid default format', () => {
    expect(() =>
      loadConfig({
        SLACK_BOT_TOKEN: 'xoxb-1',
        SLACK_TEAM_ID: 'T1',
        SLACK_MCP_DEFAULT_FORMAT: 'yaml',
      }),
    ).toThrow();
  });
});
