import packageJson from '../package.json' with { type: 'json' };

// `--packages external` also externalizes internal @/ aliases on some Bun
// versions. Bundle our modules and externalize only declared dependencies.
for (const [filename, target, format] of [
  ['lib.js', 'node', 'esm'],
  ['lib.bun.js', 'bun', 'esm'],
  ['lib.cjs', 'node', 'cjs'],
] as const) {
  const result = await Bun.build({
    entrypoints: ['./src/lib.ts'],
    outdir: './dist',
    naming: filename,
    target,
    format,
    external: Object.keys(packageJson.dependencies),
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Failed to build ${filename}.`);
  }
}
