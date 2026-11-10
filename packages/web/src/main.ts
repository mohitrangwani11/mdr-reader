import { mountReader, icons, type Reader } from '@mdr/core';
import { DocStore, safeKV, StorageFullError } from './store.ts';
import { WebHost } from './host.ts';
import { encodeShare, decodeShare, shareFromHash, LONG_LINK_CHARS } from './share.ts';
import { EXAMPLE } from './example.ts';
import { canLink, pickFileHandles, handlesFromDrop, permission, saveLink, getLink, allLinks, type FileHandle } from './handles.ts';

const store = new DocStore(safeKV());
const host = new WebHost(store);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const pasteKey = isMac ? '⌘V' : 'Ctrl+V';

/* ---- empty state ------------------------------------------------------------ */
const empty = document.createElement('div');
empty.className = 'drop-empty';
empty.innerHTML = `
  <div class="de-key">${pasteKey}</div>
  <h2>Paste markdown to read it</h2>
  <p>Paste anywhere on this page, drop <code>.md</code> files, or:</p>
  <div class="de-actions">
    <button type="button" class="tbtn primary de-type">${icons.plus}Add a doc</button>
    <button type="button" class="tbtn de-open">${icons.file}Open files…</button>
    <button type="button" class="tbtn de-example">Try an example</button>
  </div>
  <p class="de-note">Everything stays in this browser. Nothing is uploaded.</p>`;

/* ---- file input & modal --------------------------------------------------- */
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.accept = '.md,.markdown,.mdx,.mdc,.txt,text/markdown,text/plain';
fileInput.hidden = true;
document.body.append(fileInput);

const dialog = document.createElement('dialog');
dialog.className = 'paste-dialog';
dialog.innerHTML = `
  <form method="dialog">
    <div class="pd-head"><h2 class="pd-title"></h2><button type="button" class="ibtn pd-x" aria-label="Close">${icons.x}</button></div>
    <p class="pd-hint"></p>
    <textarea spellcheck="false" placeholder="Paste or type markdown"></textarea>
    <div class="pd-drop">
      <span class="pd-drop-ic">${icons.file}</span>
      <span class="pd-drop-t">Or drop <b>.md</b> files here</span>
      <button type="button" class="tbtn pd-files">Choose files…</button>
    </div>
    <div class="pd-actions">
      <span class="pd-key"><kbd>${isMac ? '⌘' : 'Ctrl'}</kbd> <kbd>↵</kbd> to add</span>
      <button type="button" class="tbtn pd-cancel">Cancel</button>
      <button type="submit" class="tbtn primary pd-ok" value="ok"></button>
    </div>
  </form>`;
document.body.append(dialog);
const dTitle = dialog.querySelector<HTMLElement>('.pd-title')!;
const dHint = dialog.querySelector<HTMLElement>('.pd-hint')!;
const dText = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
const dOk = dialog.querySelector<HTMLButtonElement>('.pd-ok')!;
/** The doc a "new version" dialog targets (null = a new doc). */
let dialogInto: string | null = null;
for (const sel of ['.pd-cancel', '.pd-x']) dialog.querySelector(sel)!.addEventListener('click', () => dialog.close());
dialog.querySelector('.pd-files')!.addEventListener('click', () => {
  const into = dialogInto;
  dialog.close();
  void chooseFiles(into);
});

/**
 * The one "add" dialog: paste/type text, or drop / choose files.
 * Resolves with the text, or null when cancelled or when files were used instead.
 */
function askText(title: string, hint: string, ok: string, into: string | null = null): Promise<string | null> {
  dTitle.textContent = title;
  dHint.textContent = hint;
  dOk.textContent = ok;
  dText.value = '';
  dialogInto = into;
  dialog.returnValue = '';
  dialog.showModal();
  dText.focus();
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        dialog.classList.remove('dragging');
        resolve(dialog.returnValue === 'ok' && dText.value.trim() ? dText.value : null);
      },
      { once: true },
    );
  });
}
dText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    dialog.close('ok');
  }
});

async function newDoc() {
  const t = await askText('Add a doc', 'Paste markdown from any .md file, or bring the files themselves.', 'Add doc');
  if (t) await addText(t);
}

async function newVersion(r: Reader) {
  const id = r.currentPath();
  if (!id) return;
  const name = store.meta(id)?.name ?? 'this doc';
  const t = await askText(`New version of “${name}”`, 'Paste the updated text or drop the updated file. Changes since you last read it are highlighted.', 'Show changes', id);
  if (t) await addVersion(id, t);
}

/* ---- doc operations ---------------------------------------------------------- */
let reader: Reader;

