// workspace.js — FreeGent file workspace
// IndexedDB storage + optional File System Access API

export interface WorkspaceAdapter {
    agentListFiles(): Promise<Array<{name: string; size?: number; lastModified?: number}>>;
    /** List only files inside a specific subdirectory (relative to workspace root). Paths returned are relative to that subdir. Fast path — no stat calls. */
    agentListFilesInDir?(dir: string): Promise<Array<{name: string}>>;
    agentReadFile(path: string, encoding?: string): Promise<string>;
    agentWriteFile(path: string, content: string, encoding?: string): Promise<void>;
    agentDeleteFile(path: string): Promise<void>;
    /** Returns the file's last-modified timestamp (ms since epoch), or null if not found. */
    agentFileMtime?(path: string): Promise<number | null>;
}

let _wa: WorkspaceAdapter | null = null; // injected adapter (Node.js/headless only; null → IndexedDB/FSA)

const DB_NAME    = 'FreeGentDB';
const DB_VERSION = 4;
const STORE      = 'files';
const HDL_STORE  = 'handles';
const CKPT_STORE = 'checkpoints';
const PROJ_STORE = 'projects';

const DOC_EXTENSIONS    = new Set(['.pdf', '.docx', '.doc', '.odt', '.xlsx', '.xls', '.ods', '.pptx', '.ppt', '.odp']);
const BINARY_EXTENSIONS = new Set([...DOC_EXTENSIONS, '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.mp3', '.mp4', '.wav', '.ogg', '.zip', '.gz', '.tar', '.wasm', '.bin']);

function _extOf(name) { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i).toLowerCase() : ''; }
function _isBinaryExt(name) { return BINARY_EXTENSIONS.has(_extOf(name)); }
function _isDocExt(name)    { return DOC_EXTENSIONS.has(_extOf(name)); }
function _mimeOf(name) {
    return {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
        '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
        '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
    }[_extOf(name)] || 'application/octet-stream';
}
function _uint8ToBase64(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
function _base64ToUint8(b64) {
    // Strip INTERIOR '=' padding only (artifact of chunked btoa encoding) then re-pad at end.
    // plain atob() stops at the first interior '=', silently truncating the output.
    // /=+(?!$)/ matches one-or-more '=' NOT at end-of-string so trailing padding is preserved,
    // then we re-normalise by stripping any trailing '=' and re-adding the correct amount.
    const s = b64.replace(/=+(?!$)/g, '').replace(/=+$/, ''), pad = (4 - s.length % 4) % 4;
    const raw = atob(s + '='.repeat(pad));
    const u = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    return u;
}

let db: IDBDatabase | null              = null;
let fsaHandle: FileSystemDirectoryHandle | null       = null; // File System Access directory handle
let pendingFsaHandle: FileSystemDirectoryHandle | null = null; // stored handle awaiting user permission gesture


let fsaSyncTimer: number | null  = null;
let fsaSyncMtimes: Map<string, number> = new Map(); // relative path → lastModified timestamp

async function startFsaSync() {
    stopFsaSync();
    // Seed initial mtimes so first poll doesn't flag everything as changed
    const names = await listFsaFiles();
    await Promise.all(names.map(async name => {
        if (name.endsWith('/')) { fsaSyncMtimes.set(name, 0); return; }
        try { fsaSyncMtimes.set(name, await getFsaMtime(name)); } catch {}
    }));
    fsaSyncTimer = setInterval(pollFsaChanges, 1500);
}

function stopFsaSync() {
    if (fsaSyncTimer) { clearInterval(fsaSyncTimer); fsaSyncTimer = null; }
    fsaSyncMtimes = new Map();
}

async function getFsaMtime(name) {
    const { dir, filename } = await fsaNavigate(name);
    const fh   = await dir.getFileHandle(filename);
    const file = await fh.getFile();
    return file.lastModified;
}

async function pollFsaChanges() {
    if (!fsaHandle) { stopFsaSync(); return; }
    try {
        const names    = await listFsaFiles();
        const nameSet  = new Set(names);
        const prevKeys = new Set(fsaSyncMtimes.keys());

        let listChanged  = false;
        const changed    = []; // { name, mtime }

        await Promise.all(names.map(async name => {
            if (name.endsWith('/')) {
                // Directory sentinel — track by presence only, no mtime comparison
                if (!prevKeys.has(name)) { listChanged = true; fsaSyncMtimes.set(name, 0); }
                return;
            }
            try {
                const mtime = await getFsaMtime(name);
                if (!prevKeys.has(name)) { listChanged = true; fsaSyncMtimes.set(name, mtime); }
                else if (mtime !== fsaSyncMtimes.get(name)) { fsaSyncMtimes.set(name, mtime); changed.push(name); }
            } catch {}
        }));

        for (const name of prevKeys)
            if (!nameSet.has(name)) { listChanged = true; fsaSyncMtimes.delete(name); }

        if (!changed.length && !listChanged) return;
        if (listChanged) await renderFileList();

        let taskFileChanged  = false;
        let skillFileChanged = false;
        let roleFileChanged  = false;
        await Promise.all(changed.map(async name => {
            try {
                const content = await readFsaFile(name);
                notifyLocalFileChanged?.('local/' + name, content);
                if (name.startsWith('fg-tasks/') || name.startsWith('tasks/'))  taskFileChanged  = true;
                if (name.startsWith('skills/') || name.startsWith('rules/')) skillFileChanged = true;
                if (name.startsWith('roles/'))  roleFileChanged  = true;
            } catch {}
        }));

        if (taskFileChanged)  refreshTasks?.();
        if (skillFileChanged) loadSkills?.();
        if (roleFileChanged)  loadRoles?.();
    } catch {}
}


async function initDB() {
    return new Promise<any>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains(STORE))
                d.createObjectStore(STORE, { keyPath: 'name' });
            if (!d.objectStoreNames.contains(HDL_STORE))
                d.createObjectStore(HDL_STORE, { keyPath: 'id' });
            if (!d.objectStoreNames.contains(CKPT_STORE))
                d.createObjectStore(CKPT_STORE, { keyPath: 'id' });
            if (!d.objectStoreNames.contains(PROJ_STORE))
                d.createObjectStore(PROJ_STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => { db = req.result; resolve(db); };
        req.onerror   = () => reject(req.error);
    });
}

async function ensureDB() { if (!db) await initDB(); }

async function listWorkspaceFiles() {
    await ensureDB();
    return new Promise<any>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
    });
}

export async function readWorkspaceFile(name) {
    await ensureDB();
    return new Promise<any>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(name);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => reject(req.error);
    });
}

async function writeWorkspaceFile(name, content, lastModified = null, encoding = null) {
    await ensureDB();
    return new Promise<void>((resolve, reject) => {
        const record: any = { name, content, lastModified: lastModified || Date.now(), size: (content || '').length };
        if (encoding) record.encoding = encoding;
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(record);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// Returns only {name, size, lastModified} for each IDB file — content is never
// held in a JS reference, so earlier records are eligible for GC as the cursor advances.
async function listWorkspaceFilesMetaOnly() {
    await ensureDB();
    return new Promise<any>((resolve, reject) => {
        const meta: any[] = [];
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) { resolve(meta); return; }
            const r = cursor.value;
            // r.size is populated for records written after this change; fall back to
            // content.length for legacy records (one-time cost, disappears after next write).
            meta.push({ name: r.name, size: r.size ?? (r.content?.length ?? 0), lastModified: r.lastModified });
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });
}

async function listWorkspaceFileNames(): Promise<string[]> {
    await ensureDB();
    return new Promise<string[]>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
        req.onsuccess = () => resolve((req.result as string[]) || []);
        req.onerror   = () => reject(req.error);
    });
}

async function deleteWorkspaceFile(name) {
    await ensureDB();
    return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const req = store.delete(name);

        req.onsuccess = () => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        };
        req.onerror = () => reject(req.error);
    });
}


function fsaSupported() {
    // showDirectoryPicker requires a secure context (HTTPS or localhost).
    // On HTTP LAN the promise hangs forever, so check isSecureContext first.
    return 'showDirectoryPicker' in window && window.isSecureContext;
}

