import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.ts';

const HELP = `mdr — a foldable, diff-aware reader for agent markdown files

Usage
  mdr [file|folder]     Open a file, or a folder of agent files (default: .)

Options
  --port <n>            Port to listen on (default 4711, falls back to a free one)
  --all                 Expand the "Other markdown" group in folder mode
  --no-open             Don't open a browser window
  -h, --help            Show this help

State (last-read snapshots, fold state) lives in ~/.mdr (override with MDR_HOME).`;

function parseArgs(argv: string[]) {
  const out = { target: '.', port: 4711, showAll: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(HELP);
      process.exit(0);
    } else if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--all') out.showAll = true;
    else if (a === '--no-open') out.open = false;
    else if (a.startsWith('-')) {
      console.error(`Unknown option ${a}\n\n${HELP}`);
      process.exit(1);
    } else out.target = a;
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) {
    console.error('Invalid --port');
    process.exit(1);
  }
  return out;
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = path.resolve(args.target);
  if (!existsSync(target)) {
    console.error(`mdr: no such file or folder: ${args.target}`);
    process.exit(1);
  }
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  const server = await startServer({ target, port: args.port, showAll: args.showAll, publicDir });
  console.log(`mdr is reading ${target}\n  ${server.url}\n  Ctrl+C to stop`);
  if (args.open) openBrowser(server.url);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(`mdr: ${e.message}`);
  process.exit(1);
});
