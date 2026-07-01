import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface HttpOptions {
  readonly host: string;
  readonly port: number;
  readonly authToken: string;
  /** Extra `Host` header values to accept (operator-provided, for exposed binds). */
  readonly allowedHosts?: readonly string[];
  /** `Origin` header values to accept (for browser clients); unset skips the check. */
  readonly allowedOrigins?: readonly string[];
}

const SESSION_HEADER = 'mcp-session-id';

/** Maximum accepted JSON request body (4 MiB) — guards against memory blowups. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Loopback hosts always trusted for DNS-rebinding protection. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/** Wildcard binds where a single canonical Host cannot be derived. */
const WILDCARD_HOSTS = ['0.0.0.0', '::', '::0'];

/** Raised when a request body exceeds `MAX_BODY_BYTES`. */
class PayloadTooLargeError extends Error {}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(payload);
}

interface DnsProtection {
  enableDnsRebindingProtection?: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

/**
 * Compute DNS-rebinding protection settings for the bound host.
 *
 * Protection is enabled whenever the bind has a canonical Host — loopback or a
 * concrete address/hostname — pinning `allowedHosts` to that authority plus
 * loopback and any operator-provided hosts. For a wildcard bind (`0.0.0.0`/`::`)
 * no canonical Host exists, so protection is only enabled if the operator supplies
 * `allowedHosts`; otherwise it is left off (a warning is emitted by the caller).
 */
function computeDnsProtection(options: HttpOptions): DnsProtection {
  const operatorHosts = options.allowedHosts ?? [];
  const operatorOrigins = options.allowedOrigins ?? [];
  const isWildcard = WILDCARD_HOSTS.includes(options.host);

  if (isWildcard && operatorHosts.length === 0) {
    return {};
  }

  const hosts = new Set<string>(LOOPBACK_HOSTS.map((h) => hostAuthority(h, options.port)));
  if (!isWildcard) {
    hosts.add(hostAuthority(options.host, options.port));
  }
  for (const h of operatorHosts) {
    hosts.add(h);
  }

  return {
    enableDnsRebindingProtection: true,
    allowedHosts: [...hosts],
    ...(operatorOrigins.length > 0 ? { allowedOrigins: [...operatorOrigins] } : {}),
  };
}

/** Path portion of the request URL, without query string. */
function pathnameOf(req: IncomingMessage): string {
  return (req.url ?? '').split('?')[0] ?? '';
}

/** Format a `host:port` authority, bracketing IPv6 hosts as the Host header does. */
function hostAuthority(host: string, port: number): string {
  const h = host.includes(':') ? `[${host}]` : host;
  return `${h}:${port.toString()}`;
}

function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return false;
  }
  const provided = Buffer.from(header.slice('Bearer '.length));
  const expectedBuf = Buffer.from(expected);
  return provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError('Request body too large.');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}

function getSessionId(req: IncomingMessage): string | undefined {
  const value = req.headers[SESSION_HEADER];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Serve the MCP server over Streamable HTTP with Bearer auth and per-session
 * transports. A fresh `McpServer` (via `makeServer`) is connected per session.
 */
export async function startHttp(
  makeServer: () => McpServer,
  options: HttpOptions,
): Promise<HttpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const dnsProtection = computeDnsProtection(options);
  if (dnsProtection.enableDnsRebindingProtection !== true) {
    process.stderr.write(
      `mcp-slack: warning — DNS-rebinding protection is off for wildcard host ${options.host}; ` +
        'set SLACK_MCP_ALLOWED_HOSTS to enable it. Bearer auth still applies.\n',
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = pathnameOf(req);

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    if (!isAuthorized(req, options.authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const sessionId = getSessionId(req);

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          // Close the connection: the unread body makes keep-alive unsafe to reuse.
          sendJson(res, 413, { error: error.message }, { Connection: 'close' });
        } else {
          sendJson(res, 400, { error: 'Invalid JSON body.' });
        }
        return;
      }
      const existing = sessionId !== undefined ? transports.get(sessionId) : undefined;

      if (existing !== undefined) {
        await existing.handleRequest(req, res, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        sendJson(res, 400, { error: 'No valid session; expected an initialize request.' });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessionclosed: (id) => {
          transports.delete(id);
        },
        ...dnsProtection,
      });
      const server = makeServer();
      await server.connect(transport as Parameters<McpServer['connect']>[0]);
      await transport.handleRequest(req, res, body);
      if (transport.sessionId !== undefined) {
        transports.set(transport.sessionId, transport);
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
      if (transport === undefined) {
        sendJson(res, 400, { error: 'Unknown or missing session.' });
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  }

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, options.host, resolve);
  });

  return httpServer;
}
