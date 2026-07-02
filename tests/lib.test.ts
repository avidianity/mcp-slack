import { describe, expect, test } from 'bun:test';
// Importing must not parse argv, read env config, or start a transport — that
// behavior belongs to the CLI entry (src/index.ts) only.
import * as lib from '@/lib.ts';

describe('library entry', () => {
  test('exposes the embedding surface', () => {
    expect(typeof lib.loadConfig).toBe('function');
    expect(typeof lib.createServer).toBe('function');
    expect(typeof lib.SlackClient).toBe('function');
    expect(typeof lib.startStdio).toBe('function');
    expect(typeof lib.startHttp).toBe('function');
    expect(lib.OUTPUT_FORMATS).toEqual(['toon', 'json']);
    expect(new lib.SlackAuthError('x')).toBeInstanceOf(Error);
    expect(new lib.SlackApiError('x')).toBeInstanceOf(Error);
  });

  test('builds a working server from an explicit env', () => {
    const config = lib.loadConfig({ SLACK_BOT_TOKEN: 'xoxb-test' });
    const server = lib.createServer(config);
    expect(server).toBeDefined();
  });
});
