import { mountReader, type Host, type HostEvent } from '@mdr/core';

interface Config {
  token: string;
  mode: 'file' | 'folder';
  showAll: boolean;
  root: string;
}

const cfg = (window as unknown as { MDR_CONFIG: Config }).MDR_CONFIG;
const headers = { 'x-mdr-token': cfg.token };

async function get(path: string, params: Record<string, string>): Promise<Response> {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

async function post(path: string, params: Record<string, string>, body: string): Promise<void> {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
}

const host: Host = {
  mode: cfg.mode,
  showAll: cfg.showAll,
  listFiles: async () => (await get('/api/files', {})).json(),
  readFile: async (p) => (await get('/api/file', { p })).text(),
  resolveImport: async (from, ref) => (await get('/api/import', { from, ref })).json(),
  getBaseline: async (p) => ((await (await get('/api/baseline', { p })).json()) as { text: string | null }).text,
  markRead: (p, text) => post('/api/read', { p }, text),
  state: {
    get: async (k) => ((await (await get('/api/state', { k })).json()) as { value: never }).value ?? undefined,
    set: (k, v) => post('/api/state', { k }, JSON.stringify(v)),
  },
  onEvent(cb) {
    const es = new EventSource(`/api/events?t=${cfg.token}`);
    let wasOpen = false;
    es.onmessage = (m) => cb(JSON.parse(m.data) as HostEvent);
    es.onopen = () => {
      // After a reconnect (e.g. laptop sleep), resync everything.
      if (wasOpen) cb({ type: 'files' });
      wasOpen = true;
      document.documentElement.classList.remove('offline');
    };
    es.onerror = () => document.documentElement.classList.add('offline');
    return () => es.close();
  },
};

document.title = `${cfg.root} · mdr`;
void mountReader(document.getElementById('app')!, host);
