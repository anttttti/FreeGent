// mime.ts — FreeGent: the one extension / MIME table. Pure data and string helpers (no DOM, no
// shiro imports) so the Pyodide worker bundle, the page and the chat attachment code share it.

const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel', ods: 'application/vnd.oasis.opendocument.spreadsheet',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    flac: 'audio/flac', aac: 'audio/aac', weba: 'audio/webm',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
    wasm: 'application/wasm', bin: 'application/octet-stream',
};

const DOC_EXTS = new Set(['pdf', 'docx', 'doc', 'odt', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odp']);
const BINARY_EXTS = new Set([...DOC_EXTS, 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp',
    'mp3', 'mp4', 'wav', 'ogg', 'zip', 'gz', 'tar', 'wasm', 'bin']);

// MIME type → document kind that extractDocumentText understands.
const DOC_KIND_BY_MIME: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.oasis.opendocument.spreadsheet': 'ods',
};

/** Lower-case extension of a file name or path, with the leading dot ('' if none). */
export function extOf(name: string): string {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
}
const bare = (ext: string): string => ext.replace(/^\./, '').toLowerCase();

/** MIME type for an extension ('png' or '.png'); 'application/octet-stream' when unknown. */
export function mimeOfExt(ext: string): string {
    return MIME_BY_EXT[bare(ext)] || 'application/octet-stream';
}
export function mimeOfName(name: string): string { return mimeOfExt(extOf(name)); }

export function isBinaryExt(name: string): boolean { return BINARY_EXTS.has(bare(extOf(name))); }
export function isDocExt(name: string): boolean { return DOC_EXTS.has(bare(extOf(name))); }

/** Document kind ('pdf', 'docx', …) for a MIME type, or undefined. */
export function docKindOfMime(mime: string): string | undefined { return DOC_KIND_BY_MIME[mime]; }
/** Document kind for an extension of a kind extractDocumentText handles ('pdf', 'docx', …), or undefined. */
export function docKindOfExt(ext: string): string | undefined {
    const k = bare(ext);
    return Object.values(DOC_KIND_BY_MIME).includes(k) ? k : undefined;
}

/** Image MIME type for a file name, or '' when the file is not an image. */
export function imageMimeOfName(name: string): string {
    const m = mimeOfName(name);
    return m.startsWith('image/') ? m : '';
}

/** Extensions read_file refuses to return as text (binary formats beyond the doc/media sets). */
export const UNREADABLE_BINARY_RE = /\.(so|pyc|pkl|bin|gz|zip|tar|jar|class|o|a|whl|pyd|dylib|dex|exe|dll)$/i;

/** Python imports of libraries that need a display and cannot run headless or in a Web Worker. */
export const DISPLAY_LIBS_RE = /^\s*(?:import|from)\s+(pygame|pygame_ce|turtle|tkinter|wx|gi\.repository|PyQt[456]|PySide[26])\b/m;
