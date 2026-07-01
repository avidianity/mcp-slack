import { describe, expect, test } from 'bun:test';
import { parseCliArgs } from '@/cli.ts';

describe('parseCliArgs', () => {
  test('defaults to stdio on port 3000', () => {
    const opts = parseCliArgs([]);
    expect(opts).toEqual({ transport: 'stdio', port: 3000, host: '127.0.0.1' });
  });

  test('parses http transport with custom port and host', () => {
    const opts = parseCliArgs(['--transport', 'http', '--port', '8080', '--host', '0.0.0.0']);
    expect(opts).toEqual({ transport: 'http', port: 8080, host: '0.0.0.0' });
  });

  test('supports short flags', () => {
    const opts = parseCliArgs(['-t', 'http', '-p', '9000']);
    expect(opts.transport).toBe('http');
    expect(opts.port).toBe(9000);
  });

  test('rejects an out-of-range port', () => {
    expect(() => parseCliArgs(['--port', '70000'])).toThrow();
  });

  test('rejects an unknown transport', () => {
    expect(() => parseCliArgs(['--transport', 'grpc'])).toThrow();
  });
});
