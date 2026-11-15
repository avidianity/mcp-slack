import { afterAll, beforeAll, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
let packaged: string | undefined;

beforeAll(async () => {
  const build = spawnSync(process.execPath, ['run', 'build:lib'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(build.status, 0, build.stderr);
  packaged = await mkdtemp(join(tmpdir(), 'mcp-slack-package-'));
  await cp(join(root, 'package.json'), join(packaged, 'package.json'));
  await cp(join(root, 'dist'), join(packaged, 'dist'), { recursive: true });
  await symlink(join(root, 'node_modules'), join(packaged, 'node_modules'), 'dir');
});

afterAll(async () => {
  if (packaged !== undefined) await rm(packaged, { recursive: true });
});

for (const runtime of ['node-esm', 'node-cjs', 'bun'] as const) {
  test(`published library entry works in ${runtime} without CLI side effects`, () => {
    assert(packaged !== undefined);
    const imports =
      runtime === 'node-cjs'
        ? "const { loadConfig, createServer } = require('@avidian/mcp-slack');"
        : "import { loadConfig, createServer } from '@avidian/mcp-slack';";
    const script = `${imports}
      const server = createServer(loadConfig({ SLACK_BOT_TOKEN: 'xoxb-test' }));
      if (server === undefined) throw new Error('Server creation failed');
      process.stdout.write('ready');`;
    const command = runtime === 'bun' ? process.execPath : 'node';
    const args =
      runtime === 'bun'
        ? ['--eval', script]
        : ['--input-type', runtime === 'node-cjs' ? 'commonjs' : 'module', '--eval', script];
    const result = spawnSync(command, [...args, '--', '--transport=invalid'], {
      cwd: packaged,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, SLACK_BOT_TOKEN: '', SLACK_USER_TOKEN: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ready');
  });
}