async function saveFsaHandle(handle) {
    await ensureDB();
    return new Promise<void>((resolve, reject) => {
        const req = db.transaction(HDL_STORE, 'readwrite').objectStore(HDL_STORE).put({ id: 'localFolder', handle });
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

async function loadFsaHandle() {
    await ensureDB();
    return new Promise<any>((resolve, reject) => {
        const req = db.transaction(HDL_STORE, 'readonly').objectStore(HDL_STORE).get('localFolder');
        req.onsuccess = () => resolve(req.result?.handle ?? null);
        req.onerror   = () => reject(req.error);
    });
}

async function clearFsaHandle() {
    await ensureDB();
    return new Promise<void>((resolve, reject) => {
        const req = db.transaction(HDL_STORE, 'readwrite').objectStore(HDL_STORE).delete('localFolder');
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// ── Checkpoint workspace snapshots ────────────────────────────────────────

function _ckptHash(s) {
    if (s == null) return '';
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return `${s.length}:${h >>> 0}`;
}

async function _getCkptsForChat(chatId) {
    await ensureDB();
    return new Promise<any>((resolve, reject) => {
        const req = db.transaction(CKPT_STORE, 'readonly').objectStore(CKPT_STORE).getAll();
        req.onsuccess = () => resolve(
            (req.result || []).filter(r => r.chatId === chatId).sort((a, b) => a.ts - b.ts)
        );
        req.onerror = () => reject(req.error);
    });
}

async function saveCheckpointSnapshot(chatId, ckptId) {
    await ensureDB();
    const ts = parseInt(ckptId, 10) || Date.now();

    const prev = (await _getCkptsForChat(chatId)).slice(-1)[0];
    const prevIdbH   = prev?.idbHashes   || {};
    const prevLocalH = prev?.localHashes || {};

    // IDB delta
    const idbFiles = await listWorkspaceFiles();
    const idbHashes = {};
    const idbDelta  = [];
    for (const f of idbFiles) {
        const h = _ckptHash(f.content || '');
        idbHashes[f.name] = h;
        const op = prevIdbH[f.name] === undefined ? 'add' : prevIdbH[f.name] !== h ? 'modify' : null;
        if (op) idbDelta.push({ name: f.name, content: f.content || '', op });
    }
    for (const name of Object.keys(prevIdbH)) {
        if (!idbHashes[name]) idbDelta.push({ name, content: null, op: 'delete' });
    }

    // Local (FSA) delta
    const localHashes = {};
    const localDelta  = [];
    if (fsaHandle) {
        try {
            const names = (await listFsaFiles()).filter(n => !n.endsWith('/'));
            await Promise.all(names.map(async name => {
                try {
                    const content = await readFsaFile(name);
                    const h = _ckptHash(content);
                    localHashes[name] = h;
                    const op = prevLocalH[name] === undefined ? 'add' : prevLocalH[name] !== h ? 'modify' : null;
                    if (op) localDelta.push({ name, content, op });
                } catch {}
            }));
            for (const name of Object.keys(prevLocalH)) {
                if (!localHashes[name]) localDelta.push({ name, content: null, op: 'delete' });
            }
        } catch {}
    }

    const record = { id: `${chatId}/${ckptId}`, chatId, ckptId, ts, idbDelta, localDelta, idbHashes, localHashes };
    return new Promise<void>((resolve, reject) => {
        const req = db.transaction(CKPT_STORE, 'readwrite').objectStore(CKPT_STORE).put(record);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// Returns { localFiles: [{name, content, op}] } — IDB is restored in place; local files returned for caller to handle.
async function restoreCheckpointWorkspace(chatId, ckptId) {
    const ckpts = await _getCkptsForChat(chatId);
    const targetIdx = ckpts.findIndex(c => c.ckptId === ckptId);
    if (targetIdx < 0) return { localFiles: [] };

    // Replay deltas from first checkpoint up to target to reconstruct state
    const idbState   = {};
    const localState = {};
    for (let i = 0; i <= targetIdx; i++) {
        for (const f of ckpts[i].idbDelta) {
            if (f.content === null) delete idbState[f.name];
            else idbState[f.name] = f.content;
        }
        for (const f of ckpts[i].localDelta) {
            if (f.content === null) delete localState[f.name];
            else localState[f.name] = f.content;
        }
    }

    // Restore IDB: delete all current files, write reconstructed set
    const current = await listWorkspaceFileNames();
    for (const name of current) await deleteWorkspaceFile(name);
    for (const [name, content] of Object.entries(idbState)) await writeWorkspaceFile(name, content);

    return { localFiles: Object.entries(localState).map(([name, content]) => ({ name, content })) };
}

async function getCheckpointDiff(chatId, ckptId) {
    const ckpts = await _getCkptsForChat(chatId);
    const ckpt = ckpts.find(c => c.ckptId === ckptId);
    if (!ckpt) return null;
    const targetIdx = ckpts.indexOf(ckpt);
    const prevIdb = {}, prevLocal = {};
    for (let i = 0; i < targetIdx; i++) {
        for (const f of ckpts[i].idbDelta)   { if (f.content === null) delete prevIdb[f.name];   else prevIdb[f.name]   = f.content; }
        for (const f of ckpts[i].localDelta) { if (f.content === null) delete prevLocal[f.name]; else prevLocal[f.name] = f.content; }
    }
    const annotate = (f, prev) => f.op === 'modify' ? { ...f, oldContent: prev[f.name] ?? '' } : f;
    return {
        idbDelta:   ckpt.idbDelta.map(f   => annotate(f, prevIdb)),
        localDelta: ckpt.localDelta.map(f => annotate(f, prevLocal)),
    };
}

async function deleteCheckpointData(chatId) {
    const ckpts = await _getCkptsForChat(chatId);
    if (!ckpts.length) return;
    const tx    = db.transaction(CKPT_STORE, 'readwrite');
    const store = tx.objectStore(CKPT_STORE);
    for (const c of ckpts) store.delete(c.id);
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

async function cleanupDanglingCheckpoints(validChatIds) {
    await ensureDB();
    const all = await new Promise<any>((resolve, reject) => {
        const req = db.transaction(CKPT_STORE, 'readonly').objectStore(CKPT_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
    });
    const valid    = new Set(validChatIds);
    const dangling = all.filter(r => !valid.has(r.chatId));
    if (!dangling.length) return;
    console.error(`[checkpoints] Removing ${dangling.length} dangling snapshot record(s) from deleted chats`);
    const tx    = db.transaction(CKPT_STORE, 'readwrite');
    const store = tx.objectStore(CKPT_STORE);
    for (const r of dangling) store.delete(r.id);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

async function tryRestoreLocalFolder() {
    if (!fsaSupported()) return;
    try {
        const handle = await loadFsaHandle();
        if (!handle) return;
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
            fsaHandle = handle;
            await renderFileList();
            startFsaSync();
            maybeRunInitAgent?.().catch(() => {});
            generateAndShowSuggestion?.().catch(() => {});
        } else if (perm === 'prompt') {
            pendingFsaHandle = handle;
            await renderFileList(); // shows Reconnect button
        }
        // 'denied' → leave stored, user can manually open again
    } catch (e) {
        console.warn('[FSA] restore failed:', e);
    }
}

async function reconnectLocalFolder() {
    if (!pendingFsaHandle) return;
    try {
        const perm = await pendingFsaHandle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
            fsaHandle = pendingFsaHandle;
            pendingFsaHandle = null;
            await renderFileList();
            startFsaSync();
            maybeRunInitAgent?.().catch(() => {});
            generateAndShowSuggestion?.().catch(() => {});
        } else {
            pendingFsaHandle = null;
            await clearFsaHandle();
            await renderFileList();
        }
    } catch (e) {
        console.warn('[FSA] reconnect failed:', e);
    }
}

async function openLocalFolder() {
    if (!fsaSupported()) {
        // Fallback: webkitdirectory input imports files into IDB workspace as a snapshot.
        uploadFiles(true);
        return null;
    }
    // Await directly — the user takes as long as they need to navigate the picker.
    try {
        fsaHandle = await showDirectoryPicker({
            mode: 'readwrite',
            id: 'freegent-workspace'
        });
    } catch (e) {
        if (e.name === 'AbortError') return null;
        console.warn('[FSA]', e.name, e.message);
        uploadFiles(true);  // fall back on any non-abort error
        return null;
    }
    pendingFsaHandle = null;
    await saveFsaHandle(fsaHandle);
    updateFsaBadge();
    await renderFileList();
    startFsaSync();
    maybeRunInitAgent?.().catch(() => {});
    generateAndShowSuggestion?.().catch(() => {});
    return fsaHandle;
}

function closeFsaFolder() {
    stopFsaSync();
    fsaHandle = null;
    pendingFsaHandle = null;
    clearFsaHandle();
    updateFsaBadge();
    renderFileList();
}

async function updateFsaBadge() {
    const badge   = document.getElementById('fsa-badge');
    const nameEl  = document.getElementById('fsa-name');
    if (!badge) return;
    if (fsaHandle) {
        if (nameEl) {
            // Try to get the full path (or best available name)
            try {
                const path = await getFullPath(fsaHandle);
                nameEl.textContent = path || 'Local Folder';
            } catch (e) {
                console.warn('[FSA] Could not get path:', e);
                nameEl.textContent = fsaHandle.name || 'Local Folder';
            }
        }
        badge.style.display = '';
        badge.title = 'Click to close';
        badge.onclick = () => {
            closeFsaFolder();
        };
    } else {
        badge.style.display = 'none';
    }
}

async function getFullPath(handle) {
    if (!handle) return null;
    try {
        const pathAttempts = [];

        if (handle.name) {
            pathAttempts.push(`name: ${handle.name}`);
        }

        try {
            if (typeof handle.resolve === 'function') {
                try {
                    if (navigator.storage && typeof navigator.storage.getDirectory === 'function') {
                        const storageRoot = await navigator.storage.getDirectory();
                        const relativePath = await handle.resolve(storageRoot);
                        if (relativePath && relativePath.length > 0) {
                            pathAttempts.push(`storage resolved: /${relativePath.join('/')}`);
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {}

        if (handle.webkitRelativePath) {
            pathAttempts.push(`webkit: ${handle.webkitRelativePath}`);
        }

        try {
            if (typeof handle.getParent === 'function') {
                const parent = await handle.getParent();
                if (parent && parent.name) {
                    pathAttempts.push(`parent: ${parent.name} > ${handle.name}`);
                }
            }
        } catch (e) {}

        try {
            if (navigator.storage && typeof navigator.storage.getDirectory === 'function') {
                const opfsRoot = await navigator.storage.getDirectory();
                if (handle.isSameEntry && (await handle.isSameEntry(opfsRoot))) {
                    pathAttempts.push('OPFS: Private Storage');
                }
            }
        } catch (e) {}

        if (pathAttempts.length > 0) {
            const best = pathAttempts.find(p => p.includes('resolved:') || p.includes('parent:')) || pathAttempts[0];
            return best.replace(/^[a-z]+:\s*/, '').trim();
        }

        return handle.name || 'Local Folder';
    } catch (e) {
        console.warn('[FSA] Error getting path:', e);
        return handle.name || 'Local Folder';
    }
}

const FSA_SKIP = new Set([
    'node_modules', '.git', '.svn', '.hg',
    'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.vite',
    '__pycache__', '.venv', 'venv', '.tox',
    '.npm', '.pnp', '.yarn',
    '.DS_Store',
]);

async function listFsaFiles(dirHandle = null, prefix = '', depth = 0) {
    const dir = dirHandle || fsaHandle;
    if (!dir) return [];
    const files = [];
    try {
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind === 'file') {
                files.push(prefix + name);
            } else if (handle.kind === 'directory' && depth < 4 && !FSA_SKIP.has(name)) {
                const sub = await listFsaFiles(handle, prefix + name + '/', depth + 1);
                if (sub.length) files.push(...sub);
                else files.push(prefix + name + '/'); // empty directory sentinel
            }
        }
    } catch (e) {
        console.error('[FSA] listFsaFiles:', e);
    }
    return files;
}

async function fsaNavigate(name, create = false) {
    const parts = name.split('/');
    let dir = fsaHandle;
    for (let i = 0; i < parts.length - 1; i++)
        dir = await dir.getDirectoryHandle(parts[i], { create });
    return { dir, filename: parts[parts.length - 1] };
}

async function readFsaFile(name, asBase64 = false) {
    if (!fsaHandle) throw new Error('No local folder is synced — "local/…" paths are unavailable. Use the plain workspace path without the "local/" prefix (e.g. "src/main.js").');
    const { dir, filename } = await fsaNavigate(name);
    const handle = await dir.getFileHandle(filename);
    const file   = await handle.getFile();
    if (asBase64) { const buf = await file.arrayBuffer(); return _uint8ToBase64(new Uint8Array(buf)); }
    return await file.text();
}

async function writeFsaFile(name, content) {
    if (!fsaHandle) throw new Error('No local folder is synced — "local/…" paths are unavailable. Use the plain workspace path without the "local/" prefix (e.g. "src/main.js").');
    const { dir, filename } = await fsaNavigate(name, true);
    const handle   = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
}

async function deleteFsaFile(name) {
    if (!fsaHandle) throw new Error('No local folder is synced — "local/…" paths are unavailable. Use the plain workspace path without the "local/" prefix (e.g. "src/main.js").');
    const { dir, filename } = await fsaNavigate(name);
    await dir.removeEntry(filename);
}


export function setWorkspaceAdapter(a: WorkspaceAdapter | null) { _wa = a; }

// Whether a local folder is synced via the File System Access API this session —
// the system prompt branches its workspace description on this ("local/" paths
// only exist when true).
// Set to true when files are imported via uploadFiles(folder, asLocal=true).
// Allows hasLocalFolder() to return true for imported snapshots within the session.
let _hasImportedLocal = false;

export function hasLocalFolder(): boolean { return !!fsaHandle || _hasImportedLocal; }

export async function agentListFiles() {
    if (_wa) return _wa.agentListFiles();
    const wsFiles  = await listWorkspaceFilesMetaOnly();
    const fsaNames = fsaHandle ? (await listFsaFiles()).filter(n => !n.endsWith('/')) : [];
    return [
        // IDB files without local/ prefix → shown in Workspace column
        ...wsFiles.filter(f => !f.name.startsWith('local/')).map(f => ({ name: f.name, size: f.size, lastModified: f.lastModified })),
        // IDB files with local/ prefix (imported snapshot) → shown in Local Folder column when no FSA
        ...(!fsaHandle ? wsFiles.filter(f => f.name.startsWith('local/')).map(f => ({ name: f.name, size: f.size, lastModified: f.lastModified, isLocal: true })) : []),
        // Live-synced FSA files → shown in Local Folder column
        ...fsaNames.map(n => ({ name: 'local/' + n, isLocal: true })),
    ];
}

/** Delete all IDB files under local/ (clears an imported snapshot). */
async function clearImportedLocalFiles() {
    const wsFiles = await listWorkspaceFilesMetaOnly();
    await Promise.all(wsFiles.filter(f => f.name.startsWith('local/')).map(f => deleteWorkspaceFile(f.name)));
    _hasImportedLocal = false;
    await renderFileList();
}

/** Fast subdirectory scan — skips stat() and walks only the given dir.
 *  Returned names are relative to `dir` (e.g. "name/SKILL.md").
 *  Falls back to filtering the full agentListFiles() result if the adapter
 *  doesn't implement the method (browser / IDB path).
 */
export async function agentListFilesInDir(dir: string): Promise<Array<{name: string}>> {
    if (_wa?.agentListFilesInDir) return _wa.agentListFilesInDir(dir);
    // Browser fallback: filter the full list (slower, but correct)
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    const all = await agentListFiles();
    return all
        .filter(f => f.name.startsWith(prefix))
        .map(f => ({ name: f.name.slice(prefix.length) }));
}

/** Full workspace walk without stat() calls and with standard exclusions
 *  (node_modules, .git, dist, build, …).  Used by collectWorkspacePaths() for
 *  skill-trigger matching: 2–10× faster than agentListFiles() on slow/mounted
 *  filesystems because it skips one stat() syscall per file, while still
 *  excluding the large generated directories that agentListFilesInDir('') misses.
 *  Falls back to agentListFiles() on adapters that don't implement the method.
 */
export async function agentListFilesNoStat(): Promise<Array<{name: string}>> {
    if ((_wa as any)?.agentListFilesNoStat) return ((_wa as any).agentListFilesNoStat() as Promise<Array<{name: string}>>);
    // Fallback: agentListFiles() already applies exclusions; strip size/lastModified.
    return (await agentListFiles()).map(f => ({ name: f.name }));
}

// Read a file as a data URI — for image preview. FSA binary files are read via FileReader;
// IDB files may store binary content as raw base64 (encoding 'base64'), which is wrapped
// into a data URI with the extension's MIME type.
async function readFileAsDataUrl(path) {
    if (path.startsWith('local/')) {
        if (fsaHandle) {
            const { dir, filename } = await fsaNavigate(path.slice('local/'.length));
            const handle = await dir.getFileHandle(filename);
            const file   = await handle.getFile();
            return new Promise<any>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload  = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('FileReader error'));
                reader.readAsDataURL(file);
            });
        }
        // Imported snapshot (no live FSA handle) — the file lives in IDB under local/.
        const rec = await readWorkspaceFile(path);
        if (rec?.encoding === 'base64') return `data:${_mimeOf(path)};base64,${rec.content}`;
        if (rec?.content?.startsWith('data:')) return rec.content;
        throw new Error('No local folder is synced — "local/…" paths are unavailable. Use the plain workspace path without the "local/" prefix (e.g. "src/main.js").');
    }
    const rec = await readWorkspaceFile(path);
    if (rec?.content?.startsWith('data:')) return rec.content;
    if (rec?.encoding === 'base64') return `data:${_mimeOf(path)};base64,${rec.content}`;
    throw new Error('File content is not a data URI');
}
export async function agentReadFile(path) {
    if (_wa) return _wa.agentReadFile(path);
    const _fsaRead = async (name) => {
        if (_isDocExt(name)) {
            const b64 = await readFsaFile(name, true);
            return await _extractDocText(name, b64);
        }
        return await readFsaFile(name);
    };
    if (path.startsWith('local/')) {
        try { return await _fsaRead(path.slice(6)); } catch {}
        const rec = await readWorkspaceFile(path);
        if (rec) return rec.encoding === 'base64' ? await _extractDocText(path, rec.content) : rec.content;
        throw new Error(`File not found: ${path}`);
    }
    const rec = await readWorkspaceFile(path);
    if (rec) {
        if (rec.encoding === 'base64') return await _extractDocText(path, rec.content);
        return rec.content;
    }
    try { return await _fsaRead(path); } catch {}
    throw new Error(`File not found: ${path}`);
}

export async function agentWriteFile(path, content, encoding = null) {
    if (_wa) return _wa.agentWriteFile(path, content, encoding);
    if (path.startsWith('local/')) {
        if (fsaHandle) {
            await writeFsaFile(path.slice(6), content); // binary to FSA not yet supported
        } else {
            // No FSA — write back to IDB (imported snapshot; no write-back to filesystem)
            await writeWorkspaceFile(path, content, null, encoding);
        }
    } else {
        // Always mirror to IDB so listWorkspaceFiles() stays current for the Pyodide
        // worker's next call. Without this, files that exist in an FSA-synced folder get
        // written to FSA only (wroteToFsa=true skips IDB), leaving IDB stale. The Pyodide
        // worker's migration loop then re-reads IDB on the next execute_code call and
        // overwrites the correctly-persisted IDBFS content with the stale IDB version —
        // making Python-written files disappear between calls.
        if (fsaHandle) {
            try { await readFsaFile(path); await writeFsaFile(path, content); } catch {}
        }
        await writeWorkspaceFile(path, content, null, encoding);
    }
    await renderFileList();
    if (path === 'AGENTS.md')       loadAgentsContext?.();
    if (path.startsWith('roles/'))  loadRoles?.();
    if (path.startsWith('skills/') || path.startsWith('rules/')) loadSkills?.();
    // Keep the Kanban board in sync when the AI writes a task file directly.
    // The FSA sync loop handles live-synced folders; IDB writes (no FSA) need this call.
    if (path.startsWith('fg-tasks/') || path.startsWith('tasks/') || path.startsWith('local/tasks/')) refreshTasks?.();
}

export async function agentDeleteFile(path) {
    if (_wa) return _wa.agentDeleteFile(path);
    if (path.startsWith('local/')) {
        try { await deleteFsaFile(path.slice('local/'.length)); }
        catch { await deleteWorkspaceFile(path); } // fall back for orphaned IDB local/ files
    } else {
        // Mirror agentReadFile: if bare name exists in FSA, delete there
        let deletedFromFsa = false;
        if (fsaHandle) {
            try { await deleteFsaFile(path); deletedFromFsa = true; } catch {}
        }
        if (!deletedFromFsa) await deleteWorkspaceFile(path);
    }
    await renderFileList();
    if (path.startsWith('skills/') || path.startsWith('rules/')) loadSkills?.();
}

/** Returns the file's last-modified timestamp (ms since epoch), or null if the file is not found.
 *  Cheap: IDB reads only the record metadata; FSA calls getFile(); Node delegates to stat(). */
export async function agentFileMtime(path: string): Promise<number | null> {
    if (_wa?.agentFileMtime) return _wa.agentFileMtime(path);
    const fsaName = path.startsWith('local/') ? path.slice('local/'.length) : path;
    // IDB path (non-local files stored in IndexedDB)
    if (!path.startsWith('local/')) {
        const rec = await readWorkspaceFile(path).catch(() => null);
        if (rec?.lastModified != null) return rec.lastModified;
    }
    // FSA path (local/ files, or IDB miss when FSA is active)
    if (fsaHandle) {
        try { return await getFsaMtime(fsaName); } catch {}
    }
    return null;
}


const collapsedDirs = new Set(); // full paths like 'local/tasks' that are collapsed
const selectedFiles = new Set<string>();
let _idbClickAnchorName: string | null = null;
let _localClickAnchorName: string | null = null;
let _draggedFiles: string[] = [];

function updateSelectionUI() {
    document.querySelectorAll('.workspace-file-row[data-filename]').forEach(row => {
        row.classList.toggle('ws-selected', selectedFiles.has((row as HTMLElement).dataset.filename));
    });
    const bar = document.getElementById('ws-selection-bar');
    if (!bar) return;
    const active = selectedFiles.size > 0;
    bar.classList.toggle('active', active);
    if (active) {
        bar.querySelector('.ws-sel-count').textContent =
            `${selectedFiles.size} file${selectedFiles.size !== 1 ? 's' : ''} selected`;
        const hasDeletable = [...selectedFiles].some(n => !n.startsWith('local/'));
        (bar.querySelector('.ws-sel-btn-del') as HTMLElement).style.display = hasDeletable ? '' : 'none';
    }
}

function _buildPyOutputHtml(filename, result) {
    const { stdout = '', stderr = '', exit_code = 0 } = result;
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const parts = [];
    if (stdout) {
        const lines = stdout.split('\n').map(line => {
            const m = line.match(/^\[IMAGE:(.+)\]$/);
            if (m) {
                const img = _pyodideImageStore?.[m[1]];
                if (img && typeof img === 'string') return `<img src="${esc(img)}" style="max-width:100%;margin:6px 0;display:block;">`;
                if (img?.type === 'svg') return `<div style="margin:6px 0;">${img.content}</div>`;
            }
            return esc(line);
        });
        parts.push(`<pre class="out">${lines.join('\n')}</pre>`);
    }
    if (stderr) parts.push(`<pre class="err">${esc(stderr)}</pre>`);
    if (!stdout && !stderr) parts.push('<span class="empty">No output</span>');
    if (exit_code) parts.push(`<div class="exit">exit code ${exit_code}</div>`);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#1e1e1e;color:#d4d4d4;font:13px/1.5 monospace;padding:12px;}
.hdr{color:#888;font-size:11px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #333;}
pre{margin:0;white-space:pre-wrap;word-break:break-all;}
.err{color:#f48;}
.exit{color:#f48;font-size:11px;margin-top:8px;}
.empty{color:#666;font-style:italic;}
</style></head><body>
<div class="hdr">${esc(filename)}</div>${parts.join('\n')}
</body></html>`;
}

function _buildPyRunnerHtml(filename, code, files) {
    const sj = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

    // Split text vs binary files for Pyodide FS
    const textFiles = {}, binFiles = {};
    for (const [k, v] of Object.entries(files || {})) {
        if (v == null) continue;
        if (_isBinaryExt(k)) binFiles[k] = v;  // base64 string
        else textFiles[k] = v;
    }

    const workdirRel = filename.includes('/') ? filename.replace(/\/[^/]+$/, '') : '';
    const workDir = workdirRel ? '/workspace/' + workdirRel : '/workspace';

    const needsAgg = /\bimport\s+matplotlib\b|from\s+matplotlib\b/.test(code);
    const hasPygame = /^\s*(?:import|from)\s+pygame\b/m.test(code);
    let runCode = needsAgg ? 'import matplotlib\nmatplotlib.use("Agg")\n' + code : code;


    const imports = Array.from(new Set(
        (code.match(/^(?:import|from)\s+(\w+)/gm) || [])
            .map(m => m.replace(/^(?:import|from)\s+/, '').split(/\s/)[0])
    ));

    // Pre-compute Python snippets that reference workDir (so the inner iframe JS is constant-only)
    const sysPathPy = `import sys\nfor _p in ['/workspace', '${workDir}']:\n    if _p not in sys.path: sys.path.insert(0, _p)\n`;
    const localCheckPy = `import sys, importlib.util, os\ndef _il(n):\n    for b in ['/workspace', '${workDir}']:\n        if os.path.exists(b+'/'+n+'.py') or os.path.isdir(b+'/'+n): return True\n    return False\n[m for m in ${JSON.stringify(imports)} if importlib.util.find_spec(m) is None and not _il(m)]\n`;
    const chdirPy = `import os\nos.chdir('${workDir}')\n`;

    const fnEsc = filename.replace(/[<>&]/g, c => c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${fnEsc}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#1e1e1e;color:#d4d4d4;font:13px/1.5 monospace}
body{display:flex;flex-direction:column}
#_st{padding:5px 12px;background:#252526;border-bottom:1px solid #333;color:#888;font-size:11px;flex-shrink:0}
#_cv{${hasPygame ? '' : 'display:none;'}background:#000;flex-shrink:0;text-align:center;position:relative}
canvas{max-width:100%;display:block;margin:auto}
#_op{flex:1;overflow-y:auto;padding:12px}
pre{margin:0;white-space:pre-wrap;word-break:break-all}
.err{color:#f48}.exit{color:#f48;font-size:11px;margin-top:8px}.empty{color:#555;font-style:italic}
</style>
</head>
<body>
<div id="_st">Loading Pyodide…</div>
<div id="_cv"><canvas id="canvas"></canvas></div>
<div id="_op"></div>
<script src="https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.js"></script>
<script>
const _FN=${sj(filename)},_CODE=${sj(runCode)},_FILES=${sj(textFiles)},_BIN=${sj(binFiles)},_IMP=${sj(imports)},_SYS=${sj(sysPathPy)},_CHK=${sj(localCheckPy)},_CD=${sj(chdirPy)},_PYGAME=${sj(hasPygame)};
const _st=document.getElementById('_st'),_op=document.getElementById('_op');
function ss(s){_st.textContent=s;window.parent.postMessage({type:'fg-dbg',msg:'[status] '+s},'*')}
function ap(t,c){const p=document.createElement('pre');if(c)p.className=c;p.textContent=t;_op.appendChild(p);_op.scrollTop=_op.scrollHeight;window.parent.postMessage({type:'fg-dbg',msg:(c?'['+c+'] ':'')+t},'*')}
window.onerror=(msg,src,line,col,err)=>{ap('[uncaught] '+msg+' ('+src+':'+line+')','err')};
window.onunhandledrejection=e=>{ap('[unhandled promise] '+(e.reason?.message||String(e.reason)),'err')};
// Web Audio sound player — called by the Python pygame.mixer.Sound shim
window._fgPlayRaw=function(data,rate,ch){
  try{
    if(!window._fgAudioCtx)window._fgAudioCtx=new AudioContext();
    const ctx=window._fgAudioCtx;
    // Decode PCM: Pyodide passes Python bytes as Uint8Array
    let raw;
    if(data instanceof Uint8Array)raw=data;
    else if(ArrayBuffer.isView(data))raw=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
    else{try{const j=data.toJs?.();raw=j instanceof Uint8Array?j:null;}catch(_){raw=null;}if(!raw)return;}
    const n=Math.floor(raw.length/2/ch);
    if(n<=0)return;
    const buf=ctx.createBuffer(ch,n,rate);
    const dv=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    for(let c=0;c<ch;c++){const out=buf.getChannelData(c);for(let i=0;i<n;i++)out[i]=dv.getInt16((i*ch+c)*2,true)/32768;}
    const play=()=>{const src=ctx.createBufferSource();src.buffer=buf;src.connect(ctx.destination);src.start();};
    ctx.state==='suspended'?ctx.resume().then(play):play();
  }catch(_){}
};
(async()=>{try{
ss('Loading Pyodide…');
const py=await loadPyodide({indexURL:'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/'});
ss('Initializing…');
await py.loadPackage('micropip');
py.FS.mkdirTree('/workspace');
for(const[n,c]of Object.entries(_FILES)){if(c==null)continue;const p='/workspace/'+n,d=p.slice(0,p.lastIndexOf('/'));if(d&&d!=='/workspace')py.FS.mkdirTree(d);py.FS.writeFile(p,c)}
for(const[n,b64]of Object.entries(_BIN)){if(!b64)continue;const p='/workspace/'+n,d=p.slice(0,p.lastIndexOf('/'));if(d&&d!=='/workspace')py.FS.mkdirTree(d);const _s=b64.replace(/=/g,''),_pd=(4-_s.length%4)%4,s=atob(_s+'='.repeat(_pd)),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);py.FS.writeFile(p,u);}
await py.runPythonAsync(_SYS);
const _cv=document.getElementById('canvas');
try{py._module.canvas=_cv}catch{}
ss('Loading packages…');
try{await py.loadPackagesFromImports(_CODE,{messageCallback:s=>ss(s)})}catch(e){ap('Warning: '+e.message,'err')}
if(!_PYGAME&&_IMP.length){const miss=await py.runPythonAsync(_CHK);const ti=miss?.toJs?miss.toJs():[];if(ti.length){ss('Installing '+ti.join(', ')+'…');try{await py.runPythonAsync('import micropip; await micropip.install('+JSON.stringify(ti)+')')}catch(e){ap('Warning: could not install '+ti.join(', ')+': '+e.message,'err')}}}
let hadOut=false;
py.setStdout({batched:s=>{hadOut=true;ap(s,'')}});py.setStderr({batched:s=>{hadOut=true;ap(s,'err')}});
if(_PYGAME){
// Resume AudioContext on first user gesture (click or key) so sounds work
// without requiring an explicit "click to start" overlay.
const _resumeAudio=()=>{
  try{if(!window._fgAudioCtx)window._fgAudioCtx=new AudioContext();window._fgAudioCtx.resume();}catch(_){}
};
document.addEventListener('click',_resumeAudio,{once:true});
document.addEventListener('keydown',_resumeAudio,{once:true});
// Remove the overlay immediately so the game starts straight away
const _ov=document.getElementById('_ov');
if(_ov)_ov.remove();
}
ss('Running '+_FN+'…');
let ec=0;
if(_PYGAME){
py.globals.set('_FG_SRC',_CD+_CODE);py.globals.set('_FG_FN',_FN);
py.globals.set('_fg_sleep',()=>new Promise(r=>requestAnimationFrame(r)));
try{await py.runPythonAsync(\`import ast,asyncio as _aio
class _P(ast.NodeTransformer):
 def visit_While(self,n):
  self.generic_visit(n)
  sl=ast.parse('await _fg_sleep()').body[0];ast.fix_missing_locations(sl)
  n.body=[sl]+n.body;return n
def _oa(n,d=0):
 if isinstance(n,ast.Await):return True
 if d and isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):return False
 return any(_oa(c,d+1)for c in ast.iter_child_nodes(n))
class _A(ast.NodeTransformer):
 def __init__(self):self.af=set()
 def visit_FunctionDef(self,n):
  self.generic_visit(n)
  if _oa(n):
   self.af.add(n.name)
   r=ast.AsyncFunctionDef(name=n.name,args=n.args,body=n.body,decorator_list=n.decorator_list,returns=getattr(n,'returns',None),lineno=n.lineno,col_offset=n.col_offset,end_lineno=getattr(n,'end_lineno',n.lineno),end_col_offset=getattr(n,'end_col_offset',n.col_offset))
   ast.fix_missing_locations(r);return r
  return n
class _W(ast.NodeTransformer):
 def __init__(self,af):self.af=af;self._d=0
 def visit_FunctionDef(self,n):
  self._d+=1;self.generic_visit(n);self._d-=1;return n
 visit_AsyncFunctionDef=visit_FunctionDef
 def visit_ClassDef(self,n):
  self._d+=1;self.generic_visit(n);self._d-=1;return n
 def visit_Expr(self,n):
  if isinstance(n.value,ast.Call)and not isinstance(n.value,ast.Await):
   f=n.value.func
   ok=(isinstance(f,ast.Name)and f.id in self.af)or(isinstance(f,ast.Attribute)and f.attr in self.af and self._d==0)
   if ok:n.value=ast.Await(value=n.value);ast.fix_missing_locations(n)
  return n
async def _go():
 t=ast.parse(_FG_SRC)
 t=_P().visit(t)
 for _ in range(5):
  a=_A();t=a.visit(t)
  if not a.af:break
  t=_W(a.af).visit(t)
 import os as _os;_os.environ['SDL_AUDIODRIVER']='dummy'
 try:
  import pygame as _pg,js as _js,math as _ma,array as _ar
  try:_pg.time.Clock.tick=lambda self,*a:16;_pg.time.Clock.tick_busy_loop=lambda self,*a:16
  except:pass
  _fgI=[False];_fgOM=_pg.mixer.init
  def _fgMI(*a,**kw):
   try:_fgOM(*a,**kw)
   except:pass
   _fgI[0]=True
  _pg.mixer.init=_fgMI
  _pg.mixer.get_init=lambda:(44100,-16,2)if _fgI[0] else None
  def _fgTone(f,d,v=.4,rel=.05):
   n=int(44100*d);rl=max(1,int(44100*rel));ph=0.;s=[]
   for i in range(n):
    ph+=6.2832*f/44100;s.append(_ma.sin(ph)*(min(1.,(n-i)/rl)if i>n-rl else 1.)*v*32767)
   return s
  def _fgSweep(f0,f1,d,v=.4):
   n=int(44100*d);rl=max(1,int(44100*.04));ph=0.;s=[]
   for i in range(n):
    ph+=6.2832*(f0+(f1-f0)*i/n)/44100;s.append(_ma.sin(ph)*(min(1.,(n-i)/rl)if i>n-rl else 1.)*v*32767)
   return s
  def _fgBuf(samples):
   return _ar.array('h',[max(-32768,min(32767,int(s)))for s in samples for _ in range(2)]).tobytes()
  _fgPats=[
   ('jump',lambda:_fgSweep(300,900,.18)),
   ('click',lambda:_fgTone(1000,.06,.35,.02)),('button',lambda:_fgTone(1000,.06,.35,.02)),
   ('colli',lambda:_fgSweep(600,150,.2,.5)),('hit',lambda:_fgSweep(600,150,.15,.5)),
   ('hurt',lambda:_fgSweep(600,150,.15,.5)),('die',lambda:_fgSweep(400,100,.25,.5)),
   ('over',lambda:_fgTone(440,.2)+_fgTone(330,.2)+_fgTone(220,.35)),
   ('compl',lambda:_fgTone(523,.12)+_fgTone(659,.12)+_fgTone(784,.12)+_fgTone(1047,.18)),
   ('win',lambda:_fgTone(523,.12)+_fgTone(659,.12)+_fgTone(784,.12)+_fgTone(1047,.18)),
   ('coin',lambda:_fgTone(880,.1,.3,.03)),('collect',lambda:_fgTone(880,.1,.3,.03)),
   ('shoot',lambda:_fgSweep(800,400,.1,.3)),('explod',lambda:_fgSweep(300,50,.3,.5)),
  ]
  class _FGSnd:
   def __init__(self,*a,**kw):
    self._d=b'';b=kw.get('buffer',a[0] if a else None)
    if isinstance(b,(bytes,bytearray)):self._d=bytes(b)
    elif hasattr(b,'tobytes'):self._d=b.tobytes()
    elif isinstance(b,str):
     import os as _o;k=_o.path.splitext(_o.path.basename(b))[0].lower()
     fn=next((v for p,v in _fgPats if p in k),lambda:_fgTone(440,.08))
     self._d=_fgBuf(fn())
   def play(self,*a,**kw):
    try:
     from pyodide.ffi import to_js as _tjs
     _js._fgPlayRaw(_tjs(self._d),44100,2)
    except:pass
   def stop(self):pass
   def fadeout(self,t):pass
   def get_length(self):return 0.
   def get_volume(self):return 1.
   def set_volume(self,v):pass
  _pg.mixer.Sound=_FGSnd
 except:pass
 ast.fix_missing_locations(t)
 g={'__name__':'__main__','asyncio':_aio,'_fg_sleep':_fg_sleep}
 r=eval(compile(t,_FG_FN,'exec',ast.PyCF_ALLOW_TOP_LEVEL_AWAIT),g)
 if _aio.iscoroutine(r):
  try:await r
  except SystemExit:pass
await _go()\`)}catch(e){const _m=e.message||String(e);if(!_m.includes('SystemExit')){hadOut=true;ap(_m,'err');ec=1}}
}else{
try{await py.runPythonAsync(_CD+_CODE)}catch(e){hadOut=true;ap(e.message||String(e),'err');ec=1}
}
ss(ec?'Error (exit '+ec+')':_FN);
if(!hadOut)ap('No output','empty');
if(ec){const d=document.createElement('div');d.className='exit';d.textContent='exit code '+ec;_op.appendChild(d)}
}catch(e){ss('Fatal error');ap(String(e),'err')}})();
</script>
</body>
</html>`;
}

async function downloadSelected() {
    for (const name of selectedFiles) {
        try { await downloadFile(name); } catch (e) { console.error('[workspace] download error:', name, e); }
    }
}

async function deleteSelected() {
    const deletable = [...selectedFiles];
    if (!deletable.length) return;
    for (const name of deletable) {
        try {
            if (name.startsWith('local/')) {
                try { await deleteFsaFile(name.slice('local/'.length)); }
                catch { await deleteWorkspaceFile(name); }
            } else {
                await deleteWorkspaceFile(name);
            }
            selectedFiles.delete(name);
        } catch {}
    }
    await renderFileList();
}


function makeDraggable(row, fullname) {
    // HTML5 drag events only on fine-pointer (mouse/trackpad) devices.
    // On Android/touch, setting draggable=true causes Chrome to fire touchcancel
    // when it takes over with its own drag UI, which immediately tears down our
    // touchmove listener before the gesture can activate.
    if (window.matchMedia('(pointer: fine)').matches) {
        row.draggable = true;
        row.addEventListener('dragstart', e => {
            _draggedFiles = (selectedFiles.has(fullname) && selectedFiles.size > 1)
                ? [...selectedFiles]
                : [fullname];
            e.dataTransfer.effectAllowed = 'copyMove';
            e.dataTransfer.setData('text/x-freegent-files', JSON.stringify(_draggedFiles));
            setTimeout(() => {
                document.querySelectorAll('.workspace-file-row[data-filename]').forEach(r => {
                    if (_draggedFiles.includes((r as HTMLElement).dataset.filename)) r.classList.add('ws-dragging');
                });
            }, 0);
        });
        row.addEventListener('dragend', () => {
            document.querySelectorAll('.ws-dragging').forEach(r => r.classList.remove('ws-dragging'));
            _draggedFiles = [];
        });
    }

    // ── Touch drag-and-drop (mobile) ────────────────────────────────────────
    // touchmove/touchend go on document so Chrome's scroll compositor can't
    // intercept them. preventDefault() fires on every move (not just after a
    // threshold) because Chrome commits to scroll before the threshold fires.
    row.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        const t0 = e.touches[0];
        const startX = t0.clientX, startY = t0.clientY;
        let dragActive = false;
        let ghost: HTMLElement | null = null;
        let lastTarget: HTMLElement | null = null;

        _draggedFiles = (selectedFiles.has(fullname) && selectedFiles.size > 1)
            ? [...selectedFiles] : [fullname];

        // Snapshot drop-zone rects NOW (stable layout, no ghost yet).
        // We use rect-based hit testing instead of elementFromPoint because
        // the ghost element (fixed, z-index 9999) blocks elementFromPoint on
        // Android Chrome even when pointer-events:none is set.
        type Zone = { el: HTMLElement; rect: DOMRect; isTrash: boolean };
        const zones: Zone[] = [];
        document.querySelectorAll<HTMLElement>('.ws-trash-zone, .workspace-col-body').forEach(el => {
            zones.push({ el, rect: el.getBoundingClientRect(), isTrash: el.classList.contains('ws-trash-zone') });
        });
        // Also capture full column rects as a fallback (finger on header/gap).
        type ColZone = { col: HTMLElement; body: HTMLElement | null; rect: DOMRect };
        const colZones: ColZone[] = [];
        document.querySelectorAll<HTMLElement>('.workspace-col').forEach(col => {
            colZones.push({ col, body: col.querySelector('.workspace-col-body'), rect: col.getBoundingClientRect() });
        });

        const inRect = (r: DOMRect, x: number, y: number) =>
            x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

        const findTarget = (x: number, y: number): HTMLElement | null => {
            // Trash zones first (they sit outside the col-body, so order matters).
            for (const z of zones) if (z.isTrash  && inRect(z.rect, x, y)) return z.el;
            for (const z of zones) if (!z.isTrash && inRect(z.rect, x, y)) return z.el;
            // Fallback: anywhere in the column (header, border) → use its body.
            for (const cz of colZones) if (inRect(cz.rect, x, y)) return cz.body;
            return null;
        };

        const updateHighlight = (target: HTMLElement | null) => {
            document.querySelectorAll('.workspace-col.drag-over').forEach(c => c.classList.remove('drag-over'));
            document.querySelectorAll('.ws-trash-zone.drag-over').forEach(c => c.classList.remove('drag-over'));
            if (!target) return;
            if (target.classList.contains('ws-trash-zone'))
                target.classList.add('drag-over');
            else
                target.closest('.workspace-col')?.classList.add('drag-over');
        };

        const teardown = () => {
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend',   onEnd);
            document.removeEventListener('touchcancel', onEnd);
            document.querySelectorAll('.ws-dragging').forEach(r => r.classList.remove('ws-dragging'));
            updateHighlight(null);
            if (ghost) { ghost.remove(); ghost = null; }
        };

        const onMove = (ev: TouchEvent) => {
            ev.preventDefault();
            if (ev.touches.length !== 1) { teardown(); return; }
            const t = ev.touches[0];
            const dx = t.clientX - startX, dy = t.clientY - startY;

            if (!dragActive) {
                if (Math.hypot(dx, dy) < 8) return;
                dragActive = true;
                document.querySelectorAll('.workspace-file-row[data-filename]').forEach(r => {
                    if (_draggedFiles.includes((r as HTMLElement).dataset.filename))
                        r.classList.add('ws-dragging');
                });
                ghost = document.createElement('div');
                ghost.className = 'ws-touch-ghost';
                ghost.textContent = _draggedFiles.length === 1
                    ? (_draggedFiles[0].split('/').pop() ?? _draggedFiles[0])
                    : `${_draggedFiles.length} files`;
                document.body.appendChild(ghost);
            }

            if (ghost) { ghost.style.left = t.clientX + 12 + 'px'; ghost.style.top = t.clientY - 28 + 'px'; }

            lastTarget = findTarget(t.clientX, t.clientY);
            updateHighlight(lastTarget);
        };

        const onEnd = async (ev: TouchEvent) => {
            // Use changedTouches for the true lift position — touchmove may not
            // have fired at the exact final coordinate.
            if (dragActive && ev.changedTouches?.length) {
                const ft = ev.changedTouches[0];
                lastTarget = findTarget(ft.clientX, ft.clientY) ?? lastTarget;
            }
            const wasDragging = dragActive;
            const target = lastTarget;
            const names  = [..._draggedFiles];
            teardown();
            _draggedFiles = [];
            if (!wasDragging || !names.length || !target) return;

            if (target.classList.contains('ws-trash-zone')) {
                for (const n of names) {
                    try {
                        if (n.startsWith('local/')) {
                            try { await deleteFsaFile(n.slice('local/'.length)); }
                            catch { await deleteWorkspaceFile(n); }
                        } else {
                            await deleteWorkspaceFile(n);
                        }
                        selectedFiles.delete(n);
                    } catch (err) { console.error('[workspace] touch delete failed:', n, err); }
                }
                updateSelectionUI();
                await renderFileList();
                return;
            }

            const acceptsLocal = target.dataset.dropZoneAcceptsLocal === '1';
            for (const srcName of names) {
                const isLocal = srcName.startsWith('local/');
                if (acceptsLocal !== isLocal) continue;
                try { await copyFileBetween(srcName); }
                catch (err) { console.error('[workspace] touch DnD failed:', srcName, err); }
            }
            await renderFileList();
        };

        document.addEventListener('touchmove',   onMove,  { passive: false });
        document.addEventListener('touchend',    onEnd,   { once: true });
        document.addEventListener('touchcancel', onEnd,   { once: true });
    });
}

function setupDropZone(bodyEl, acceptLocalFiles) {
    bodyEl.dataset.dropZoneAcceptsLocal = acceptLocalFiles ? '1' : '0';
    let dragCount = 0;
    const col = () => bodyEl.closest('.workspace-col');
    const hasFwFiles = e => e.dataTransfer.types.includes('text/x-freegent-files');

    bodyEl.addEventListener('dragover', e => {
        if (!hasFwFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
    });
    bodyEl.addEventListener('dragenter', e => {
        if (!hasFwFiles(e)) return;
        dragCount++;
        col()?.classList.add('drag-over');
    });
    bodyEl.addEventListener('dragleave', () => {
        if (--dragCount <= 0) { dragCount = 0; col()?.classList.remove('drag-over'); }
    });
        bodyEl.addEventListener('drop', async e => {
        e.preventDefault();
        dragCount = 0;
        col()?.classList.remove('drag-over');
        let names: string[];
        try { names = JSON.parse(e.dataTransfer.getData('text/x-freegent-files') || '[]'); } catch { return; }
        if (!names.length) return;
        const isMove = e.shiftKey;
        const toDelete = [];
        for (const srcName of names) {
            const isLocal = srcName.startsWith('local/');
            if (acceptLocalFiles !== isLocal) continue; // wrong direction
            try {
                await copyFileBetween(srcName);
                if (isMove && !isLocal) toDelete.push(srcName); // only IDB files can be deleted
            } catch (err) {
                console.error('[workspace] DnD failed:', srcName, err);
            }
        }
        for (const n of toDelete) {
            try { await deleteWorkspaceFile(n); selectedFiles.delete(n); } catch {}
        }
        if (toDelete.length) { updateSelectionUI(); await renderFileList(); }
    });
}

let _rbEl: HTMLElement | null = null;

function setupRubberBand(bodyEl) {
    bodyEl.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest('.workspace-file-row, .workspace-dir-row, .workspace-file-actions')) return;
        e.preventDefault();

        if (!e.shiftKey) { selectedFiles.clear(); updateSelectionUI(); }

        const startX = e.clientX, startY = e.clientY;

        if (!_rbEl) {
            _rbEl = document.createElement('div');
            _rbEl.className = 'ws-rubber-band';
            document.body.appendChild(_rbEl);
        }
        Object.assign(_rbEl.style, { display: 'block', left: startX + 'px', top: startY + 'px', width: '0', height: '0' });

        const rows = [...bodyEl.querySelectorAll('.workspace-file-row[data-filename]')]
            .map(el => ({ el, name: el.dataset.filename }));
        const initial = new Set(selectedFiles);

        const onMove = e => {
            const x1 = Math.min(e.clientX, startX), y1 = Math.min(e.clientY, startY);
            const x2 = Math.max(e.clientX, startX), y2 = Math.max(e.clientY, startY);
            Object.assign(_rbEl.style, { left: x1 + 'px', top: y1 + 'px', width: (x2 - x1) + 'px', height: (y2 - y1) + 'px' });
            if (!e.shiftKey) selectedFiles.clear();
            else for (const n of initial) selectedFiles.add(n);
            for (const { el, name } of rows) {
                const r = el.getBoundingClientRect();
                if (r.right >= x1 && r.left <= x2 && r.bottom >= y1 && r.top <= y2)
                    selectedFiles.add(name);
            }
            updateSelectionUI();
        };

        const onUp = () => {
            _rbEl.style.display = 'none';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function setupTrashZone(el) {
    const hasFwFiles = e => e.dataTransfer.types.includes('text/x-freegent-files');
    el.addEventListener('dragover', e => {
        if (!hasFwFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('dragenter', e => { if (hasFwFiles(e)) el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async e => {
        e.preventDefault();
        el.classList.remove('drag-over');
        let names: string[];
        try { names = JSON.parse(e.dataTransfer.getData('text/x-freegent-files') || '[]'); } catch { return; }
        const deletable = names;
        if (!deletable.length) return;
        for (const n of deletable) {
            try {
                if (n.startsWith('local/')) {
                    try { await deleteFsaFile(n.slice('local/'.length)); }
                    catch { await deleteWorkspaceFile(n); }
                } else {
                    await deleteWorkspaceFile(n);
                }
                selectedFiles.delete(n);
            } catch {}
        }
        updateSelectionUI();
        await renderFileList();
    });
}

async function copyFileBetween(srcName) {
    if (srcName.startsWith('local/')) {
        // local → IDB: preserve binary as base64
        const name = srcName.slice('local/'.length);
        if (fsaHandle) {
            if (_isBinaryExt(name)) {
                const b64 = await readFsaFile(name, true);
                await writeWorkspaceFile(name, b64, null, 'base64');
            } else {
                await writeWorkspaceFile(name, await readFsaFile(name));
            }
        } else {
            // Imported snapshot (no FSA): local/ files live in IDB.
            const rec = await readWorkspaceFile(srcName);
            if (!rec) throw new Error(`File not found: ${srcName}`);
            await writeWorkspaceFile(name, rec.content, null, rec.encoding);
        }
    } else {
        // IDB → local: write raw bytes for binary, text for text
        const rec = await readWorkspaceFile(srcName);
        if (!rec) throw new Error(`File not found: ${srcName}`);
        if (fsaHandle) {
            if (rec.encoding === 'base64') {
                await writeFsaFile(srcName, _base64ToUint8(rec.content));
            } else {
                await writeFsaFile(srcName, rec.content);
            }
        } else {
            // Imported snapshot (no FSA): store the copy under local/ in IDB.
            await writeWorkspaceFile('local/' + srcName, rec.content, null, rec.encoding);
            _hasImportedLocal = true;
        }
    }
}

function _fmtFileSize(bytes) {
    if (bytes == null) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function _hideFileTooltip() {
    const tip = document.getElementById('ws-file-tooltip');
    if (tip) tip.style.display = 'none';
}

let _tooltipDismissalInstalled = false;
function _installTooltipDismissal() {
    if (_tooltipDismissalInstalled) return;
    _tooltipDismissalInstalled = true;
    // Safety net for hybrid touch+pen devices (still match pointer:fine):
    // a touch tap or a backgrounded tab must never leave the tooltip stuck open.
    document.addEventListener('touchstart', _hideFileTooltip, { passive: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) _hideFileTooltip(); });
}

function _attachFileTooltip(row, info) {
    // Hover tooltips are a fine-pointer (mouse/trackpad) interaction. On touch a
    // tap synthesizes mouseenter but never mouseleave, so the tooltip would open
    // and stay stuck on screen (even across browser-tab switches). Same pointer
    // gate as makeDraggable().
    if (!window.matchMedia('(pointer: fine)').matches) return;
    _installTooltipDismissal();

    let tip: HTMLElement | null = null;
    const show = e => {
        if (!tip) {
            tip = document.getElementById('ws-file-tooltip');
            if (!tip) {
                tip = document.createElement('div');
                tip.id = 'ws-file-tooltip';
                tip.className = 'ws-file-tooltip';
                document.body.appendChild(tip);
            }
        }
        const lines = [`<b>${_esc(info.name)}</b>`];
        if (info.size != null) lines.push(`Size: ${_fmtFileSize(info.size)}`);
        if (info.lastModified) lines.push(`Modified: ${new Date(info.lastModified).toLocaleString()}`);
        tip.innerHTML = lines.join('<br>');
        tip.style.display = 'block';
        _posFileTooltip(tip, e);
    };
    row.addEventListener('mouseenter', show);
    row.addEventListener('mousemove', e => { if (tip?.style.display !== 'none') _posFileTooltip(tip, e); });
    row.addEventListener('mouseleave', _hideFileTooltip);
}

function _posFileTooltip(tip, e) {
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const w = tip.offsetWidth || 220, h = tip.offsetHeight || 60;
    if (x + w > window.innerWidth - 8)  x = e.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
    tip.style.left = x + 'px';
    tip.style.top  = y + 'px';
}

// Recursively collect every file name from a tree node (local or IDB).
function _collectNodeFiles(node): string[] {
    const out: string[] = [];
    for (const subtree of node.dirs.values()) out.push(..._collectNodeFiles(subtree));
    for (const f of node.files) out.push(f.name);
    return out;
}

// Augment a directory row with a copy-to-other-side button and drag support.
// `subtree`   – the tree node for this directory (used to enumerate its files)
// `copyLabel` – tooltip text; drives the button glyph (→ for workspace, ← for local)
function _makeDirRow(dirRow: HTMLElement, subtree: any, copyLabel: string): void {
    const glyph = copyLabel.toLowerCase().includes('workspace') ? '→' : '←';

    const actions = document.createElement('div');
    actions.className = 'workspace-dir-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'ws-btn';
    copyBtn.title = copyLabel;
    copyBtn.textContent = glyph;
    copyBtn.onclick = async (e: MouseEvent) => {
        e.stopPropagation();
        const files = _collectNodeFiles(subtree);
        if (!files.length) return;
        copyBtn.disabled = true; copyBtn.textContent = '…';
        for (const name of files) {
            try { await copyFileBetween(name); }
            catch (err) { console.error('[workspace] dir copy:', name, err); }
        }
        copyBtn.disabled = false; copyBtn.textContent = glyph;
        renderFileList();
    };
    actions.appendChild(copyBtn);
    dirRow.appendChild(actions);

    // Drag support (fine-pointer devices only, matching file-row behaviour).
    if (window.matchMedia('(pointer: fine)').matches) {
        dirRow.draggable = true;
        dirRow.addEventListener('dragstart', (e: DragEvent) => {
            _draggedFiles = _collectNodeFiles(subtree);
            e.dataTransfer!.effectAllowed = 'copy';
            e.dataTransfer!.setData('text/x-freegent-files', JSON.stringify(_draggedFiles));
            setTimeout(() => dirRow.classList.add('ws-dragging'), 0);
        });
        dirRow.addEventListener('dragend', () => {
            dirRow.classList.remove('ws-dragging');
            _draggedFiles = [];
        });
    }
}

function buildFileTree(localFiles) {
    const root = { dirs: new Map(), files: [] };
    for (const f of localFiles) {
        const relName = f.name.slice('local/'.length);
        if (relName.endsWith('/')) {
            // Empty directory sentinel — ensure each path segment exists as a dir node
            const parts = relName.slice(0, -1).split('/');
            let node = root;
            for (const p of parts) {
                if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
                node = node.dirs.get(p);
            }
        } else {
            const parts = relName.split('/');
            let node = root;
            for (let i = 0; i < parts.length - 1; i++) {
                const p = parts[i];
                if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
                node = node.dirs.get(p);
            }
            node.files.push(f);
        }
    }
    return root;
}

function renderTree(parentEl, node, depth, pathPrefix, fileOrder = []) {
    for (const [dirName, subtree] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const fullPath    = pathPrefix + dirName;
        const isCollapsed = collapsedDirs.has(fullPath);

        const dirRow = document.createElement('div');
        dirRow.className = 'workspace-dir-row';
        dirRow.style.paddingLeft = (20 + depth * 16) + 'px';

        const toggle = document.createElement('span');
        toggle.className = 'ws-dir-toggle';
        toggle.textContent = isCollapsed ? '▶' : '▼';

        const nameEl = document.createElement('span');
        nameEl.className = 'ws-dir-name';
        nameEl.textContent = dirName;

        dirRow.append(toggle, nameEl);
        dirRow.onclick = () => {
            if (collapsedDirs.has(fullPath)) collapsedDirs.delete(fullPath);
            else collapsedDirs.add(fullPath);
            renderFileList();
        };
        _makeDirRow(dirRow, subtree, 'Copy to workspace');

        parentEl.appendChild(dirRow);
        if (!isCollapsed) renderTree(parentEl, subtree, depth + 1, fullPath + '/', fileOrder);
    }

    for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
        const basename = f.name.split('/').pop();
        fileOrder.push(f.name);
        const idx = fileOrder.length - 1;

        const row = document.createElement('div');
        row.className = 'workspace-file-row' + (selectedFiles.has(f.name) ? ' ws-selected' : '');
        row.style.paddingLeft = (20 + depth * 16) + 'px';
        row.dataset.filename = f.name;

        const nameEl = document.createElement('span');
        nameEl.className = 'workspace-file-name';
        nameEl.textContent = basename;
        nameEl.dataset.fullname = f.name;
        nameEl.title = f.name;

        row.addEventListener('click', e => {
            if ((e.target as HTMLElement).closest('.workspace-file-actions')) return;
            if (e.shiftKey && _localClickAnchorName !== null) {
                const anchorIdx = fileOrder.indexOf(_localClickAnchorName);
                const lo = Math.min(idx, anchorIdx !== -1 ? anchorIdx : idx);
                const hi = Math.max(idx, anchorIdx !== -1 ? anchorIdx : idx);
                for (let j = lo; j <= hi; j++) selectedFiles.add(fileOrder[j]);
            } else if (e.ctrlKey || e.metaKey) {
                selectedFiles.has(f.name) ? selectedFiles.delete(f.name) : selectedFiles.add(f.name);
            } else {
                selectedFiles.clear();
                selectedFiles.add(f.name);
            }
            _localClickAnchorName = f.name;
            updateSelectionUI();
        });
        row.addEventListener('dblclick', e => {
            if ((e.target as HTMLElement).closest('.workspace-file-actions')) return;
            openFileTab(f.name);
        });

        const actions = document.createElement('div');
        actions.className = 'workspace-file-actions';

        const del = document.createElement('button');
        del.className = 'ws-btn ws-btn-del'; del.title = 'Delete'; del.textContent = '×';
        del.onclick = e => { e.stopPropagation(); confirmDeleteFile(f.name); };
        actions.appendChild(del);

        makeDraggable(row, f.name);
        _attachFileTooltip(row, { name: f.name });
        row.append(nameEl, actions);
        parentEl.appendChild(row);
    }
}

function buildIdbFileTree(idbFiles) {
    const root = { dirs: new Map(), files: [] };
    for (const f of idbFiles) {
        const parts = f.name.split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
            node = node.dirs.get(p);
        }
        node.files.push(f);
    }
    return root;
}

function renderIdbTree(parentEl, node, depth, pathPrefix, fileOrder) {
    for (const [dirName, subtree] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const fullPath    = pathPrefix + dirName;
        const isCollapsed = collapsedDirs.has(fullPath);

        const dirRow = document.createElement('div');
        dirRow.className = 'workspace-dir-row';
        dirRow.style.paddingLeft = (20 + depth * 16) + 'px';

        const toggle = document.createElement('span');
        toggle.className = 'ws-dir-toggle';
        toggle.textContent = isCollapsed ? '▶' : '▼';

        const nameEl = document.createElement('span');
        nameEl.className = 'ws-dir-name';
        nameEl.textContent = dirName;

        dirRow.append(toggle, nameEl);
        dirRow.onclick = () => {
            if (collapsedDirs.has(fullPath)) collapsedDirs.delete(fullPath);
            else collapsedDirs.add(fullPath);
            renderFileList();
        };
        _makeDirRow(dirRow, subtree, 'Copy to local');

        parentEl.appendChild(dirRow);
        if (!isCollapsed) renderIdbTree(parentEl, subtree, depth + 1, fullPath + '/', fileOrder);
    }

    for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
        const basename = f.name.split('/').pop();
        fileOrder.push(f.name);
        const idx = fileOrder.length - 1;

        const row = document.createElement('div');
        row.className = 'workspace-file-row' + (selectedFiles.has(f.name) ? ' ws-selected' : '');
        row.style.paddingLeft = (20 + depth * 16) + 'px';
        row.dataset.filename = f.name;
        makeDraggable(row, f.name);

        row.addEventListener('click', e => {
            if ((e.target as HTMLElement).closest('.workspace-file-actions')) return;
            if (e.shiftKey && _idbClickAnchorName !== null) {
                const anchorIdx = fileOrder.indexOf(_idbClickAnchorName);
                const lo = Math.min(idx, anchorIdx !== -1 ? anchorIdx : idx);
                const hi = Math.max(idx, anchorIdx !== -1 ? anchorIdx : idx);
                for (let j = lo; j <= hi; j++) selectedFiles.add(fileOrder[j]);
            } else if (e.ctrlKey || e.metaKey) {
                selectedFiles.has(f.name) ? selectedFiles.delete(f.name) : selectedFiles.add(f.name);
            } else {
                selectedFiles.clear();
                selectedFiles.add(f.name);
            }
            _idbClickAnchorName = f.name;
            updateSelectionUI();
        });
        row.addEventListener('dblclick', e => {
            if ((e.target as HTMLElement).closest('.workspace-file-actions')) return;
            openFileTab(f.name);
        });

        const nameEl = document.createElement('span');
        nameEl.className = 'workspace-file-name';
        nameEl.textContent = basename;
        nameEl.dataset.fullname = f.name;
        nameEl.title = f.name;

        const actions = document.createElement('div');
        actions.className = 'workspace-file-actions';

        if (/\.html?$/i.test(f.name)) {
            const play = document.createElement('button');
            play.className = 'ws-btn ws-btn-play'; play.title = 'Open as HTML tab'; play.textContent = '▶';
            play.onclick = async e => {
                e.stopPropagation();
                try { const content = await agentReadFile(f.name); openArtifactTab(f.name, content); }
                catch (err) { alert(`Could not open: ${err.message}`); }
            };
            actions.appendChild(play);
        }
        if (/\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(f.name)) {
            const play = document.createElement('button');
            play.className = 'ws-btn ws-btn-play'; play.title = 'Preview image'; play.textContent = '▶';
            play.onclick = e => { e.stopPropagation(); openFileTab(f.name); };
            actions.appendChild(play);
        }
        if (/\.pdf$/i.test(f.name)) {
            const play = document.createElement('button');
            play.className = 'ws-btn ws-btn-play'; play.title = 'Preview PDF'; play.textContent = '▶';
            play.onclick = e => { e.stopPropagation(); openFileTab(f.name); };
            actions.appendChild(play);
        }
        if (/\.py$/i.test(f.name)) {
            const play = document.createElement('button');
            play.className = 'ws-btn ws-btn-play'; play.title = 'Run Python'; play.textContent = '▶';
            play.onclick = async e => {
                e.stopPropagation();
                play.textContent = '…'; play.disabled = true;
                try {
                    const code = await agentReadFile(f.name);
                    const idbRecs = await listWorkspaceFiles();
                    const filesDict = {};
                    for (const rec of idbRecs) filesDict[rec.name] = rec.content;
                    openArtifactTab(f.name, _buildPyRunnerHtml(f.name, code, filesDict), { isPreview: false });
                } catch (err) { alert(`Run failed: ${err.message}`); }
                finally { play.textContent = '▶'; play.disabled = false; }
            };
            actions.appendChild(play);
        }

        const dl = document.createElement('button');
        dl.className = 'ws-btn'; dl.title = 'Download'; dl.textContent = '↓';
        dl.onclick = e => { e.stopPropagation(); downloadFile(f.name); };

        const del = document.createElement('button');
        del.className = 'ws-btn ws-btn-del'; del.title = 'Delete'; del.textContent = '×';
        del.onclick = e => { e.stopPropagation(); confirmDeleteFile(f.name); };

        actions.append(dl, del);
        _attachFileTooltip(row, { name: f.name, size: f.size, lastModified: f.lastModified });
        row.append(nameEl, actions);
        parentEl.appendChild(row);
    }
}

export async function renderFileList() {
    // Headless (TUI / bench): no browser UI to update — skip the full workspace
    // stat-walk that agentListFiles() would trigger via the NodeFsAdapter.
    // Without this guard the DOMContentLoaded handler stat()s every file in the
    // workspace (including tmp/, which can be 57K files) and blocks the event loop
    // for several seconds immediately after the TUI renders.
    if (_wa) return;
    const listEl = document.getElementById('workspace-file-list');
    if (!listEl) return;

    const allFiles   = await agentListFiles();
    const idbFiles   = allFiles.filter(f => !f.isLocal);
    const localFiles = allFiles.filter(f => f.isLocal);

    const allNames = new Set(allFiles.map(f => f.name));
    for (const n of [...selectedFiles]) if (!allNames.has(n)) selectedFiles.delete(n);

    // Inject selection bar above the columns (created once, persists across re-renders)
    const listWrap = listEl.parentElement;
    if (listWrap && !document.getElementById('ws-selection-bar')) {
        const bar = document.createElement('div');
        bar.id = 'ws-selection-bar';
        bar.className = 'ws-selection-bar';

        const countEl = document.createElement('span');
        countEl.className = 'ws-sel-count';

        const dlBtn = document.createElement('button');
        dlBtn.className = 'ws-sel-btn';
        dlBtn.textContent = '↓ Download';
        dlBtn.onclick = downloadSelected;

        const delBtn = document.createElement('button');
        delBtn.className = 'ws-sel-btn ws-sel-btn-del';
        delBtn.textContent = '× Delete';
        delBtn.onclick = deleteSelected;

        const clearBtn = document.createElement('button');
        clearBtn.className = 'ws-sel-btn ws-sel-btn-clear';
        clearBtn.textContent = '✕ Clear';
        clearBtn.onclick = () => { selectedFiles.clear(); updateSelectionUI(); };

        bar.append(countEl, dlBtn, delBtn, clearBtn);
        listWrap.insertBefore(bar, listEl);
    }

    listEl.innerHTML = '';

    // Columns live in a wrapper so the trash zone can sit BELOW both columns
    // instead of in the seam between them (on portrait phones the trash strip
    // used to intercept cross-column drags and delete the source).
    const colsWrap = document.createElement('div');
    colsWrap.className = 'workspace-cols';

    const idbCol  = document.createElement('div');
    idbCol.className = 'workspace-col';

    const idbHdr  = document.createElement('div');
    idbHdr.className = 'workspace-col-hdr';
    const idbTitle = document.createElement('span');
    idbTitle.textContent = 'Workspace';
    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'ws-col-hdr-btn';
    uploadBtn.textContent = '↑ Files';
    uploadBtn.title = 'Upload files';
    uploadBtn.onclick = () => uploadFiles(false);
    const uploadFolderBtn = document.createElement('button');
    uploadFolderBtn.className = 'ws-col-hdr-btn';
    uploadFolderBtn.textContent = '↑ Folder';
    uploadFolderBtn.title = 'Upload a folder';
    uploadFolderBtn.onclick = () => uploadFiles(true);
    idbHdr.append(idbTitle, uploadBtn, uploadFolderBtn);
    idbCol.appendChild(idbHdr);

    const idbBody = document.createElement('div');
    idbBody.className = 'workspace-col-body';
    setupDropZone(idbBody, true); // accepts drops from local
    setupRubberBand(idbBody);

    if (!idbFiles.length) {
        const empty = document.createElement('div');
        empty.className = 'workspace-empty';
        empty.textContent = 'No files yet. Upload files or ask the agent to create some.';
        idbBody.appendChild(empty);
    } else {
        renderIdbTree(idbBody, buildIdbFileTree(idbFiles), 0, 'ws/', []);
    }

    idbCol.appendChild(idbBody);

    const trashZone = document.createElement('div');
    trashZone.className = 'ws-trash-zone';
    trashZone.textContent = '× Drop to delete';
    setupTrashZone(trashZone);

    colsWrap.appendChild(idbCol);

    const localCol  = document.createElement('div');
    localCol.className = 'workspace-col';

    const localHdr  = document.createElement('div');
    localHdr.className = 'workspace-col-hdr';

    const localTitle = document.createElement('span');
    localTitle.textContent = 'Local Folder';
    localHdr.appendChild(localTitle);

    if (fsaHandle) {
        const folderName = document.createElement('span');
        folderName.className = 'workspace-col-hdr-name';
        folderName.textContent = fsaHandle.name;
        folderName.title = 'Click to change folder';
        folderName.style.cursor = 'pointer';
        folderName.onclick = () => openLocalFolder();
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ws-col-hdr-btn ws-col-hdr-close-btn';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close local folder';
        closeBtn.onclick = () => closeFsaFolder();
        localHdr.append(folderName, closeBtn);
    } else if (pendingFsaHandle) {
        const folderName = document.createElement('span');
        folderName.className = 'workspace-col-hdr-name';
        folderName.textContent = pendingFsaHandle.name;
        folderName.title = pendingFsaHandle.name;
        const reconnBtn = document.createElement('button');
        reconnBtn.className = 'ws-col-hdr-btn';
        reconnBtn.textContent = '↺ Reconnect';
        reconnBtn.onclick = () => reconnectLocalFolder();
        localHdr.append(folderName, reconnBtn);
    } else if (localFiles.length > 0) {
        // Imported snapshot (no live FSA, but IDB has local/ files from a prior import)
        const folderName = document.createElement('span');
        folderName.className = 'workspace-col-hdr-name';
        const firstSeg = localFiles[0].name.replace(/^local\//, '').split('/')[0];
        folderName.textContent = firstSeg || '(imported)';
        folderName.title = `Imported snapshot — ${localFiles.length} file${localFiles.length !== 1 ? 's' : ''}`;
        const clearBtn = document.createElement('button');
        clearBtn.className = 'ws-col-hdr-btn ws-col-hdr-close-btn';
        clearBtn.textContent = '×';
        clearBtn.title = 'Clear imported files from Local Folder';
        clearBtn.onclick = () => clearImportedLocalFiles();
        localHdr.append(folderName, clearBtn);
    } else {
        const openBtn = document.createElement('button');
        openBtn.className = 'ws-col-hdr-btn';
        openBtn.textContent = fsaSupported() ? '+ Open Folder' : '+ Import Folder';
        openBtn.title = fsaSupported()
            ? 'Open a local folder with live read/write sync'
            : 'Import a folder snapshot into the Local Folder panel';
        // Call uploadFiles directly (synchronous) when FSA is unavailable — async
        // wrappers break the trusted user-gesture chain on mobile and the browser
        // silently ignores input.click().
        openBtn.onclick = () => fsaSupported() ? openLocalFolder() : uploadFiles(true, true);
        localHdr.appendChild(openBtn);
    }

    localCol.appendChild(localHdr);

    const localBody = document.createElement('div');
    localBody.className = 'workspace-col-body';

    if (!fsaHandle && !localFiles.length) {
        const ph = document.createElement('div');
        ph.className = 'workspace-empty';
        ph.textContent = 'No local folder open.';
        localBody.appendChild(ph);
    } else {
        setupDropZone(localBody, false); // accepts drops from IDB (live sync or imported snapshot)
        setupRubberBand(localBody);
        if (!localFiles.length) {
            const empty = document.createElement('div');
            empty.className = 'workspace-empty';
            empty.textContent = 'Folder is empty.';
            localBody.appendChild(empty);
        } else {
            const localFileOrder = [];
            renderTree(localBody, buildFileTree(localFiles), 0, 'local/', localFileOrder);
        }
    }

    localCol.appendChild(localBody);
    colsWrap.appendChild(localCol);
    listEl.appendChild(colsWrap);
    listEl.appendChild(trashZone);

    updateSelectionUI();
}

async function downloadFile(name) {
    try {
        const rec = await readWorkspaceFile(name) ?? (() => { throw new Error(`File not found: ${name}`); })();
        let blob: Blob;
        if (rec.encoding === 'base64') {
            const mime = {
                '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
            }[_extOf(name)] || 'application/octet-stream';
            blob = new Blob([_base64ToUint8(rec.content)], { type: mime });
        } else {
            blob = new Blob([rec.content], { type: 'text/plain;charset=utf-8' });
        }
        const url = URL.createObjectURL(blob);
        const a   = Object.assign(document.createElement('a'), { href: url, download: name.replace(/^local\//, '') });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        alert(`Download failed: ${e.message}`);
    }
}

async function confirmDeleteFile(name) {
    try {
        await agentDeleteFile(name);
    } catch (e) {
        alert(`Delete failed: ${e.message}`);
        console.error('[workspace] delete error:', name, e);
    }
}

// Directories to skip when importing via webkitdirectory (mirrors FSA_SKIP).
const UPLOAD_SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt',
    '__pycache__', '.venv', 'venv', 'env', 'vendor', 'target', 'bower_components',
    '.cache', '.parcel-cache', 'coverage', '.nyc_output',
]);
const UPLOAD_MAX_FILES  = 500;
const UPLOAD_MAX_BYTES  = 10 * 1024 * 1024; // 10 MB per file

// asLocal=true: write files under "local/" prefix so they appear in the Local Folder column.
function uploadFiles(folder = false, asLocal = false) {
    const input = document.createElement('input');
    input.type     = 'file';
    input.multiple = true;
    input.style.display = 'none';
    if (folder) {
        input.webkitdirectory = true;
    } else {
        input.accept = '.txt,.md,.json,.csv,.py,.js,.ts,.html,.css,.xml,.yaml,.yml,.toml,.sh,.log,.rst,.tex,.sql,.r,.c,.cpp,.h,.java,.go,.rs,.rb,.php,.pdf,.docx,.doc,.odt,.xlsx,.xls,.ods,.pptx,.ppt';
    }
    // Must be in the DOM before .click() — mobile browsers ignore detached inputs
    document.body.appendChild(input);
    input.onchange = async () => {
        document.body.removeChild(input);
        const allFiles = Array.from(input.files || []);

        // Filter out skip-dirs and oversized files before touching IDB.
        const files = allFiles.filter(f => {
            const rel  = f.webkitRelativePath || f.name;
            const segs = rel.split('/');
            // Any directory segment in the skip-list → drop the file.
            if (segs.slice(0, -1).some(s => UPLOAD_SKIP_DIRS.has(s) || s.startsWith('.'))) return false;
            if (f.size > UPLOAD_MAX_BYTES) {
                console.warn(`[workspace] skipping large file: ${rel} (${(f.size/1024/1024).toFixed(1)} MB)`);
                return false;
            }
            return true;
        });

        const skipped = allFiles.length - files.length;
        const toImport = files.slice(0, UPLOAD_MAX_FILES);
        if (toImport.length !== files.length) {
            console.warn(`[workspace] capped import at ${UPLOAD_MAX_FILES} of ${files.length} files (${skipped} filtered by dir/size)`);
        }
        if (toImport.length === 0) {
            console.warn('[workspace] no importable files after filtering');
            return;
        }

        // Process in batches of 20, yielding to the UI between batches.
        const BATCH = 20;
        for (let i = 0; i < toImport.length; i++) {
            const file = toImport[i];
            // webkitRelativePath gives "dirname/file.ext" for folder imports
            const rel  = file.webkitRelativePath || file.name;
            // Prefix with "local/" so files appear in the Local Folder column
            const path = asLocal ? 'local/' + rel : rel;
            try {
                if (_isBinaryExt(path)) {
                    const buf     = await file.arrayBuffer();
                    const content = _uint8ToBase64(new Uint8Array(buf));
                    await writeWorkspaceFile(path, content, null, 'base64');
                } else {
                    const text = await file.text();
                    await writeWorkspaceFile(path, text);
                }
            } catch (e) {
                console.error('[workspace] upload error:', path, e);
            }
            // Yield every BATCH files so the UI thread stays responsive.
            if ((i + 1) % BATCH === 0) await new Promise<void>(r => setTimeout(r, 0));
        }
        if (asLocal) _hasImportedLocal = true;
        await renderFileList();
    };
    input.click();
}


function initDragAndDrop() {
    const panel   = document.getElementById('workspace-panel');
    const overlay = document.getElementById('ws-drop-overlay');
    if (!panel || !overlay) return;

    let dragCounter = 0;

    panel.addEventListener('dragenter', e => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        dragCounter++;
        overlay.classList.add('active');
    });

    panel.addEventListener('dragleave', () => {
        dragCounter--;
        if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('active'); }
    });

    panel.addEventListener('dragover', e => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    panel.addEventListener('drop', async e => {
        e.preventDefault();
        dragCounter = 0;
        overlay.classList.remove('active');

        // Collect all file entries recursively (handles both files and folders).
        const readEntry = (entry, prefix = '') => new Promise<any>(resolve => {
            if (entry.isFile) {
                entry.file(f => resolve([{ path: prefix + f.name, file: f }]), () => resolve([]));
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                const entries = [];
                const readAll = () => reader.readEntries(batch => {
                    if (!batch.length) {
                        Promise.all(entries.map(e2 => readEntry(e2, prefix + entry.name + '/')))
                            .then(nested => resolve(nested.flat()));
                    } else {
                        entries.push(...batch);
                        readAll();
                    }
                }, () => resolve([]));
                readAll();
            } else {
                resolve([]);
            }
        });

        let collected: { path: string; file: File }[] = [];
        if (e.dataTransfer.items) {
            const entryPromises = [];
            for (const item of e.dataTransfer.items) {
                const entry = item.webkitGetAsEntry?.();
                if (entry) entryPromises.push(readEntry(entry));
            }
            collected = (await Promise.all(entryPromises)).flat();
        }
        // Fall back to flat files list if no entries found (e.g. unsupported browser)
        if (!collected.length) {
            collected = Array.from(e.dataTransfer.files || []).map(f => ({ path: f.name, file: f }));
        }

        for (const { path, file } of collected) {
            try {
                if (_isBinaryExt(path)) {
                    const buf     = await file.arrayBuffer();
                    const content = _uint8ToBase64(new Uint8Array(buf));
                    await writeWorkspaceFile(path, content, null, 'base64');
                } else {
                    const text = await file.text();
                    await writeWorkspaceFile(path, text);
                }
            } catch (err) {
                console.error('[workspace] drop error:', path, err);
            }
        }
        if (collected.length) await renderFileList();
    });
}



document.addEventListener('DOMContentLoaded', async () => {
    // Headless (TUI / bench): _wa is the NodeFsAdapter — no browser UI to init.
    // Skip initDB (IndexedDB unused when SQLite/node-sqlite is the real store),
    // tryRestoreLocalFolder (requires showDirectoryPicker — never available headless),
    // renderFileList (already guarded, but cheap to skip the whole path), and
    // initDragAndDrop (attaches mouse/touch event handlers to stub JSDOM elements).
    if (_wa) return;
    await initDB();
    await tryRestoreLocalFolder(); // renders file list (with Reconnect if needed)
    if (!fsaHandle && !pendingFsaHandle) await renderFileList();
    initDragAndDrop();
});

document.addEventListener('keydown', e => {
    if (e.key !== 'Delete') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement as HTMLElement)?.isContentEditable) return;
    if (!selectedFiles.size) return;
    e.preventDefault();
    deleteSelected();
});

// ── Project save / load / export / import ─────────────────────────────────

function _projectSlug(name) {
    return (name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

function _chatKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k === 'fg_chat_list' || k === 'fg_active_chat' || k.startsWith('fg_chat_')))
            keys.push(k);
    }
    return keys;
}

// Snapshot every localStorage key that project operations must NOT touch.
// Project scope = workspace files + chat history + project name only.
function _snapshotSettings() {
    const snap = {};
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k === 'fg_chat_list' || k === 'fg_active_chat' ||
            k.startsWith('fg_chat_') || k === 'fg_project_name') continue;
        snap[k] = localStorage.getItem(k);
    }
    return snap;
}

function _applySettingsSnapshot(snap: any) {
    for (const [k, v] of Object.entries(snap)) {
        if (v !== null) localStorage.setItem(k, v as string);
    }
}

async function _collectProjectData(name) {
    const wsFiles = await listWorkspaceFiles();
    const chatData = {};
    for (const k of _chatKeys()) chatData[k] = localStorage.getItem(k);
    return {
        fwproject: '1.0',
        id: _projectSlug(name),
        name: name || 'Project',
        savedAt: new Date().toISOString(),
        localFolderName: fsaHandle ? fsaHandle.name : null,
        workspace: wsFiles.map(f => ({ name: f.name, content: f.content, lastModified: f.lastModified, encoding: f.encoding || null })),
        chatData,
    };
}

async function _idbPutProject(data) {
    await ensureDB();
    return new Promise<void>((resolve, reject) => {
        const req = db.transaction(PROJ_STORE, 'readwrite').objectStore(PROJ_STORE).put(data);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

async function _idbGetAllProjects() {
    await ensureDB();
    return new Promise<any>((resolve, reject) => {
        const req = db.transaction(PROJ_STORE, 'readonly').objectStore(PROJ_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
    });
}

async function _idbGetProject(id) {
    await ensureDB();
    return new Promise<any>((resolve, reject) => {
        const req = db.transaction(PROJ_STORE, 'readonly').objectStore(PROJ_STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => reject(req.error);
    });
}

async function _idbDeleteProject(id) {
    await ensureDB();
    return new Promise<void>((resolve, reject) => {
        const req = db.transaction(PROJ_STORE, 'readwrite').objectStore(PROJ_STORE).delete(id);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

async function _gzipJson(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    // Start draining the readable side before writing — avoids backpressure deadlock on large payloads
    const outPromise = new Response(cs.readable).arrayBuffer();
    await writer.write(bytes);
    await writer.close();
    return outPromise;
}

async function _gunzipToJson(buffer) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const textPromise = new Response(ds.readable).text();
    await writer.write(new Uint8Array(buffer));
    await writer.close();
    return JSON.parse(await textPromise);
}

async function _extractDocText(name, base64Content) {
    let bytes: ArrayBuffer;
    try { bytes = _base64ToUint8(base64Content).buffer; }
    catch { return `[Binary file: ${name} — could not decode base64 content]`; }

    const ext = _extOf(name);
    try {
        if (ext === '.pdf' && pdfjsLib) {
            if (!pdfjsLib.GlobalWorkerOptions.workerSrc)
                pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/legacy/build/pdf.worker.min.js';
            const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
            const pages = [];
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const tc   = await page.getTextContent();
                pages.push(tc.items.map(it => it.str).join(' '));
            }
            return pages.join('\n\n');
        }
        if ((ext === '.docx' || ext === '.doc') && mammoth) {
            const result = await mammoth.extractRawText({ arrayBuffer: bytes });
            return result.value;
        }
        if ((ext === '.xlsx' || ext === '.xls' || ext === '.ods') && XLSX) {
            const wb = XLSX.read(bytes, { type: 'buffer' });
            return wb.SheetNames
                .map(sn => `Sheet: ${sn}\n${XLSX.utils.sheet_to_csv(wb.Sheets[sn])}`)
                .join('\n\n');
        }
    } catch (e) {
        return `[Document extraction failed for ${name}: ${e.message}]`;
    }
    const kb = Math.round(base64Content.length * 0.75 / 1024);
    return `[Binary file: ${name} — ${kb} KB. Use Pyodide (python-docx / pypdf / openpyxl) to process this file.]`;
}

function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function _restoreProjectData(data) {
    // Snapshot all settings (API keys, model config, etc.) before touching anything.
    // Something in the restore chain can trigger saveSettings() with empty form fields;
    // this ensures settings survive the operation regardless.
    const _settingsSnap = _snapshotSettings();

    // Silently drop the local folder connection without triggering a premature renderFileList.
    // (closeFsaFolder() calls renderFileList() internally before we've written the new files.)
    if (fsaHandle) {
        stopFsaSync();
        fsaHandle = null;
        pendingFsaHandle = null;
        clearFsaHandle().catch(() => {});
        updateFsaBadge();
    }
    // Clear existing workspace files
    await ensureDB();
    await new Promise<void>((resolve, reject) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
    // Write restored workspace files
    for (const f of (data.workspace || [])) {
        await writeWorkspaceFile(f.name, f.content, f.lastModified, f.encoding || null);
    }
    // Restore chat data to localStorage
    for (const k of _chatKeys()) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(data.chatData || {})) {
        if (v != null) localStorage.setItem(k, v as string);
    }
    // Update project name input
    const nameInput = document.getElementById('project-name-input') as HTMLInputElement | null;
    if (nameInput) nameInput.value = data.name || '';
    localStorage.setItem('fg_project_name', data.name || '');
    // Refresh in-memory state
    const activeId = localStorage.getItem('fg_active_chat') || '';
    setActiveChatId(activeId);
    lastUserMessageText = '';
    setLastProvider('');
    if (typeof loadChatHistory === 'function' && activeId) loadChatHistory(activeId);
    await renderFileList();
    const msgEl = typeof getMessagesEl === 'function' ? getMessagesEl() : null;
    if (msgEl) msgEl.innerHTML = '';
    if (typeof restoreChatMessages === 'function' && activeId) {
        const ok = await restoreChatMessages(activeId);
        if (!ok && typeof renderHistoryFallback === 'function') renderHistoryFallback();
    }
    if (typeof updateChatNameBar  === 'function') updateChatNameBar();
    if (typeof updateTokenLabel   === 'function') updateTokenLabel();
    loadAgentsContext?.();
    loadSkills?.();

    // Restore settings unconditionally — project operations must never alter them.
    _applySettingsSnapshot(_settingsSnap);
}

function _showFolderPrompt(projectName, folderName, projectId) {
    const suppressKey = `fg_project_no_folder_prompt_${projectId}`;
    if (localStorage.getItem(suppressKey) === '1') return;
    const ov = document.createElement('div');
    ov.className = 'fg-modal-overlay';
    ov.innerHTML = `<div class="fg-modal fg-modal-sm">
        <div class="fg-modal-header"><span class="fg-modal-title">Local folder</span></div>
        <div class="fg-modal-body">
          <p>Project <strong>${_esc(projectName)}</strong> was saved with local folder <code>${_esc(folderName)}</code>. Open a local folder now?</p>
          <label class="fg-modal-check-label"><input type="checkbox" id="fg-folder-suppress"> Don't ask again for this project</label>
        </div>
        <div class="fg-modal-btns">
          <button class="fg-modal-btn fg-modal-btn-cancel">Skip</button>
          <button class="fg-modal-btn fg-modal-btn-ok">Open folder…</button>
        </div></div>`;
    document.body.appendChild(ov);
    const close = () => {
        if ((ov.querySelector('#fg-folder-suppress') as HTMLInputElement).checked)
            localStorage.setItem(suppressKey, '1');
        ov.remove();
    };
    (ov.querySelector('.fg-modal-btn-cancel') as HTMLElement).onclick = close;
    (ov.querySelector('.fg-modal-btn-ok') as HTMLElement).onclick = () => {
        close();
        fsaSupported() ? openLocalFolder() : uploadFiles(true, true);
    };
}

async function clearProject() {
    const ov = document.createElement('div');
    ov.className = 'fg-modal-overlay';
    ov.innerHTML = `<div class="fg-modal fg-modal-sm">
        <div class="fg-modal-header"><span class="fg-modal-title">Clear project?</span></div>
        <div class="fg-modal-body">
          <p>This will permanently clear:</p>
          <ul style="margin:0 0 8px;padding-left:18px;line-height:1.8">
            <li>All workspace files</li>
            <li>Local folder connection</li>
            <li>All chat history</li>
            <li>Project name</li>
          </ul>
          <p style="margin:0;color:var(--muted)">Saved projects and settings are not affected.</p>
        </div>
        <div class="fg-modal-btns">
          <button class="fg-modal-btn fg-modal-btn-cancel">Cancel</button>
          <button class="fg-modal-btn fg-modal-btn-danger">Clear everything</button>
        </div></div>`;
    document.body.appendChild(ov);
    (ov.querySelector('.fg-modal-btn-cancel') as HTMLElement).onclick = () => ov.remove();
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    (ov.querySelector('.fg-modal-btn-danger') as HTMLElement).onclick = async () => {
        ov.remove();
        const _settingsSnap = _snapshotSettings();
        // Clear workspace files
        await ensureDB();
        await new Promise<void>((resolve, reject) => {
            const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
        // Close local folder
        if (fsaHandle) closeFsaFolder();
        // Clear chat history from SQLite/IDB before wiping localStorage so we still have the IDs.
        const _chatListSnap = typeof getChatList === 'function' ? getChatList() : [];
        if (typeof sessionSyncChatList === 'function') sessionSyncChatList([]);
        if (typeof sessionDeleteChat === 'function') {
            for (const c of _chatListSnap) sessionDeleteChat(c.id);
        }
        // Clear chat history from localStorage (_chatKeys includes fg_chat_list, fg_active_chat, fg_chat_*)
        for (const k of _chatKeys()) localStorage.removeItem(k);
        // Reset project name
        localStorage.removeItem('fg_project_name');
        const nameInput = document.getElementById('project-name-input') as HTMLInputElement | null;
        if (nameInput) nameInput.value = '';
        // Reset in-memory state and UI
        if (typeof createNewChat === 'function') createNewChat();
        await renderFileList();
        // Restore settings — clear must never affect API keys or model config.
        _applySettingsSnapshot(_settingsSnap);
    };
}

async function saveProject() {
    const nameInput = document.getElementById('project-name-input') as HTMLInputElement | null;
    const name = (nameInput?.value || '').trim() || localStorage.getItem('fg_project_name') || 'Project';
    if (nameInput && !nameInput.value.trim()) nameInput.value = name;
    localStorage.setItem('fg_project_name', name);
    try {
        const data = await _collectProjectData(name);
        await _idbPutProject(data);
        const btn = document.querySelector('.project-save-btn');
        if (btn) { const t = btn.textContent; btn.textContent = '✓ Saved'; setTimeout(() => { btn.textContent = t; }, 1500); }
    } catch (e) {
        alert('Save failed: ' + e.message);
    }
}

async function loadProjectUI() {
    const projects = await _idbGetAllProjects();
    if (!projects.length) { alert('No saved projects found.'); return; }

    const ov = document.createElement('div');
    ov.className = 'fg-modal-overlay';
    const rows = projects.map(p =>
        `<div class="fg-proj-row" data-id="${p.id}">
           <span class="fg-proj-name">${_esc(p.name)}</span>
           <span class="fg-proj-date">${p.savedAt?.slice(0,16).replace('T',' ') || ''}</span>
           <button class="fg-proj-delete ws-action-btn" data-del="${p.id}">✕</button>
         </div>`
    ).join('');
    ov.innerHTML = `<div class="fg-modal"><div class="fg-modal-header"><span class="fg-modal-title">Load Project</span><button class="fg-modal-close">✕</button></div>
        <div class="fg-modal-body fg-proj-list">${rows}</div></div>`;
    document.body.appendChild(ov);
    (ov.querySelector('.fg-modal-close') as HTMLElement).onclick = () => ov.remove();
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });

    ov.querySelectorAll('[data-del]').forEach(btn => {
        (btn as HTMLElement).onclick = async e => {
            e.stopPropagation();
            await _idbDeleteProject((btn as HTMLElement).dataset.del);
            btn.closest('.fg-proj-row').remove();
            if (!ov.querySelector('.fg-proj-row')) ov.remove();
        };
    });

    ov.querySelectorAll('.fg-proj-row').forEach(row => {
        (row as HTMLElement).onclick = async e => {
            if ((e.target as HTMLElement).dataset.del) return;
            const id = (row as HTMLElement).dataset.id;
            ov.remove();
            if (!confirm('Load this project? Current workspace and chat history will be replaced.')) return;
            const data = await _idbGetProject(id);
            if (!data) { alert('Project not found.'); return; }
            await _restoreProjectData(data);
            if (data.localFolderName) _showFolderPrompt(data.name, data.localFolderName, data.id);
        };
    });
}

async function exportProject() {
    const nameInput = document.getElementById('project-name-input') as HTMLInputElement | null;
    const name = (nameInput?.value || '').trim() || localStorage.getItem('fg_project_name') || 'Project';
    try {
        const data = await _collectProjectData(name);
        const buf  = await _gzipJson(data);
        const slug = _projectSlug(name);
        const blob = new Blob([buf], { type: 'application/gzip' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `${slug}.fwproject.gz`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
        console.error('[export] export failed:', e);
        alert('Export failed: ' + e.message);
    }
}

async function importProject(inputEl) {
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    try {
        let data: Record<string, any>;
        if (file.name.endsWith('.gz')) {
            data = await _gunzipToJson(await file.arrayBuffer());
        } else {
            data = JSON.parse(await file.text());
        }
        if (!data?.fwproject) throw new Error('Not a valid FreeGent project file.');
        if (!confirm(`Import project "${data.name}"? Current workspace and chat history will be replaced.`)) return;
        await _restoreProjectData(data);
        if (data.localFolderName) _showFolderPrompt(data.name, data.localFolderName, data.id || _projectSlug(data.name));
    } catch (e) {
        alert('Import failed: ' + e.message);
    }
}

// ── Window bridge ─────────────────────────────────────────────────────────────
// fsaHandle is mutable module state — expose a live accessor, not a snapshot.
Object.defineProperty(window, 'fsaHandle', { get: () => fsaHandle, configurable: true });
Object.assign(window, { writeFsaFile, deleteFsaFile, hasLocalFolder,
    // IDB storage (called directly in tools.js, config.js, and tests)
    initDB, ensureDB, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceFile,
    // Document helpers exposed for tools.js and other classic scripts
    _isBinaryExt, _isDocExt, _extOf, _uint8ToBase64, _base64ToUint8,
    // Agent file ops (called via window.X in tools.js)
    agentListFiles, agentListFilesInDir, agentListFilesNoStat, agentReadFile, agentWriteFile, agentDeleteFile, agentFileMtime,
    setWorkspaceAdapter,
    readFileAsDataUrl,
    getWorkspaceFilesDict: async () => {
        const recs = await listWorkspaceFiles();
        const d = {};
        for (const r of recs) d[r.name] = r.content;
        return d;
    },
    buildPyRunnerHtml: _buildPyRunnerHtml,
    // File list UI
    renderFileList, updateSelectionUI, downloadSelected, deleteSelected,
    copyFileBetween, downloadFile, confirmDeleteFile, uploadFiles,
    fsaSupported, updateFsaBadge,
    // FSA folder management
    openLocalFolder, closeFsaFolder, reconnectLocalFolder, tryRestoreLocalFolder,
    pollFsaChanges,
    // Checkpoint API
    saveCheckpointSnapshot, restoreCheckpointWorkspace, getCheckpointDiff,
    deleteCheckpointData, cleanupDanglingCheckpoints,
    // Project save/load/export/import
    saveProject, loadProjectUI, exportProject, importProject, clearProject,
});
