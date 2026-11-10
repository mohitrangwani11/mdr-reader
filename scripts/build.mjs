import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const out = 'packages/cli/dist';
await mkdir(`${out}/public`, { recursive: true });

// Browser bundle: the reader core + the CLI's HTTP/SSE host client.
await build({
  entryPoints: ['packages/cli/src/client/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110', 'safari16', 'firefox115'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  outfile: `${out}/public/app.js`,
  logLevel: 'info',
});
await copyFile('packages/core/src/styles.css', `${out}/public/app.css`);
await copyFile('packages/cli/src/client/index.html', `${out}/public/index.html`);

// Node bundle: the CLI server. chokidar stays external (a runtime dependency).
await build({
  entryPoints: ['packages/cli/src/cli.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['chokidar'],
  outfile: `${out}/cli.js`,
  logLevel: 'info',
});

// Paste edition: ONE self-contained HTML file (inline JS + CSS, no external requests),
// so it works by double-clicking (file://) and as-is on any static host.
const web = await build({
  entryPoints: ['packages/web/src/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'safari16', 'firefox115'],
  minify: true,
  write: false,
  logLevel: 'info',
});
const js = web.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = (await readFile('packages/core/src/styles.css', 'utf8')) + '\n' + (await readFile('packages/web/src/web.css', 'utf8'));
const template = await readFile('packages/web/src/index.html', 'utf8');
// Function replacements: minified JS is full of `$` sequences that string replacement would interpret.
const html = template.replace('/*CSS*/', () => css.replace(/<\/style/gi, '<\\/style')).replace('/*JS*/', () => js);
await mkdir('dist', { recursive: true });
await writeFile('dist/mdr.html', html);
console.log(`\n  dist/mdr.html  ${(html.length / 1024).toFixed(1)}kb  (paste edition, self-contained)`);

if (process.argv.includes('--open-web')) {
  const file = path.resolve('dist/mdr.html');
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}
