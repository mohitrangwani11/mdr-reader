/**
 * Share links carry the whole document in the URL fragment (#s=…), compressed.
 * Fragments are never sent to a server, so sharing needs no backend and stores nothing.
 */

export const SHARE_PREFIX = '#s=';
/** Beyond this, some chat apps and email clients truncate links. */
export const LONG_LINK_CHARS = 8000;

export async function encodeShare(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return toBase64Url(bytes);
}

export async function decodeShare(data: string): Promise<string> {
  const bytes = fromBase64Url(data);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/** Extract the share payload from a location hash, if any. */
export function shareFromHash(h: string): string | null {
  return h.startsWith(SHARE_PREFIX) ? h.slice(SHARE_PREFIX.length) : null;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
