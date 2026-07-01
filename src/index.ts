#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { CommanderError } from 'commander';
import { parseCliArgs } from '@/cli.ts';
import { loadConfig } from '@/config.ts';
import { SlackClient } from '@/slack/client.ts';
import { createServer } from '@/server.ts';
import { startStdio } from '@/transports/stdio.ts';
import { startHttp } from '@/transports/http.ts';

function fatal(message: string): never {
  process.stderr.write(`mcp-slack: ${message}\n`);
  process.exit(1);
}

function parseArgsOrExit(): ReturnType<typeof parseCliArgs> {
  try {
    return parseCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CommanderError) {
      // commander has already written help/usage/error output.
      process.exit(error.exitCode);
    }
    throw error;
  }
}

/**
 * Register SIGINT/SIGTERM handlers that close the active transport before
 * exiting, so in-flight work and sockets are released cleanly (and exactly once).
 */
function installShutdown(close: () => Promise<void> | void): void {
  let shuttingDown = false;
  const handler = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void Promise.resolve(close()).finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

async function main(): Promise<void> {
  const options = parseArgsOrExit();
  const config = loadConfig();
  const slack = new SlackClient(config);

  if (options.transport === 'stdio') {
    const server = createServer(config, slack);
    installShutdown(() => server.close());
    await startStdio(server);
    return;
  }

  const authToken = config.authToken ?? randomUUID();
  if (config.authToken === undefined) {
    process.stderr.write(`mcp-slack: generated AUTH_TOKEN for this session: ${authToken}\n`);
  }
  const httpServer = await startHttp(() => createServer(config, slack), {
    host: options.host,
    port: options.port,
    authToken,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
  });
  installShutdown(
    () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => {
          resolve();
        });
      }),
  );
  process.stderr.write(
    `mcp-slack: HTTP transport listening on http://${options.host}:${options.port}/mcp\n`,
  );
}

main().catch((error: unknown) => {
  fatal(error instanceof Error ? error.message : String(error));
});