function guard<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    reader?.toast(e instanceof StorageFullError ? e.message : `Something went wrong: ${(e as Error).message}`);
    return undefined;
  }
}

/** Add text as a new doc (or reopen an identical one) and show it. Returns the doc id. */
async function addText(text: string, fileName?: string): Promise<string | undefined> {
  if (!text.trim()) return;
  const same = store.findByHash(text);
  if (same) {
    await reader.open(same.id);
    reader.toast('You already have this doc, opened it');
    return same.id;
  }
  const meta = guard(() => store.create(text, fileName));
  if (!meta) return;
  await reader.open(meta.id);
  await reader.refresh(); // update the sidebar right away
  return meta.id;
}

/** Replace a doc's text; the reader diffs it against what you last read. */
async function addVersion(id: string, text: string, from?: string) {
  if (store.get(id) === text) {
    reader.toast(from ? `Up to date with ${from}` : 'No changes in this version');
    return;
  }
  const meta = guard(() => store.update(id, text));
  if (!meta) return;
  await reader.open(id);
  await reader.refresh();
  reader.toast(`${from ? `Reloaded ${from}` : 'New version'}: changes are highlighted (n to jump, m to mark read)`);
}

const MAX_FILE = 5_000_000;

/** Add one file from disk: a file whose name matches a doc becomes a new version of it. */
async function addFile(f: File, handle?: FileHandle | null, intoId?: string): Promise<void> {
  if (f.size > MAX_FILE) {
    reader.toast(`${f.name} is too large (over 5 MB)`);
    return;
  }
  const text = await f.text();
  const existing = intoId ? store.meta(intoId) : store.findByFileName(f.name);
  let id: string | undefined;
  if (existing) {
    id = existing.id;
    await addVersion(id, text, f.name);
  } else id = await addText(text, f.name);
  if (id && handle && (await saveLink(id, handle, f.lastModified))) {
    store.setLinked(id, true);
    await reader.refresh();
  }
}

async function addFiles(files: FileList | File[], handles: (FileHandle | null)[] = []) {
  const list = [...files];
  for (const [i, f] of list.entries()) {
    const h = handles[i]?.name === f.name ? handles[i] : null;
    await addFile(f, h);
  }
}

/**
 * Choose files from disk. Where the browser supports it, the docs stay linked to the files.
 * With `into`, the (first) file becomes a new version of that doc.
 */
async function chooseFiles(into: string | null = null) {
  if (!canLink) {
    pickInto = into;
    return fileInput.click();
  }
  try {
    const hs = await pickFileHandles();
    if (into && hs[0]) await addFile(await hs[0].getFile(), hs[0], into);
    else for (const h of hs) await addFile(await h.getFile(), h);
  } catch {
    pickInto = into;
    fileInput.click();
  }
}
const openFiles = () => chooseFiles();

/** Pull the latest text of the open doc from its file. */
async function reloadDoc(r: Reader) {
  const id = r.currentPath();
  const meta = id ? store.meta(id) : undefined;
  if (!id || !meta) return;
  const link = await getLink(id);
  if (link) {
    const ok = (await permission(link.handle, true)) === 'granted';
    if (ok) {
      try {
        const f = await link.handle.getFile();
        await saveLink(id, link.handle, f.lastModified);
        await addVersion(id, await f.text(), f.name);
        return;
      } catch {
        r.toast(`Could not read ${meta.fileName ?? 'the file'}. It may have moved. Pick it again`);
      }
    }
  }
  // Not linked (Safari/Firefox, or opened before linking existed), moved, or denied: pick the file again.
  await chooseFiles(id);
}
/** When set, the next file chosen with the fallback picker becomes a new version of this doc. */
let pickInto: string | null = null;

/** Quietly pull in edits to linked files (on returning to the tab). Only files we may read without asking. */
let checking = false;
async function checkLinked() {
  if (checking || !canLink) return;
  checking = true;
  try {
    const changed: string[] = [];
    for (const [id, link] of await allLinks()) {
      if (!store.meta(id) || (await permission(link.handle, false)) !== 'granted') continue;
      try {
        const f = await link.handle.getFile();
        if (f.lastModified === link.lastModified) continue;
        const text = await f.text();
        await saveLink(id, link.handle, f.lastModified);
        if (text !== store.get(id) && guard(() => store.update(id, text))) changed.push(f.name);
      } catch {
        /* file moved or deleted: keep the last copy */
      }
    }
    if (changed.length) {
      host.emit({ type: 'files' });
      reader.toast(changed.length === 1 ? `${changed[0]} changed on disk` : `${changed.length} files changed on disk`);
    }
  } finally {
    checking = false;
  }
}

