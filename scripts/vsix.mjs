// Package the VS Code extension into dist/mdr-reader-<version>.vsix (run after scripts/build.mjs).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = 'packages/vscode';
const { name, version } = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
mkdirSync('dist', { recursive: true });
const out = path.resolve('dist', `${name}-${version}.vsix`);
const vsce = path.resolve('node_modules/.bin/vsce');
execFileSync(vsce, ['package', '--no-dependencies', '--out', out], { cwd: dir, stdio: 'inherit' });
console.log(`\n  ${path.relative(process.cwd(), out)}`);
