import { Command, InvalidArgumentError, Option } from 'commander';

export const TRANSPORTS = ['stdio', 'http'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export interface CliOptions {
  readonly transport: Transport;
  readonly port: number;
  readonly host: string;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError('Port must be an integer between 1 and 65535.');
  }
  return port;
}

/**
 * Build the CLI parser. Exposed separately so it can be unit-tested without
 * triggering process exit.
 */
export function buildProgram(): Command {
  return new Command()
    .name('mcp-slack')
    .description('TOON-first Model Context Protocol server for Slack.')
    .exitOverride()
    .addOption(
      new Option('-t, --transport <transport>', 'transport to serve over')
        .choices(TRANSPORTS)
        .default('stdio'),
    )
    .addOption(
      new Option('-p, --port <port>', 'port for the HTTP transport')
        .argParser(parsePort)
        .default(DEFAULT_PORT),
    )
    .addOption(
      new Option('-H, --host <host>', 'host for the HTTP transport').default(DEFAULT_HOST),
    );
}

/**
 * Parse CLI arguments into typed options.
 *
 * @param argv - Full argv (including `node`/script entries) or a user-args
 *   array. Pass `{ from: 'user' }`-style arrays in tests.
 */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const program = buildProgram();
  program.parse(argv, { from: 'user' });
  const opts = program.opts<{ transport: Transport; port: number; host: string }>();
  return {
    transport: opts.transport,
    port: opts.port,
    host: opts.host,
  };
}