/* ---- toolbar actions ------------------------------------------------------- */
async function share(r: Reader) {
  const id = r.currentPath();
  const text = id && store.get(id);
  if (!text) return;
  const url = `${location.href.split('#')[0]}#s=${await encodeShare(text)}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Clipboard blocked: put the link in the address bar so it can be copied by hand.
    history.replaceState(null, '', url);
    r.toast('Could not copy. The share link is now in the address bar');
    return;
  }
  r.toast(
    url.length > LONG_LINK_CHARS
      ? `Link copied (${Math.round(url.length / 1000)}k chars, long: some apps may cut it off)`
      : 'Link copied. Anyone with it can read this doc',
  );
}

/* ---- boot ---------------------------------------------------------------------- */
async function importShared(): Promise<void> {
  const data = shareFromHash(location.hash);
  if (!data) return;
  try {
    const text = await decodeShare(data);
    const meta = store.findByHash(text) ?? guard(() => store.create(text));
    history.replaceState(null, '', meta ? `#f=${encodeURIComponent(meta.id)}` : location.pathname);
  } catch {
    history.replaceState(null, '', location.pathname);
    queueMicrotask(() => reader?.toast('That share link looks broken or incomplete'));
  }
}

await importShared();

reader = await mountReader(document.getElementById('app')!, host, {
  emptyState: empty,
  actions: [
    { label: 'New', icon: 'plus', title: `Add a doc: paste text or choose files (or just press ${pasteKey} anywhere)`, run: () => newDoc() },
    { label: 'Share', icon: 'share', title: 'Copy a link that contains this doc', needsFile: true, primary: true, run: (r) => share(r) },
    { label: 'New version', icon: 'version', title: 'Paste or drop an updated version to see what changed', key: 'v', needsFile: true, placement: 'menu', run: (r) => newVersion(r) },
    {
      label: 'Reload from file',
      icon: 'reload',
      title: 'Reload this doc from its file and highlight what changed',
      key: 'u',
      placement: 'crumb',
      showFor: (id) => !!store.meta(id)?.fileName,
      run: (r) => reloadDoc(r),
    },
    {
      label: 'Open files…',
      icon: 'file',
      title: canLink ? 'Open .md files (they stay linked, so you can reload them)' : 'Open .md files from your computer',
      placement: 'menu',
      run: () => openFiles(),
    },
  ],
});

empty.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('.de-open')) await openFiles();
  else if (t.closest('.de-example')) await addText(EXAMPLE, 'CLAUDE.md');
  else if (t.closest('.de-type')) await newDoc();
});

fileInput.addEventListener('change', async () => {
  const into = pickInto;
  pickInto = null;
  if (fileInput.files?.length) {
    if (into) await addFile(fileInput.files[0], null, into);
    else await addFiles(fileInput.files);
  }
  fileInput.value = '';
});
// A cancelled fallback picker must not turn the next Open… into a reload.
fileInput.addEventListener('cancel', () => (pickInto = null));

// Paste anywhere (outside text fields) creates a doc. No clipboard permission needed.
document.addEventListener('paste', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest?.('input, textarea, [contenteditable]') || dialog.open) return;
  const files = e.clipboardData?.files;
  if (files?.length) {
    e.preventDefault();
    void addFiles(files);
    return;
  }
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!text.trim()) return;
  e.preventDefault();
  void addText(text);
});

// Drag and drop .md files anywhere.
let dragDepth = 0;
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dragging');
  dialog.classList.toggle('dragging', dialog.open);
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
    dialog.classList.remove('dragging');
  }
});
document.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  const handles = handlesFromDrop(e.dataTransfer); // must start inside the event
  // Dropped onto a "new version" dialog: the file becomes that doc's next version.
  const into = dialog.open ? dialogInto : null;
  if (dialog.open) dialog.close();
  void handles.then((h) => (into ? addFile(files[0], h[0]?.name === files[0].name ? h[0] : null, into) : addFiles(files, h)));
});

// Coming back to the tab (e.g. after editing a file): pick up changes to linked files.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void checkLinked();
});
window.addEventListener('focus', () => void checkLinked());
void checkLinked();

// Share links opened while the page is already open.
window.addEventListener('hashchange', async () => {
  if (!shareFromHash(location.hash)) return;
  await importShared();
  const id = decodeURIComponent(location.hash.match(/f=([^&]+)/)?.[1] ?? '');
  host.emit({ type: 'files' });
  if (id) await reader.open(id);
});
