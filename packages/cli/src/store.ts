import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Local persistence in ~/.mdr (override with MDR_HOME):
 *   snapshots/<sha1(abs path)>.md  last-read baseline per file
 *   state.json                     view state (folds, focus) keyed by "<abs path>|<key>"
 */
export class Store {
  readonly dir: string;
  private state: Record<string, unknown> | null = null;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(dir = process.env.MDR_HOME || path.join(os.homedir(), '.mdr')) {
    this.dir = dir;
  }

  private snapPath(abs: string) {
    return path.join(this.dir, 'snapshots', createHash('sha1').update(abs).digest('hex') + '.md');
  }

  async getSnapshot(abs: string): Promise<string | null> {
    try {
      return await readFile(this.snapPath(abs), 'utf8');
    } catch {
      return null;
    }
  }

  async setSnapshot(abs: string, text: string): Promise<void> {
    const p = this.snapPath(abs);
    await mkdir(path.dirname(p), { recursive: true });
    await atomicWrite(p, text);
  }

  private async loadState() {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(await readFile(path.join(this.dir, 'state.json'), 'utf8'));
    } catch {
      this.state = {};
    }
    return this.state!;
  }

  async getState(key: string): Promise<unknown> {
    return (await this.loadState())[key];
  }

  async setState(key: string, value: unknown): Promise<void> {
    const st = await this.loadState();
    if (value === undefined || value === null) delete st[key];
    else st[key] = value;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 200);
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (!this.state) return;
    await mkdir(this.dir, { recursive: true });
    await atomicWrite(path.join(this.dir, 'state.json'), JSON.stringify(this.state));
  }
}

let seq = 0;
async function atomicWrite(p: string, data: string) {
  // Unique per write: two overlapping flushes must not rename the same temp file.
  const tmp = `${p}.${process.pid}.${++seq}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, p);
}
