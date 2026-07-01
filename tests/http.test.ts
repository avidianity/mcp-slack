import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { loadConfig } from '@/config.ts';
import { createServer } from '@/server.ts';
import { startHttp } from '@/transports/http.ts';

const HOST = '127.0.0.1';
const PORT = 45813;
const AUTH_TOKEN = 'test-secret-token';
const BASE = `http://${HOST}:${PORT.toString()}`;

const config = loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1' });

/** Raw POST allowing a forged Host header (which fetch forbids). */
function rawPost(headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: HOST, port: PORT, path: '/mcp', method: 'POST', headers },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  });
}

describe('http transport', () => {
  let server: Server;

  beforeAll(async () => {
    server = await startHttp(() => createServer(config), {
      host: HOST,
      port: PORT,
      authToken: AUTH_TOKEN,
    });
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  test('GET /health returns ok', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('unknown paths return 404', async () => {
    const res = await fetch(`${BASE}/nope`);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  test('POST /mcp without a Bearer token is unauthorized', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: initializeBody(),
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  test('POST /mcp with a wrong token is unauthorized', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer wrong',
      },
      body: initializeBody(),
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  test('POST /mcp with a bad JSON body returns 400', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    await res.body?.cancel();
  });

  test('rejects a forged Host header (DNS-rebinding protection)', async () => {
    const status = await rawPost(
      {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Host: 'evil.example.com',
      },
      initializeBody(),
    );
    expect(status).toBe(403);
  });

  test('authorized initialize establishes a session', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: initializeBody(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    await res.body?.cancel();
  });
});
