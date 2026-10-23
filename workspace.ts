// workspace.js — FreeGent file workspace
// IndexedDB storage + optional File System Access API

import { escapeHtml } from './html-escape.js';
import { extOf, isBinaryExt, isDocExt, mimeOfName, previewKindOfName } from './mime.js';
import { pptxSlides, odfText, docxText, fixXlsxCharRefs } from './office-text.js';
import { decodeTextBytes } from './text-decode.js';
import { bytesToBase64, base64ToBytes } from './shiro/utils/bytes.js';
import { gunzipSync } from './inflate.js';
import { taskTitleKey, isTaskPath } from './task-status.js';
import { clearChatHistory } from './chat-history.js';
import { tryMerge } from './diff-utils.js';
import { CloudSyncClient, sha256Hex, cloudSlug, pool, type CloudFile, type CloudManifest } from './cloud-sync.js';
import { DEFAULT_CF_WORKER, getDevKey } from './proxy.js';
import { getPrivacyLevel } from './privacy.js';
import { KEYS } from './storage-keys.js';
import { hashContent, planSync, keepBothName, nextBase, changedSinceImport, type SyncAction, type SyncItem } from './local-sync.js';
import { PYODIDE_CDN } from './pyodide-version.js';
import { bumpWorkspaceEpoch, workspaceEpoch, WORKSPACE_EPOCH_KEY } from './exec-limits.js';
export interface WorkspaceAdapter {
    agentListFiles(): Promise<Array<{name: string; size?: number; lastModified?: number}>>;
    /** List only files inside a specific subdirectory (relative to workspace root). Paths returned are relative to that subdir. Fast path — no stat calls. */
    agentListFilesInDir?(dir: string): Promise<Array<{name: string}>>;
    /** Top-level directories that exist but are left out of listings (build output, caches, dependencies). */
    agentHiddenDirs?(): Promise<string[]>;
    /** Whether a directory exists, empty or not (a file listing cannot tell an empty directory from an absent one). */
    agentDirExists?(path: string): Promise<boolean>;
    agentReadFile(path: string, encoding?: string): Promise<string>;
    agentWriteFile(path: string, content: string, encoding?: string): Promise<void>;
    agentDeleteFile(path: string): Promise<void>;
    /** Returns the file's last-modified timestamp (ms since epoch), or null if not found. */
    agentFileMtime?(path: string): Promise<number | null>;
    /** Paths are absolute filesystem paths (a Docker task container), not workspace-relative: the
     *  file tools must not strip their leading "/". */
    absolutePaths?: boolean;
}

let _wa: WorkspaceAdapter | null = null; // injected adapter (Node.js/headless only; null → IndexedDB/FSA)

const DB_NAME    = 'FreeGentDB';
const DB_VERSION = 5;
const STORE      = 'files';
const HDL_STORE  = 'handles';
const CKPT_STORE = 'checkpoints';
const PROJ_STORE = 'projects';
const SYNC_STORE = 'syncbase';   // texts the last sync/export/import agreed on (the base of a three-way merge) and the last sync's undo copy

const _extOf = extOf;
const _isBinaryExt = isBinaryExt;
const _isDocExt = isDocExt;
const _mimeOf = mimeOfName;
const _uint8ToBase64 = bytesToBase64;
const _base64ToUint8 = base64ToBytes;

let db: IDBDatabase | null              = null;
let fsaHandle: FileSystemDirectoryHandle | null       = null; // File System Access directory handle
let pendingFsaHandle: FileSystemDirectoryHandle | null = null; // stored handle awaiting user permission gesture


let fsaSyncTimer: ReturnType<typeof setInterval> | null = null;
let fsaSyncMtimes: Map<string, number> = new Map(); // relative path → lastModified timestamp
let fsaSyncSizes: Map<string, number> = new Map();  // relative path → size in bytes (filled by getFsaMtime)

async function startFsaSync() {
    stopFsaSync();
    // Seed initial mtimes so first poll doesn't flag everything as changed
    const names = await listFsaFiles();
    await Promise.all(names.map(async name => {
        if (name.endsWith('/')) { fsaSyncMtimes.set(name, 0); return; }
        try { fsaSyncMtimes.set(name, await getFsaMtime(name)); } catch {}
    }));
    fsaSyncTimer = setInterval(pollFsaChanges, 1500);
    renderFileList();   // sizes and timestamps are known now
}

function stopFsaSync() {
    if (fsaSyncTimer) { clearInterval(fsaSyncTimer); fsaSyncTimer = null; }
    fsaSyncMtimes = new Map();
    fsaSyncSizes = new Map();
}

async function getFsaMtime(name) {
    const { dir, filename } = await fsaNavigate(name);
    const fh   = await dir.getFileHandle(filename);
    const file = await fh.getFile();
    fsaSyncSizes.set(name, file.size);
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
        if (listChanged || changed.length) await renderFileList();   // changed files: new size / timestamp

        let taskFileChanged  = false;
        let skillFileChanged = false;
        let roleFileChanged  = false;
        await Promise.all(changed.map(async name => {
            try {
                const content = await readFsaFile(name);
                notifyLocalFileChanged?.('local/' + name, content);
                if (isTaskPath(name))  taskFileChanged  = true;
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
            if (!d.objectStoreNames.contains(SYNC_STORE))
                d.createObjectStore(SYNC_STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => {
            db = req.result;
            // iOS Safari closes IndexedDB connections of a backgrounded or memory-pressured tab. The
            // cached handle then throws InvalidStateError on every transaction until a reload, so
            // task status writes (and every file write) failed over and over. Drop it so the next
            // call reopens.
            const d = db;
            d.onclose = () => { if (db === d) db = null; };
            d.onversionchange = () => { try { d.close(); } catch {} if (db === d) db = null; };
            resolve(db);
        };
        req.onerror   = () => reject(req.error);
    });
}

let _dbOpening: Promise<any> | null = null;
// "Is there an imported local/ snapshot" is read from the records, not remembered: a flag set by one upload path and cleared by one
// delete path went stale on project import, clear and reload (opencode §16, §17). Called wherever local/ records can appear or go.
function _resyncImportedLocal(): Promise<void> {
    return new Promise<void>(res => {
        try {
            const r = db.transaction(STORE, 'readonly').objectStore(STORE).count(IDBKeyRange.bound('local/', 'local0', false, true));   // every name starting "local/"
            r.onsuccess = () => { _hasImportedLocal = (r.result as number) > 0; res(); };
            r.onerror = () => res();
        } catch { res(); }
    });
}

async function ensureDB() {
    if (db) {
        try { db.transaction(STORE, 'readonly').abort(); return; }   // cheap liveness probe
        catch { db = null; }
    }
    if (!_dbOpening) _dbOpening = initDB().then(() => _resyncImportedLocal()).finally(() => { _dbOpening = null; });
    await _dbOpening;
}

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
        // size in bytes: decoded for base64 records, UTF-8 for text (not the stored string length)
        const size = encoding === 'base64'
            ? Math.floor(String(content || '').replace(/[^A-Za-z0-9+/]/g, '').length * 3 / 4)
            : new TextEncoder().encode(content || '').length;
        const record: any = { name, content, lastModified: lastModified || Date.now(), size };
        if (encoding) record.encoding = encoding;
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        // Resolve on COMMIT, not when the request is queued: a quota failure surfaces as an abort
        // afterwards, and a write reported as done that never landed left task files unchanged.
        tx.oncomplete = () => { try { scheduleArtifactRefresh?.(name); } catch {} try { (window as any).refreshOpenFileTab?.(name); } catch {} try { (window as any).invalidateWorkspacePaths?.(); } catch {} if (String(name).startsWith('local/')) _hasImportedLocal = true; resolve(); };
        tx.onabort    = () => reject(tx.error ?? new Error('IndexedDB write aborted (storage full?)'));
        tx.onerror    = () => reject(tx.error ?? new Error('IndexedDB write failed'));
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

// Writes and deletes in ONE transaction: all of it commits or none of it does, including when the tab closes or the browser dies
// half-way (separate transactions left a mix of restored, deleted and untouched files). Used by the checkpoint restore.
async function applyWorkspaceBatch(writes: Array<{ name: string; content: string; encoding?: string | null; lastModified?: number | null }>, deletes: string[], opts: { clearAll?: boolean } = {}): Promise<void> {
    await ensureDB();
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = () => {
            for (const w of writes) { try { scheduleArtifactRefresh?.(w.name); } catch {} try { (window as any).refreshOpenFileTab?.(w.name); } catch {} }
            try { (window as any).invalidateWorkspacePaths?.(); } catch {}
            if (opts.clearAll || deletes.some(n => n.startsWith('local/')) || writes.some(w => w.name.startsWith('local/'))) _resyncImportedLocal().then(() => resolve());
            else resolve();
        };
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted (storage full?)'));
        tx.onerror = () => { /* the abort that follows rejects */ };
        try {
            const store = tx.objectStore(STORE);
            const now = Date.now();
            if (opts.clearAll) store.clear();   // queued in the same transaction: the clear and the puts commit together or not at all
            for (const w of writes) {
                const size = w.encoding === 'base64'
                    ? Math.floor(String(w.content || '').replace(/[^A-Za-z0-9+/]/g, '').length * 3 / 4)
                    : new TextEncoder().encode(w.content || '').length;
                const record: any = { name: w.name, content: w.content, lastModified: w.lastModified || now, size };
                if (w.encoding) record.encoding = w.encoding;
                store.put(record);
            }
            for (const name of deletes) store.delete(name);
        } catch (e) {
            try { tx.abort(); } catch {}
            reject(e);
        }
    });
}

async function deleteWorkspaceFile(name) {
    await ensureDB();
    return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const req = store.delete(name);

        req.onsuccess = () => {
            transaction.oncomplete = () => { try { (window as any).invalidateWorkspacePaths?.(); } catch {} if (String(name).startsWith('local/')) _resyncImportedLocal().then(() => resolve()); else resolve(); };
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

// Snapshots of one chat are taken one at a time, and each sorts after the one before it. Two could overlap (the post-turn snapshot
// of one message, the opening one of the next, an Autopilot snapshot of the same chat), and each computed its delta against whatever
// was stored when it started; one whose timestamp sorted earlier but was written later replayed on a wrong base.
const _ckptQueue = new Map<string, Promise<unknown>>();
function saveCheckpointSnapshot(chatId, ckptId): Promise<void> {
    const run = (_ckptQueue.get(chatId) ?? Promise.resolve()).catch(() => {}).then(() => _saveCheckpointSnapshot(chatId, ckptId));
    _ckptQueue.set(chatId, run);
    const clear = () => { if (_ckptQueue.get(chatId) === run) _ckptQueue.delete(chatId); };
    run.then(clear, clear);
    return run;
}

async function _saveCheckpointSnapshot(chatId, ckptId): Promise<void> {
    await ensureDB();

    const prev = (await _getCkptsForChat(chatId)).slice(-1)[0];
    // Sort order is the replay order: never at or before the snapshot this one is a delta against.
    const ts = Math.max(parseInt(ckptId, 10) || Date.now(), (prev?.ts ?? 0) + 1);
    const prevIdbH   = prev?.idbHashes   || {};
    const prevLocalH = prev?.localHashes || {};

    // IDB delta
    const idbFiles = await listWorkspaceFiles();
    const idbHashes = Object.create(null);
    const idbDelta  = [];
    for (const f of idbFiles) {
        const h = _ckptHash(f.content || '');
        idbHashes[f.name] = h;
        const op = prevIdbH[f.name] === undefined ? 'add' : prevIdbH[f.name] !== h ? 'modify' : null;
        // `encoding` is the record's own tag ('base64' for binary): without it a restored image came back as
        // base64 text under a .png name (uploads review 2026-10-14, 7.2). Absent for text and for older deltas.
        if (op) idbDelta.push({ name: f.name, content: f.content || '', op, ...(f.encoding ? { encoding: f.encoding } : {}) });
    }
    for (const name of Object.keys(prevIdbH)) {
        if (!idbHashes[name]) idbDelta.push({ name, content: null, op: 'delete' });
    }

    // Local (FSA) delta
    const localHashes = Object.create(null);
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
    const idbState   = Object.create(null);
    const idbEnc     = Object.create(null);
    const localState = Object.create(null);
    for (let i = 0; i <= targetIdx; i++) {
        for (const f of ckpts[i].idbDelta) {
            if (f.content === null) { delete idbState[f.name]; delete idbEnc[f.name]; }
            else { idbState[f.name] = f.content; if (f.encoding) idbEnc[f.name] = f.encoding; else delete idbEnc[f.name]; }
        }
        for (const f of ckpts[i].localDelta) {
            if (f.content === null) delete localState[f.name];
            else localState[f.name] = f.content;
        }
    }

    // One transaction: the target's files are written and the files it does not have are deleted together, or nothing changes.
    // (Before, each file was its own transaction, with a rollback for a thrown error that a crash or a closed tab never reached.)
    const current = await listWorkspaceFileNames();
    await applyWorkspaceBatch(
        Object.entries(idbState).map(([name, content]) => ({ name, content: content as string, encoding: idbEnc[name] ?? null })),
        current.filter(name => !(name in idbState)),
    );

    return { localFiles: Object.entries(localState).map(([name, content]) => ({ name, content })) };
}

// Workspace state after replaying a chat's snapshot deltas up to index `upto` (inclusive).
function _replayCkpts(ckpts, upto) {
    const idb = Object.create(null), local = Object.create(null);
    for (let i = 0; i <= upto && i < ckpts.length; i++) {
        for (const f of ckpts[i].idbDelta)   { if (f.content === null) delete idb[f.name];   else idb[f.name]   = f.content; }
        for (const f of ckpts[i].localDelta) { if (f.content === null) delete local[f.name]; else local[f.name] = f.content; }
    }
    return { idb, local };
}

// What a chat's first and last workspace snapshots hold, for the Chats tab: the start state is the
// workspace as it was when the chat's first message was sent, the end state the one after its
// last turn. Returns null for a chat with no snapshots.
async function getChatSnapshotInfo(chatId) {
    const ckpts = await _getCkptsForChat(chatId);
    if (!ckpts.length) return null;
    const summarize = (idx) => {
        const st = _replayCkpts(ckpts, idx);
        const all = { ...st.idb, ...Object.fromEntries(Object.entries(st.local).map(([k, v]) => ['local/' + k, v])) };
        let bytes = 0;
        for (const v of Object.values(all)) bytes += (v as any)?.length || 0;
        return { ckptId: ckpts[idx].ckptId, ts: ckpts[idx].ts, files: Object.keys(all).length, bytes, all };
    };
    const first = summarize(0), last = summarize(ckpts.length - 1);
    let added = 0, modified = 0, deleted = 0;
    for (const k of Object.keys(last.all)) {
        if (!(k in first.all)) added++;
        else if (first.all[k] !== last.all[k]) modified++;
    }
    for (const k of Object.keys(first.all)) if (!(k in last.all)) deleted++;
    const strip = ({ all, ...rest }) => rest;
    return { count: ckpts.length, start: strip(first), end: strip(last), changes: { added, modified, deleted } };
}

async function getCheckpointDiff(chatId, ckptId) {
    const ckpts = await _getCkptsForChat(chatId);
    const ckpt = ckpts.find(c => c.ckptId === ckptId);
    if (!ckpt) return null;
    const targetIdx = ckpts.indexOf(ckpt);
    const prevIdb = Object.create(null), prevLocal = Object.create(null);
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
    // An empty id list means the chat list was not loaded (or failed to load), not that every chat
    // was deleted: there is always at least the current chat. Never purge on it.
    if (!valid.size) return;
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
        uploadFiles(true, true);
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
        uploadFiles(true, true);  // fall back on any non-abort error
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

// A file that is not on the binary list: text goes in as text (UTF-16 and legacy 8-bit encodings converted, see
// text-decode.ts); bytes that are not text are kept as they are, in base64, instead of being decoded into garbage.
async function _storeUploadedText(path: string, file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = decodeTextBytes(bytes);
    if (text !== null) await writeWorkspaceFile(path, text);
    else await writeWorkspaceFile(path, _uint8ToBase64(bytes), null, 'base64');
}

/** Bytes of a picked file, or an error after `ms`: an iCloud file that is online-only is fetched on first read, which can take long or never finish. */
function _readBytesWithin(file: File, ms: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('not downloaded in time')), ms);
        file.arrayBuffer().then(b => { clearTimeout(t); resolve(new Uint8Array(b)); }, e => { clearTimeout(t); reject(e); });
    });
}

// The text of a base64 workspace record: a document is extracted; a plain text file (task attachments are stored as
// base64 whatever they are) is decoded from its bytes; anything else gets the extractor's message.
async function _readBase64Record(path: string, b64: string): Promise<string> {
    if (!_isDocExt(path)) {
        const text = decodeTextBytes(_base64ToUint8(b64));
        if (text !== null) return text;
    }
    return await _extractDocText(path, b64);
}

async function readFsaFile(name, asBase64 = false) {
    if (!fsaHandle) throw new Error('No local folder is synced — "local/…" paths are unavailable. Use the plain workspace path without the "local/" prefix (e.g. "src/main.js").');
    const { dir, filename } = await fsaNavigate(name);
    const handle = await dir.getFileHandle(filename);
    const file   = await handle.getFile();
    if (asBase64) { const buf = await file.arrayBuffer(); return _uint8ToBase64(new Uint8Array(buf)); }
    return decodeTextBytes(new Uint8Array(await file.arrayBuffer())) ?? await file.text();
}

async function writeFsaFile(name, content, encoding: string | null = null) {
    if (!fsaHandle) throw new Error('No local folder is synced — "local/…" paths are unavailable. Use the plain workspace path without the "local/" prefix (e.g. "src/main.js").');
    const { dir, filename } = await fsaNavigate(name, true);
    const handle   = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    // A binary record holds base64 text; the bytes go to the file (writing the text put the encoding's characters there while the tool said the
    // decoded size was written: codex R31-001).
    await writable.write(encoding === 'base64' ? base64ToBytes(String(content ?? '')) : content);
    await writable.close();
}
function _fsaMissing(e: any): boolean { return e?.name === 'NotFoundError' || /not[ _-]?found|could not be found|no such/i.test(String(e?.message ?? '')); }
/** Does the synced folder have this file? A folder that cannot be asked (the permission lapsed) is treated as having nothing: the workspace copy is
 *  then the only one, as before. Only a file that IS there and cannot be changed is an error (opencode §12). */
async function _fsaHas(name: string): Promise<boolean> {
    if (!fsaHandle) return false;
    try { const { dir, filename } = await fsaNavigate(name); await dir.getFileHandle(filename); return true; }
    catch (e: any) { if (_fsaMissing(e) || e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return false; throw e; }
}

async function deleteFsaFile(name) {
    if (!fsaHandle) throw new Error('No local folder is synced — "local/…" paths are unavailable. Use the plain workspace path without the "local/" prefix (e.g. "src/main.js").');
    const { dir, filename } = await fsaNavigate(name);
    await dir.removeEntry(filename);
}


export function setWorkspaceAdapter(a: WorkspaceAdapter | null) { _wa = a; }
export function workspaceUsesAbsolutePaths(): boolean { return !!_wa?.absolutePaths; }
/** The directory a workspace adapter serves (headless: the workspace on disk), or '' in the browser. */
export function workspaceRootDir(): string { return String((_wa as any)?.root ?? ''); }

// Whether a local folder is synced via the File System Access API this session —
// the system prompt branches its workspace description on this ("local/" paths
// only exist when true).
// Set to true when files are imported via uploadFiles(folder, asLocal=true).
// Allows hasLocalFolder() to return true for imported snapshots within the session.
let _hasImportedLocal = false;

export function hasLocalFolder(): boolean { return !!fsaHandle || _hasImportedLocal; }
/** A live File System Access folder is connected (an imported local/ snapshot does not count): what restoring to disk needs. */
export function hasFsaFolder(): boolean { return !!fsaHandle; }

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
        ...fsaNames.map(n => ({ name: 'local/' + n, isLocal: true, size: fsaSyncSizes.get(n), lastModified: fsaSyncMtimes.get(n) || undefined })),
    ];
}

/** Delete all IDB files under local/ (clears an imported snapshot). */
async function clearImportedLocalFiles() {
    const wsFiles = await listWorkspaceFilesMetaOnly();
    await Promise.all(wsFiles.filter(f => f.name.startsWith('local/')).map(f => deleteWorkspaceFile(f.name)));
    _hasImportedLocal = false;
    try { for (const k of [_LS_BASE, _LS_IMPORTED, 'fg_localsync_folder']) localStorage.removeItem(k); } catch {}
    await renderFileList();
}

// ── Imported Local Folder ↔ Workspace ────────────────────────────────────────
// Without a folder picker (Safari, Firefox) the Local Folder is a snapshot in IndexedDB under local/. Syncing it with the
// Workspace is a diff against what the two sides agreed on last time; the way back to the real folder is an export.
const _LS_BASE = 'fg_localsync_base';          // path → hash both sides had when last in agreement
const _LS_IMPORTED = 'fg_localsync_imported';  // path → hash the folder had when it was imported
function _lsGet(key: string): Record<string, string> { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; } }
function _lsSet(key: string, v: Record<string, string>): void { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

/** Content hashes of both sides, read one record at a time. Paths an import would skip (hidden, vendor dirs) are left out. */
async function _hashBothSides(): Promise<{ workspace: Record<string, string>; local: Record<string, string> }> {
    await ensureDB();
    const workspace: Record<string, string> = {}, local: Record<string, string> = {};
    await new Promise<void>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        req.onsuccess = () => {
            const c = req.result;
            if (!c) { resolve(); return; }
            const r = c.value, name: string = r.name;
            const isLocal = name.startsWith('local/'), path = isLocal ? name.slice(6) : name;
            const segs = path.split('/');
            if (!path.endsWith('/') && !segs.some(sg => UPLOAD_SKIP_DIRS.has(sg) || sg.startsWith('.')))
                (isLocal ? local : workspace)[path] = hashContent((r.encoding || '') + '|' + (r.content || ''));
            c.continue();
        };
        req.onerror = () => reject(req.error);
    });
    return { workspace, local };
}

// ── Base texts and undo ──────────────────────────────────────────────────────
// A three-way merge needs the text both sides started from. The sync keeps it per path, in two separate sets: 'folder' (what the Workspace and the
// imported Local Folder last agreed on) and 'project' (what the last project export or import held). The last sync's overwritten files are kept for one undo.
const _BASE_TEXT_MAX = 512 * 1024;
type _BaseNs = string;   // 'folder', 'project' or 'cloud/<project>'
async function _syncTx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
    await ensureDB();
    return new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(SYNC_STORE, mode);
        let req: IDBRequest | void;
        try { req = fn(tx.objectStore(SYNC_STORE)); } catch (e) { reject(e); return; }
        tx.oncomplete = () => resolve(req ? (req as IDBRequest).result : undefined);
        tx.onabort = () => reject(tx.error ?? new Error('sync store write aborted'));
    });
}
async function _saveBaseTexts(ns: _BaseNs, recs: Array<{ path: string; content: string; encoding?: string | null }>): Promise<void> {
    const texts = recs.filter(r => !r.encoding && typeof r.content === 'string' && r.content.length <= _BASE_TEXT_MAX);
    if (texts.length) await _syncTx('readwrite', st => { for (const r of texts) st.put({ id: `${ns}:${r.path}`, text: r.content }); });
}
async function _loadBaseText(ns: _BaseNs, path: string): Promise<string | null> {
    const rec: any = await _syncTx('readonly', st => st.get(`${ns}:${path}`));
    return rec && typeof rec.text === 'string' ? rec.text : null;
}
/** The base text of a path in the folder sync is only good while it is the text the recorded base hash stands for. */
async function _folderBaseText(path: string, base: Record<string, string>): Promise<string | null> {
    const t = await _loadBaseText('folder', path);
    return t !== null && base[path] !== undefined && hashContent('|' + t) === base[path] ? t : null;
}
async function _snapshotForUndo(names: string[], base: Record<string, string> | null): Promise<void> {
    const files: Array<{ name: string; rec: any }> = [];
    for (const name of names) files.push({ name, rec: (await readWorkspaceFile(name)) || null });
    await _syncTx('readwrite', st => st.put({ id: 'undo', ts: Date.now(), files, base }));
}
async function _hasUndo(): Promise<boolean> {
    try { return !!(await _syncTx<any>('readonly', st => st.get('undo'))); } catch { return false; }
}
/** Put back what the last sync or merge overwrote or removed, and the agreement it started from. */
export async function undoLastSync(): Promise<void> {
    try {
        const u: any = await _syncTx('readonly', st => st.get('undo'));
        if (!u) { alert('There is no sync to undo.'); return; }
        if (!confirm(`Undo the last sync (${u.files.length} file${u.files.length === 1 ? '' : 's'}, ${new Date(u.ts).toLocaleString()})? Changes made to these files since then are lost.`)) return;
        const writes = u.files.filter((f: any) => f.rec).map((f: any) => ({ name: f.name, content: f.rec.content, encoding: f.rec.encoding || null, lastModified: f.rec.lastModified }));
        const deletes = u.files.filter((f: any) => !f.rec).map((f: any) => f.name);
        await applyWorkspaceBatch(writes, deletes);
        if (u.base) _lsSet(_LS_BASE, u.base);
        await _syncTx('readwrite', st => st.delete('undo'));
        document.getElementById('fg-localsync-overlay')?.remove();
        await renderFileList();
    } catch (e: any) { alert(`Undo failed: ${e.message}`); }
}

/** A copy just made the two sides identical for this path: remember it, so a later edit on one side reads as that side's change rather than a conflict. */
function _noteAgreed(path: string, rec: any): void {
    const base = _lsGet(_LS_BASE);
    base[path] = hashContent((rec.encoding || '') + '|' + (rec.content || ''));
    _lsSet(_LS_BASE, base);
    _saveBaseTexts('folder', [{ path, content: rec.content, encoding: rec.encoding }]).catch(() => {});
}

/** After a folder import: drop snapshot files the folder no longer has (only those that were in sync, never a copy still waiting to be exported), and note what the folder holds. */
async function _afterLocalImport(imported: Set<string>): Promise<void> {
    const { workspace, local } = await _hashBothSides();
    const base = _lsGet(_LS_BASE);
    const agreed: string[] = [];
    for (const p of imported) if (local[p] !== undefined && local[p] === workspace[p]) { base[p] = local[p]; agreed.push(p); }   // identical files agree from the start
    _lsSet(_LS_BASE, base);
    await _recordFolderBase(agreed);
    const stale = Object.keys(local).filter(p => !imported.has(p) && base[p] === local[p]);
    if (stale.length) { await applyWorkspaceBatch([], stale.map(p => 'local/' + p)); for (const p of stale) delete local[p]; }
    const folder: Record<string, string> = {};
    for (const p of imported) if (local[p] !== undefined) folder[p] = local[p];
    _lsSet(_LS_IMPORTED, folder);
}

async function _recordFolderBase(paths: string[]): Promise<void> {
    const recs: Array<{ path: string; content: string; encoding?: string | null }> = [];
    for (const p of paths) { const r = await readWorkspaceFile(p); if (r && !r.encoding) recs.push({ path: p, content: r.content }); }
    await _saveBaseTexts('folder', recs);
}

type _Merge = { merged: string; conflicts: boolean };
/** Three-way merges for the paths changed on both sides, where the text they started from is known and all three are text. */
async function _computeMerges(paths: string[], readBase: (p: string) => Promise<string | null>, readA: (p: string) => Promise<any>, readB: (p: string) => Promise<any>): Promise<Record<string, _Merge>> {
    const out: Record<string, _Merge> = {};
    for (const p of paths) {
        const [b, a, c] = [await readBase(p), await readA(p), await readB(p)];
        if (b === null || !a || !c || a.encoding || c.encoding) continue;
        out[p] = tryMerge(b, a.content, c.content);
    }
    return out;
}

type _SyncResult = { changed: number; markers: string[] };
interface _SyncDialog {
    title: string;
    other: string;                       // what the second side is called: "Local Folder", "imported project"
    items: SyncItem[];
    merges: Record<string, _Merge>;
    note: string;
    apply: (items: SyncItem[], chosen: Map<string, SyncAction>) => Promise<_SyncResult>;
    withUndo: boolean;
    /** Called after Apply failed, so the dialog can be rebuilt from the current state of both sides. */
    onApplyError?: () => void;
    /** Further footer buttons; clicking one closes the dialog and runs `run`. */
    extra?: Array<{ label: string; title: string; run: () => void }>;
}

async function _applyLocalSync(items: SyncItem[], chosen: Map<string, SyncAction>, merges: Record<string, _Merge>): Promise<_SyncResult> {
    const writes: Array<{ name: string; content: string; encoding?: string | null; lastModified?: number | null }> = [];
    const deletes: string[] = [];
    const markers: string[] = [];
    const names = new Set((await listWorkspaceFileNames()));
    const put = (name: string, rec: any) => writes.push({ name, content: rec.content, encoding: rec.encoding || null, lastModified: rec.lastModified });
    for (const it of items) {
        let act = chosen.get(it.path) ?? it.action;
        if (!it.choices.includes(act)) act = it.action;
        if (act === 'skip') continue;
        const w = act === 'to-workspace' || act === 'delete-workspace' ? null : await readWorkspaceFile(it.path);
        const l = act === 'to-local' || act === 'delete-local' ? null : await readWorkspaceFile('local/' + it.path);
        if (act === 'to-workspace' && l) put(it.path, l);
        else if (act === 'to-local') { const rec = await readWorkspaceFile(it.path); if (rec) put('local/' + it.path, rec); }
        else if (act === 'keep-both' && w && l) {
            const copy = keepBothName(it.path, n => names.has(n)); names.add(copy);
            put(copy, l); put('local/' + it.path, w);
        }
        else if (act === 'merge' && merges[it.path]) {
            const m = merges[it.path];
            const rec = { content: m.merged, encoding: null, lastModified: Date.now() };
            put(it.path, rec); put('local/' + it.path, rec);
            if (m.conflicts) markers.push(it.path);
        }
        else if (act === 'delete-workspace') deletes.push(it.path);
        else if (act === 'delete-local') deletes.push('local/' + it.path);
    }
    const prevBase = _lsGet(_LS_BASE);
    if (writes.length || deletes.length) {
        await _snapshotForUndo([...new Set([...writes.map(x => x.name), ...deletes])], prevBase);
        await applyWorkspaceBatch(writes, deletes);
    }
    const now = await _hashBothSides();
    const base = nextBase(now.workspace, now.local, prevBase);
    _lsSet(_LS_BASE, base);
    await _recordFolderBase(Object.keys(base).filter(p => base[p] !== prevBase[p]));
    await renderFileList();
    return { changed: writes.length + deletes.length, markers };
}

const _SYNC_KIND_LABEL = (other: string): Record<string, string> => ({
    'new-in-local': `New in ${other}`, 'new-in-workspace': 'New in Workspace',
    'changed-in-local': `Changed in ${other}`, 'changed-in-workspace': 'Changed in Workspace',
    'conflict': 'Changed on both sides', 'removed-from-local': `Gone from ${other}`, 'removed-from-workspace': 'Gone from Workspace',
});
const _SYNC_ACTION_LABEL = (other: string): Record<string, string> => ({
    'to-workspace': `${other} → Workspace`, 'to-local': `Workspace → ${other}`, 'keep-both': 'Keep both', 'merge': 'Merge',
    'delete-workspace': 'Delete from Workspace', 'delete-local': `Delete from ${other}`, 'skip': 'Leave',
});

async function _showSyncDialog(d: _SyncDialog): Promise<void> {
    const { items, merges, other } = d;
    const kindLabel = _SYNC_KIND_LABEL(other), actLabel = _SYNC_ACTION_LABEL(other);
    document.getElementById('fg-localsync-overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'fg-modal-overlay'; ov.id = 'fg-localsync-overlay';
    const chosen = new Map<string, SyncAction>();
    const MAX_ROWS = 300;
    const groups = new Map<string, SyncItem[]>();
    for (const it of items) { if (!groups.has(it.kind)) groups.set(it.kind, []); groups.get(it.kind)!.push(it); }
    const opts = (choices: SyncAction[], sel: SyncAction, path?: string) => choices.map(c =>
        `<option value="${c}"${c === sel ? ' selected' : ''}>${c === 'merge' && path && merges[path]?.conflicts ? 'Merge (with conflict markers)' : actLabel[c]}</option>`).join('');
    let body = '';
    if (!items.length) body = `<p>The ${escapeHtml(other)} and the Workspace match.</p>`;
    else for (const [kind, list] of groups) {
        body += `<div class="fg-localsync-group"><div style="display:flex;gap:8px;align-items:center;margin:10px 0 4px"><strong style="flex:1">${kindLabel[kind]} (${list.length})</strong>` +
            `<select data-group="${kind}" aria-label="${kindLabel[kind]}: all">${opts(list[0].choices, list[0].action)}</select></div>`;
        for (const it of list.slice(0, MAX_ROWS)) {
            const m = merges[it.path];
            body += `<div style="display:flex;gap:8px;align-items:center;font-size:12px"><code style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(it.path)}">${escapeHtml(it.path)}</code>` +
                (m ? `<button type="button" class="fg-modal-btn" data-preview="${escapeHtml(it.path)}" style="padding:1px 8px;font-size:11px">${m.conflicts ? 'Preview ⚠' : 'Preview'}</button>` : '') +
                `<select data-path="${escapeHtml(it.path)}" data-kind="${kind}" aria-label="${escapeHtml(it.path)}">${opts(it.choices, it.action, it.path)}</select></div>` +
                (m ? `<pre data-preview-for="${escapeHtml(it.path)}" hidden style="font-size:11px;max-height:160px;overflow:auto;margin:2px 0 6px;padding:6px;background:rgba(127,127,127,.12);white-space:pre-wrap"></pre>` : '');
        }
        if (list.length > MAX_ROWS) body += `<div style="font-size:12px;opacity:.7">…and ${list.length - MAX_ROWS} more, handled like the group setting.</div>`;
        body += '</div>';
    }
    const undo = d.withUndo && await _hasUndo();
    ov.innerHTML = `<div class="fg-modal"><div class="fg-modal-header"><span class="fg-modal-title">${escapeHtml(d.title)}</span></div>` +
        `<div class="fg-modal-body" style="max-height:60vh;overflow:auto">${body}<p style="font-size:12px;opacity:.7">${d.note}</p></div>` +
        `<div class="fg-modal-btns" style="flex-wrap:wrap">${undo ? '<button class="fg-modal-btn fg-modal-btn-undo" style="margin-right:auto">↩ Undo last sync</button>' : ''}${(d.extra || []).map((x, i) => `<button class="fg-modal-btn fg-modal-btn-extra" data-extra="${i}" title="${escapeHtml(x.title)}">${escapeHtml(x.label)}</button>`).join('')}<button class="fg-modal-btn fg-modal-btn-cancel">${items.length ? 'Cancel' : 'Close'}</button>${items.length ? '<button class="fg-modal-btn fg-modal-btn-ok">Apply</button>' : ''}</div></div>`;
    document.body.appendChild(ov);
    const rowSel = (g: string) => Array.from(ov.querySelectorAll<HTMLSelectElement>(`select[data-path][data-kind="${g}"]`));
    ov.querySelectorAll<HTMLSelectElement>('select[data-group]').forEach(sel => sel.onchange = () => {
        for (const r of rowSel(sel.dataset.group!)) { if (Array.from(r.options).some(o => o.value === sel.value)) r.value = sel.value; }
        for (const it of groups.get(sel.dataset.group!)!) chosen.set(it.path, sel.value as SyncAction);
    });
    ov.querySelectorAll<HTMLSelectElement>('select[data-path]').forEach(sel => sel.onchange = () => chosen.set(sel.dataset.path!, sel.value as SyncAction));
    ov.querySelectorAll<HTMLElement>('button[data-preview]').forEach(btn => btn.onclick = () => {
        const path = btn.dataset.preview!;
        const pre = Array.from(ov.querySelectorAll<HTMLElement>('pre[data-preview-for]')).find(x => x.dataset.previewFor === path)!;
        if (pre.hidden) {
            const m = merges[path];
            pre.textContent = (m.conflicts ? 'Overlapping edits: the markers show both versions (A = Workspace, B = the other side).\n\n' : '') + m.merged.slice(0, 6000) + (m.merged.length > 6000 ? '\n…' : '');
        }
        pre.hidden = !pre.hidden;
    });
    (ov.querySelector('.fg-modal-btn-cancel') as HTMLElement).onclick = () => ov.remove();
    ov.querySelectorAll<HTMLElement>('button[data-extra]').forEach(b => b.onclick = () => { ov.remove(); d.extra![Number(b.dataset.extra)].run(); });
    const undoBtn = ov.querySelector('.fg-modal-btn-undo') as HTMLElement | null;
    if (undoBtn) undoBtn.onclick = () => { undoLastSync(); };
    const ok = ov.querySelector('.fg-modal-btn-ok') as HTMLButtonElement | null;
    if (ok) ok.onclick = async () => {
        ok.disabled = true; ok.textContent = '…';
        try {
            const res = await d.apply(items, chosen);
            ov.remove();
            if (res.markers.length) alert(`${res.markers.length} file${res.markers.length === 1 ? '' : 's'} had overlapping edits and now contain conflict markers (<<<<<<< A is the Workspace version, >>>>>>> B the other one):\n\n${res.markers.slice(0, 10).join('\n')}${res.markers.length > 10 ? '\n…' : ''}`);
        }
        catch (e: any) {
            ok.disabled = false; ok.textContent = 'Apply'; alert(`Sync failed: ${e.message}`);
            if (d.onApplyError) { ov.remove(); d.onApplyError(); }
        }
    };
}

/** Compare the imported Local Folder with the Workspace and let the user decide per file or per group. */
export async function openLocalSyncDialog(flags: { onlyIfIncoming?: boolean } = {}): Promise<void> {
    const { workspace, local } = await _hashBothSides();
    const base = _lsGet(_LS_BASE);
    let items = planSync(workspace, local, base);
    const merges = await _computeMerges(items.filter(i => i.kind === 'conflict').map(i => i.path),
        p => _folderBaseText(p, base), p => readWorkspaceFile(p), p => readWorkspaceFile('local/' + p));
    if (Object.keys(merges).length) items = planSync(workspace, local, base, merges);
    // After an import the Workspace's own files are not news: only open when the folder brought something that differs.
    if (flags.onlyIfIncoming && !items.some(i => i.kind !== 'new-in-workspace')) return;
    await _showSyncDialog({
        title: 'Sync Local Folder with Workspace', other: 'Local Folder', items, merges, withUndo: true,
        note: 'Files changed on both sides merge when their edits do not overlap; the preview shows the result. Nothing is deleted unless you choose it, and “Undo last sync” puts it all back. Changes to the Local Folder reach the real folder through “Export changes”.',
        apply: (its, chosen) => _applyLocalSync(its, chosen, merges),
    });
}

/** Project import as a merge: the project's files are compared with the Workspace; files edited on both sides merge when the project's last export or import is known. Chats stay as they are. */
async function _mergeProjectFiles(data: any): Promise<void> {
    const incoming: Record<string, any> = {}, incomingHash: Record<string, string> = {};
    for (const f of data.workspace || []) {
        const segs = String(f.name).split('/');
        if (String(f.name).startsWith('local/') || String(f.name).endsWith('/') || segs.some((sg: string) => UPLOAD_SKIP_DIRS.has(sg) || sg.startsWith('.'))) continue;
        incoming[f.name] = f; incomingHash[f.name] = hashContent((f.encoding || '') + '|' + (f.content || ''));
    }
    const { workspace } = await _hashBothSides();
    let items = planSync(workspace, incomingHash, {}).filter(i => i.kind === 'new-in-local' || i.kind === 'conflict');
    const merges = await _computeMerges(items.filter(i => i.kind === 'conflict').map(i => i.path),
        p => _loadBaseText('project', p), p => readWorkspaceFile(p), async p => incoming[p]);
    items = items.map(i => i.kind === 'new-in-local'
        ? { ...i, choices: ['to-workspace', 'skip'] as SyncAction[] }
        : (() => { const m = merges[i.path];
            const choices: SyncAction[] = m ? (m.conflicts ? ['keep-both', 'merge', 'to-workspace', 'skip'] : ['merge', 'keep-both', 'to-workspace', 'skip']) : ['keep-both', 'to-workspace', 'skip'];
            return { ...i, action: choices[0], choices }; })());
    await _showSyncDialog({
        title: `Merge project “${data.name || 'Project'}” into the Workspace`, other: 'imported project', items, merges, withUndo: true,
        note: 'Files only: chats and settings stay as they are. A file changed on both sides merges when the project’s previous export or import is known; otherwise both versions are kept (the project’s as “name (imported)”). Nothing is deleted, and “Undo last sync” puts it all back.',
        apply: async (its, chosen) => {
            const writes: Array<{ name: string; content: string; encoding?: string | null; lastModified?: number | null }> = [];
            const markers: string[] = [];
            const names = new Set(await listWorkspaceFileNames());
            const put = (name: string, f: any) => writes.push({ name, content: f.content, encoding: f.encoding || null, lastModified: f.lastModified });
            for (const it of its) {
                let act = chosen.get(it.path) ?? it.action;
                if (!it.choices.includes(act)) act = it.action;
                const f = incoming[it.path];
                if (act === 'to-workspace' && f) put(it.path, f);
                else if (act === 'keep-both' && f) { const copy = keepBothName(it.path, n => names.has(n), 'imported'); names.add(copy); put(copy, f); }
                else if (act === 'merge' && merges[it.path]) {
                    put(it.path, { content: merges[it.path].merged, encoding: null, lastModified: Date.now() });
                    if (merges[it.path].conflicts) markers.push(it.path);
                }
            }
            if (writes.length) {
                await _snapshotForUndo([...new Set(writes.map(x => x.name))], null);
                await applyWorkspaceBatch(writes, []);
            }
            await _saveBaseTexts('project', (data.workspace || []).map((f: any) => ({ path: f.name, content: f.content, encoding: f.encoding })));
            await renderFileList();
            return { changed: writes.length, markers };
        },
    });
}

// ── Cloud sync (Developer key): the Workspace ↔ a project on the Worker, file by file ─────────────────────────────────────────────
// Compared by SHA-256 against what the two sides agreed on last time, exactly like the folder sync; only changed files travel. Needs the
// Developer key and a Worker with an R2 bucket bound (see cf-worker/wrangler.toml). A push replaces the manifest only if nobody pushed
// since this device last looked (compare-and-swap); otherwise the sync says so and the user runs it again.
const _CLOUD_BASE = (slug: string) => `fg_cloudsync_base:${slug}`;
const _CLOUD_PULL_MAX = 200 * 1024 * 1024;
const _enc = new TextEncoder();

function _cloudWorkerUrl(): string {
    if (getPrivacyLevel() !== 'default') return '';
    return (localStorage.getItem(KEYS.SEARCH_PROXY) || '').trim() || DEFAULT_CF_WORKER;
}
function _cloudProjectSlug(): string {
    const name = (document.getElementById('project-name-input') as HTMLInputElement | null)?.value?.trim() || localStorage.getItem('fg_project_name') || 'Project';
    return cloudSlug(name);
}
function _cloudStatus(msg: string | null): void {
    let el = document.getElementById('fg-cloudsync-status');
    if (msg === null) { el?.remove(); return; }
    if (!el) {
        el = document.createElement('div'); el.id = 'fg-cloudsync-status'; el.setAttribute('role', 'status');
        el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:100000;background:#222;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;max-width:90vw';
        document.body.appendChild(el);
    }
    el.textContent = msg;
}
/** The bytes a workspace record stands for: base64 content is the file's bytes, anything else is UTF-8 text. */
function _recBytes(rec: any): Uint8Array {
    return rec.encoding === 'base64' ? base64ToBytes(rec.content || '') : _enc.encode(rec.content || '');
}
/** A downloaded file as a workspace record: text when it is valid UTF-8 (and was text), otherwise base64. */
function _bytesToRec(bytes: Uint8Array, asBase64: boolean): { content: string; encoding: string | null } {
    if (!asBase64) { try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: null }; } catch {} }
    return { content: bytesToBase64(bytes), encoding: 'base64' };
}

/** SHA-256 of every project file (not local/, vendor dirs), reusing the last hash while a file's size and modified time are unchanged. */
async function _cloudHashWorkspace(slug: string): Promise<{ files: Record<string, CloudFile>; hashes: Record<string, string> }> {
    const cacheRec: any = await _syncTx('readonly', st => st.get(`hcache:${slug}`));
    const cache: Record<string, [number, number, string]> = cacheRec?.files || {};
    const names = (await listWorkspaceFileNames()).filter(n => !n.startsWith('local/') && !n.endsWith('/') && !n.split('/').some(sg => UPLOAD_SKIP_DIRS.has(sg)));
    const files: Record<string, CloudFile> = {}, hashes: Record<string, string> = {}, next: Record<string, [number, number, string]> = {};
    let i = 0;
    for (const name of names) {
        if (++i % 25 === 0) _cloudStatus(`Reading files… ${i}/${names.length}`);
        const rec = await readWorkspaceFile(name);
        if (!rec) continue;
        const bytes = _recBytes(rec);
        const hit = cache[name];
        const h = hit && hit[0] === rec.lastModified && hit[1] === bytes.length ? hit[2] : await sha256Hex(bytes);
        next[name] = [rec.lastModified, bytes.length, h];
        files[name] = { h, s: bytes.length, ...(rec.encoding === 'base64' ? { e: 'base64' as const } : {}), m: rec.lastModified };
        hashes[name] = h;
    }
    await _syncTx('readwrite', st => st.put({ id: `hcache:${slug}`, files: next }));
    return { files, hashes };
}

/** Compare the Workspace with the project stored on the Worker and let the user choose, per file or group, what travels which way. */
export async function openCloudSyncDialog(): Promise<void> {
    const key = getDevKey(), url = _cloudWorkerUrl();
    if (!key) { alert('Cloud sync needs the Developer key (Settings → API Credentials).'); return; }
    if (!url) { alert('Cloud sync is off while the privacy level is below Default.'); return; }
    const slug = _cloudProjectSlug();
    const client = new CloudSyncClient(url, key);
    try {
        _cloudStatus('Connecting…');
        const remote = await client.getManifest(slug);
        const ws = await _cloudHashWorkspace(slug);
        const remoteHashes: Record<string, string> = {};
        for (const [p, f] of Object.entries(remote.manifest.files)) remoteHashes[p] = f.h;
        const baseRec = (() => { try { return JSON.parse(localStorage.getItem(_CLOUD_BASE(slug)) || 'null'); } catch { return null; } })();
        const base: Record<string, string> = baseRec?.files || {};
        let items = planSync(ws.hashes, remoteHashes, base);
        const ns = `cloud/${slug}`;
        const merges = await _computeMerges(items.filter(i => i.kind === 'conflict').map(i => i.path),
            async p => { const t = await _loadBaseText(ns, p); return t !== null && base[p] !== undefined && await sha256Hex(_enc.encode(t)) === base[p] ? t : null; },
            p => readWorkspaceFile(p),
            async p => {
                const f = remote.manifest.files[p];
                if (!f || f.e === 'base64' || f.s > 2 * 1024 * 1024) return null;
                // A cloud file that cannot be fetched only means no merge for it: the dialog (and its Replace buttons) must still open.
                try { const rec = _bytesToRec(await client.getBlob(slug, f.h), false); return rec.encoding ? null : rec; } catch { return null; }
            });
        if (Object.keys(merges).length) items = planSync(ws.hashes, remoteHashes, base, merges);
        _cloudStatus(null);
        if (!items.length) {
            localStorage.setItem(_CLOUD_BASE(slug), JSON.stringify({ etag: remote.etag, files: nextBase(ws.hashes, remoteHashes, base) }));
            alert(`“${slug}” is in sync with the cloud.`); return;
        }
        await _showSyncDialog({
            title: `Sync “${slug}” with the cloud`, other: 'Cloud', items, merges, withUndo: true,
            note: 'Only changed files travel. Files changed on both sides merge when their edits do not overlap (see the preview). Nothing is deleted unless you choose it, and “Undo last sync” restores the Workspace files this sync changed.',
            apply: (its, chosen) => _applyCloudSync({ client, slug, remote, ws, base, items: its, chosen, merges }),
            onApplyError: () => { openCloudSyncDialog(); },      // the cloud may have moved on: compare again, Replace options included
            extra: [
                { label: 'Replace cloud…', title: 'Make the cloud copy identical to this Workspace (uploads changes, deletes cloud-only files)', run: () => { _cloudReplace('cloud', items, { client, slug, remote, ws, base }); } },
                { label: 'Replace Workspace…', title: 'Make this Workspace identical to the cloud copy (downloads changes, deletes Workspace-only files)', run: () => { _cloudReplace('workspace', items, { client, slug, remote, ws, base }); } },
            ],
        });
    } catch (e: any) {
        _cloudStatus(null);
        alert(`Cloud sync failed: ${e?.message || e}`);
    }
}

/** One side overwrites the other completely: every difference is settled in its favour, and files only the other side has are deleted. */
function _replaceItems(items: SyncItem[], target: 'cloud' | 'workspace'): SyncItem[] {
    return items.map(it => {
        const inWorkspaceOnly = it.kind === 'new-in-workspace' || it.kind === 'removed-from-local';
        const inCloudOnly = it.kind === 'new-in-local' || it.kind === 'removed-from-workspace';
        let action: SyncAction;
        if (target === 'cloud') action = inCloudOnly ? 'delete-local' : 'to-local';          // "local" is the cloud side in cloud sync
        else action = inWorkspaceOnly ? 'delete-workspace' : 'to-workspace';
        return { ...it, action, choices: [action] };
    });
}

async function _cloudReplace(target: 'cloud' | 'workspace', items: SyncItem[], c: { client: CloudSyncClient; slug: string; remote: { etag: string | null; manifest: CloudManifest };
                                                                                    ws: { files: Record<string, CloudFile>; hashes: Record<string, string> }; base: Record<string, string> }): Promise<void> {
    const its = _replaceItems(items, target);
    const put = its.filter(i => i.action === 'to-local' || i.action === 'to-workspace').length;
    const del = its.length - put;
    const msg = target === 'cloud'
        ? `Replace the cloud copy of “${c.slug}” with this Workspace?\n\nUploads ${put} file${put === 1 ? '' : 's'} and deletes ${del} file${del === 1 ? '' : 's'} that only the cloud has. The cloud’s versions cannot be restored afterwards.`
        : `Replace this Workspace with the cloud copy of “${c.slug}”?\n\nDownloads ${put} file${put === 1 ? '' : 's'} (overwriting different ones) and deletes ${del} Workspace file${del === 1 ? '' : 's'} the cloud does not have. “Undo last sync” can restore them.`;
    if (!confirm(msg)) return;
    try {
        const res = await _applyCloudSync({ ...c, items: its, chosen: new Map(), merges: {} });
        alert(target === 'cloud' ? `The cloud copy now matches this Workspace (${res.changed} change${res.changed === 1 ? '' : 's'}).` : `This Workspace now matches the cloud copy (${res.changed} change${res.changed === 1 ? '' : 's'}).`);
    } catch (e: any) {
        _cloudStatus(null);
        alert(`Cloud sync failed: ${e?.message || e}`);
        openCloudSyncDialog();       // compare again with the current state
    }
}

async function _applyCloudSync(c: { client: CloudSyncClient; slug: string; remote: { etag: string | null; manifest: CloudManifest }; ws: { files: Record<string, CloudFile>; hashes: Record<string, string> };
                                    base: Record<string, string>; items: SyncItem[]; chosen: Map<string, SyncAction>; merges: Record<string, _Merge> }): Promise<_SyncResult> {
    const { client, slug, remote, ws, base } = c;
    const files: Record<string, CloudFile> = { ...remote.manifest.files };      // the manifest as it will be after this sync
    const wsAfter: Record<string, string> = { ...ws.hashes };
    const writes: Array<{ name: string; content: string; encoding?: string | null; lastModified?: number | null }> = [];
    const deletes: string[] = [];
    const uploads = new Map<string, Uint8Array>();                               // hash → bytes still to send
    const markers: string[] = [];
    const names = new Set(await listWorkspaceFileNames());
    let pullBytes = 0;
    const pull = async (path: string, as: string) => {
        const f = remote.manifest.files[path];
        pullBytes += f.s; if (pullBytes > _CLOUD_PULL_MAX) throw new Error('Too much to download in one sync (over 200 MB): choose “Leave” for the large files and sync again.');
        const rec = _bytesToRec(await client.getBlob(slug, f.h), f.e === 'base64');
        writes.push({ name: as, content: rec.content, encoding: rec.encoding, lastModified: f.m || Date.now() });
        return f;
    };
    const push = async (path: string) => {
        const rec = await readWorkspaceFile(path); if (!rec) return;
        const bytes = _recBytes(rec), h = ws.hashes[path];
        files[path] = ws.files[path];
        if (!Object.values(remote.manifest.files).some(f => f.h === h)) uploads.set(h, bytes);
    };
    let step = 0;
    for (const it of c.items) {
        let act = c.chosen.get(it.path) ?? it.action;
        if (!it.choices.includes(act)) act = it.action;
        if (act === 'skip') continue;
        _cloudStatus(`Preparing… ${++step}/${c.items.length}`);
        if (act === 'to-workspace') { const f = await pull(it.path, it.path); wsAfter[it.path] = f.h; }
        else if (act === 'to-local') await push(it.path);
        else if (act === 'keep-both') {
            const copy = keepBothName(it.path, n => names.has(n), 'cloud'); names.add(copy);
            await pull(it.path, copy);       // the cloud version is kept beside the file; the Workspace version goes up
            await push(it.path);
        } else if (act === 'merge' && c.merges[it.path]) {
            const m = c.merges[it.path], bytes = _enc.encode(m.merged), h = await sha256Hex(bytes);
            writes.push({ name: it.path, content: m.merged, encoding: null, lastModified: Date.now() });
            files[it.path] = { h, s: bytes.length, m: Date.now() }; wsAfter[it.path] = h;
            if (!Object.values(remote.manifest.files).some(f => f.h === h)) uploads.set(h, bytes);
            if (m.conflicts) markers.push(it.path);
        } else if (act === 'delete-workspace') { deletes.push(it.path); delete wsAfter[it.path]; }
        else if (act === 'delete-local') delete files[it.path];                    // "local" = the cloud side here
    }
    // Send first: if the project moved on meanwhile nothing in the Workspace has changed yet.
    const pushed = uploads.size > 0 || Object.keys(files).some(p => files[p] !== remote.manifest.files[p]) || Object.keys(remote.manifest.files).some(p => !(p in files));
    let etag = remote.etag;
    if (pushed) {
        const list = [...uploads.entries()]; let done = 0;
        await pool(list, 4, async ([h, bytes]) => {
            _cloudStatus(`Uploading… ${done}/${list.length}`);
            try { await client.putBlob(slug, h, bytes); } catch (e: any) { if (e?.status === 429 || e?.status === 500) { await new Promise(r => setTimeout(r, 1500)); await client.putBlob(slug, h, bytes); } else throw e; }
            done++;
        });
        try { etag = await client.putManifest(slug, { files }, remote.etag); }
        catch (e: any) { if (e?.status === 412) throw new Error('Someone pushed to this project while you were choosing. Nothing was changed here; run the sync again.'); throw e; }
    }
    if (writes.length || deletes.length) {
        await _snapshotForUndo([...new Set([...writes.map(x => x.name), ...deletes])], null);
        await applyWorkspaceBatch(writes, deletes);
    }
    const remoteAfter: Record<string, string> = {};
    for (const [p, f] of Object.entries(files)) remoteAfter[p] = f.h;
    const next = nextBase(wsAfter, remoteAfter, base);
    localStorage.setItem(_CLOUD_BASE(slug), JSON.stringify({ etag, files: next }));
    const recs: Array<{ path: string; content: string; encoding?: string | null }> = [];
    for (const p of Object.keys(next).filter(p => next[p] !== base[p])) { const r = await readWorkspaceFile(p); if (r && !r.encoding) recs.push({ path: p, content: r.content }); }
    await _saveBaseTexts(`cloud/${slug}`, recs);
    _cloudStatus(null);
    await renderFileList();
    return { changed: writes.length + deletes.length + uploads.size, markers };
}

/** Show the "☁ Sync" button only while a Developer key is saved. */
export function refreshCloudSyncButton(): void {
    const b = document.getElementById('fg-cloudsync-btn');
    if (b) b.style.display = getDevKey() ? '' : 'none';
}

/** Local Folder files that are new or edited since the folder was imported, as one zip: shared on devices that offer a share sheet, downloaded elsewhere. */
export async function exportLocalChanges(): Promise<void> {
    try {
        const { local } = await _hashBothSides();
        const changed = changedSinceImport(local, _lsGet(_LS_IMPORTED));
        if (!changed.length) { alert('The Local Folder has no changes since it was imported.'); return; }
        const files: { name: string; data: Uint8Array; mtime?: number }[] = [];
        for (const p of changed) files.push({ name: p, data: await agentReadFileBytes('local/' + p) });
        const { zipFiles } = await import('./workspace-zip.js');
        const zip = await zipFiles(files);
        const file = new File([zip as BlobPart], 'folder-changes.zip', { type: 'application/zip' });
        const nav: any = navigator;
        if (nav.canShare?.({ files: [file] })) {
            try { await nav.share({ files: [file], title: 'Folder changes' }); }
            catch (e: any) { if (e?.name === 'AbortError') return; throw e; }
        } else {
            const url = URL.createObjectURL(file);
            const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        }
        // The user now copies them into the folder: what the folder holds is these versions.
        const folder = { ..._lsGet(_LS_IMPORTED) };
        for (const p of changed) folder[p] = local[p];
        _lsSet(_LS_IMPORTED, folder);
    } catch (e: any) {
        alert(`Export failed: ${e.message}`);
    }
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

/** Whether `path` is a directory of the workspace, empty or not. Adapters with real directories answer; for the rest (IndexedDB records, containers)
 *  a directory is whatever has a file under it. */
export async function agentDirExists(path: string): Promise<boolean> {
    const dir = String(path).replace(/\/+$/, '');
    if (_wa?.agentDirExists) return _wa.agentDirExists(dir);
    const prefix = dir + '/';
    try { return (await agentListFiles()).some(f => String(f?.name ?? f).startsWith(prefix)); } catch { return false; }
}

/** Top-level directories present in the workspace but omitted from listings; [] where nothing is hidden. */
export async function agentHiddenDirs(): Promise<string[]> {
    return _wa?.agentHiddenDirs ? _wa.agentHiddenDirs() : [];
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
// Workspace file names are relative ("src/app.js"). The browser runtimes mount the workspace at
// /workspace, so "/workspace/src/app.js", "/src/app.js" and "./src/app.js" from any caller name
// the same file — never a file literally called "/workspace/…", which listed as a "workspace"
// folder inside the workspace.
// The path is normalized as a shell would: "a//b", "a/./b", "x/../a/b" and "a/b/" are "a/b", so
// every tool stores and finds one name per file. A path that climbs out of the workspace ("../x",
// "/workspace/../etc") is refused rather than stored under a name like "../x".
export function workspaceName(path: string): string {
    let p = String(path ?? '').trim();
    // A Windows-style path ("C:\\x\\y.txt") is a path inside the workspace like any other, never a drive.
    if (/^[A-Za-z]:[\\/]/.test(p)) p = p.slice(2);
    p = p.replace(/\\/g, '/');
    if (p === '/workspace' || p.startsWith('/workspace/')) p = p.slice('/workspace'.length);
    const out: string[] = [];
    for (const seg of p.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            if (!out.length) throw new Error(`Path '${path}' is outside the workspace — use a path inside it, e.g. '${p.split('/').filter(x => x && x !== '.' && x !== '..').join('/') || 'file.txt'}'`);
            out.pop();
            continue;
        }
        out.push(seg);
    }
    return out.join('/');
}

export async function agentReadFile(path) {
    if (_wa) return _wa.agentReadFile(path);
    path = workspaceName(path);
    const _fsaRead = async (name) => {
        if (_isDocExt(name)) {
            const b64 = await readFsaFile(name, true);
            return await _extractDocText(name, b64);
        }
        return await readFsaFile(name);
    };
    if (path.startsWith('local/')) {
        // With a folder synced, local/… IS the folder: a file it does not have is not found, whatever an old snapshot in the workspace holds.
        if (fsaHandle) { try { return await _fsaRead(path.slice(6)); } catch { throw new Error(`File not found: ${path}`); } }
        try { return await _fsaRead(path.slice(6)); } catch {}
        const rec = await readWorkspaceFile(path);
        if (rec) return rec.encoding === 'base64' ? await _readBase64Record(path, rec.content) : rec.content;
        throw new Error(`File not found: ${path}`);
    }
    const rec = await readWorkspaceFile(path);
    if (rec) {
        if (rec.encoding === 'base64') return await _readBase64Record(path, rec.content);
        return rec.content;
    }
    try { return await _fsaRead(path); } catch {}
    throw new Error(`File not found: ${path}`);
}

/** Raw bytes of a workspace file (binary-safe; used to attach workspace files to a chat message). */
export async function agentReadFileBytes(path: string): Promise<Uint8Array> {
    if (_wa) return (_wa as any).agentReadFileBytes ? (_wa as any).agentReadFileBytes(path) : new TextEncoder().encode(await agentReadFile(path));
    path = workspaceName(path);
    if (path.startsWith('local/') && fsaHandle) {
        try { return _base64ToUint8(await readFsaFile(path.slice(6), true)); } catch {}
    }
    const rec = await readWorkspaceFile(path);
    if (rec) return rec.encoding === 'base64' ? _base64ToUint8(rec.content) : new TextEncoder().encode(rec.content);
    if (fsaHandle) { try { return _base64ToUint8(await readFsaFile(path, true)); } catch {} }
    throw new Error(`File not found: ${path}`);
}

// Git metadata is off limits to agent writes: a hook (.git/hooks/*) or repo config (.git/config:
// core.pager, core.fsmonitor, aliases, filters) written into a granted local folder is executed by
// the next git command — run_git, or yours. Browser workspace only; headless runs are contained
// by their container.
function _refuseGitMetadata(path: string, op: string): void {
    if (String(path).split(/[\\/]+/).some(seg => seg.toLowerCase() === '.git'))
        throw new Error(`${op}: ${path} is inside a .git directory — git metadata can't be changed by the agent`);
}

// A new task file whose title is already on the board is a copy (Autopilot once wrote one while
// working a task): refuse it and point at the original so the agent continues that one.
async function _refuseDuplicateTask(path: string, content: any): Promise<void> {
    if (typeof content !== 'string' || !/^(?:fg-|local\/)?tasks\/\d+-.+\.md$/i.test(path) || path.endsWith('/ledger.md')) return;
    if (typeof loadTaskFiles !== 'function' || typeof parseFrontmatter !== 'function') return;
    const key = taskTitleKey(parseFrontmatter(content).title);
    if (!key) return;
    const twin = (await loadTaskFiles().catch(() => [])).find((t: any) => t.path !== path && taskTitleKey(t.fm.title) === key);
    if (twin) throw new Error(`write: ${path} duplicates task "${twin.fm.title}" (${twin.path}) — continue that task instead of creating a copy`);
}

// Re-rendering the whole file list after every agent write made 1,500 writes take 150 s (O(n) each).
// Agent writes ask for a render instead; at most one runs per quiet period.
let _fileListRenderTimer: any = null;
function _scheduleFileListRender() {
    if (_fileListRenderTimer) return;
    _fileListRenderTimer = setTimeout(() => { _fileListRenderTimer = null; renderFileList().catch(() => {}); }, 120);
}

// What a changed file means to the agent's own setup: project instructions, roles and skills are read from the workspace, so writing one
// takes effect for the next turn. The browser path did this after its write; an installed adapter (the TUI, the CLI) returned before it, so a
// skill the agent wrote worked only after a restart (TUI report case 046).
function _reloadAfterWorkspaceChange(path: string): void {
    const p = String(path).replace(/^\.?\/+/, '');
    if (p === 'AGENTS.md')       loadAgentsContext?.();
    if (p.startsWith('roles/'))  loadRoles?.();
    if (p.startsWith('skills/') || p.startsWith('rules/')) loadSkills?.();
}

/** `opts.epoch` stamps the write with the project it was meant for (workspaceEpoch() when the caller's work began). The check is made here, at
 *  the storage call, so a caller cannot forget it: a write whose project was cleared or replaced (in this tab or another) is refused instead of
 *  bringing an old file into the new project (codex report 8, 336/339/406-408/425-430). Without it the write is unconditional. */
export interface WriteOpts { epoch?: number }
function _assertEpoch(what: string, path: string, opts?: WriteOpts): void {
    if (opts?.epoch !== undefined && workspaceEpoch() !== opts.epoch) throw new Error(`${what}: the project was cleared or replaced while this was pending, so ${path} was not changed`);
}
export async function agentWriteFile(path, content, encoding = null, opts?: WriteOpts) {
    _assertEpoch('write', path, opts);
    if (_wa) { const r = await _wa.agentWriteFile(path, content, encoding); _reloadAfterWorkspaceChange(path); return r; }
    const generation = _workspaceGeneration;
    path = workspaceName(path);
    _refuseGitMetadata(path, 'write');
    await _refuseDuplicateTask(path, content);
    if (generation !== _workspaceGeneration) throw new Error(`write: the project was cleared or replaced while this write of ${path} was pending; it was not applied`);
    _assertEpoch('write', path, opts);
    if (path.startsWith('local/')) {
        if (fsaHandle) {
            await writeFsaFile(path.slice(6), content, encoding);
        } else {
            // local/ is reserved for a synced folder. Without one, only an imported snapshot of it
            // (local/ files already in IDB) takes writes; otherwise a look-alike folder would be made.
            const snapshot = (await listWorkspaceFilesMetaOnly()).some(f => f.name.startsWith('local/'));
            if (!snapshot) throw new Error(`No local folder is synced — "local/" is reserved for one. Use the path without "local/" (e.g. "${path.slice(6)}").`);
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
        // A file the synced folder has is written there too, and a failure to write it (read-only, no room) is the write's failure: the workspace
        // copy is not changed either, so the two cannot differ while the tool says it worked (opencode §12). A file the folder does not have stays a
        // workspace file; `local/` is the way to put one on disk.
        if (await _fsaHas(path)) await writeFsaFile(path, content, encoding);
        await writeWorkspaceFile(path, content, null, encoding);
    }
    _scheduleFileListRender();
    if (typeof content === 'string' && !encoding) (window as any).notifyAgentFileWritten?.(path, content);   // open editor tabs
    if (path === 'AGENTS.md')       loadAgentsContext?.();
    if (path.startsWith('roles/'))  loadRoles?.();
    if (path.startsWith('skills/') || path.startsWith('rules/')) loadSkills?.();
    // Keep the Kanban board in sync when the AI writes a task file directly.
    // The FSA sync loop handles live-synced folders; IDB writes (no FSA) need this call.
    if (isTaskPath(path)) refreshTasks?.();
}

export async function agentDeleteFile(path, opts?: WriteOpts) {
    _assertEpoch('delete', path, opts);
    if (_wa) { const r = await _wa.agentDeleteFile(path); _reloadAfterWorkspaceChange(path); return r; }
    path = workspaceName(path);
    _refuseGitMetadata(path, 'delete');
    _assertEpoch('delete', path, opts);
    // The file goes from the folder (when it has it; a failure there is the delete's failure and nothing else changes) and from the workspace store,
    // both: a snapshot record left behind brought a deleted file back on the next read, and the export (opencode §4.2, §4.3, §12).
    const rel = path.startsWith('local/') ? path.slice('local/'.length) : path;
    if (fsaHandle && await _fsaHas(rel)) await deleteFsaFile(rel);
    await deleteWorkspaceFile(path);
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


const collapsedDirs = new Set(); // full paths like 'local/fg-tasks' that are collapsed
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

function _buildPyRunnerHtml(filename, code, files) {
    const sj = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

    // Split text vs binary files for Pyodide FS
    const textFiles = Object.create(null), binFiles = Object.create(null);
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
<script src="${PYODIDE_CDN}pyodide.js"></script>
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
const py=await loadPyodide({indexURL:'${PYODIDE_CDN}'});
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
    // The files chosen when Download was pressed: the selection can change while earlier files are still being read, and a live
    // Set made the batch skip a file and add another (codex 361).
    for (const name of [...selectedFiles]) {
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
    // Only the file name is a drag handle (touch-action:none in CSS); a swipe
    // anywhere else on the row scrolls the list natively.
    // touchmove/touchend go on document so Chrome's scroll compositor can't
    // intercept them. preventDefault() fires on every move (not just after a
    // threshold) because Chrome commits to scroll before the threshold fires.
    row.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        if (!(e.target as HTMLElement).closest('.workspace-file-name')) return;
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
            _noteAgreed(name, rec);
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
            _noteAgreed(srcName, rec);
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
        const lines = [`<b>${escapeHtml(info.name)}</b>`];
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
// `copyLabel` – tooltip text; drives the button glyph. Workspace is the left column and Local Folder the right one, so a
// button that copies to the workspace points left (←) and one that copies to the local folder points right (→).
function _makeDirRow(dirRow: HTMLElement, subtree: any, copyLabel: string): void {
    const glyph = copyLabel.toLowerCase().includes('workspace') ? '←' : '→';

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
    for (const _e of _wsOrder(node, pathPrefix)) {
        if (_e.kind === 'dir') {
            const dirName = _e.name, subtree = _e.node;
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

            const _agg = _wsAgg(subtree);
            dirRow.append(toggle, nameEl, ..._wsInfoCols(_agg.size, _agg.lastModified));
            dirRow.onclick = () => {
                if (collapsedDirs.has(fullPath)) collapsedDirs.delete(fullPath);
                else collapsedDirs.add(fullPath);
                renderFileList();
            };
            _makeDirRow(dirRow, subtree, 'Copy to workspace');

            parentEl.appendChild(dirRow);
            if (!isCollapsed) renderTree(parentEl, subtree, depth + 1, fullPath + '/', fileOrder);
        } else {
            const f = _e.f;
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

            actions.appendChild(_openButton(f.name));

            const del = document.createElement('button');
            del.className = 'ws-btn ws-btn-del'; del.title = 'Delete'; del.textContent = '×';
            del.onclick = e => { e.stopPropagation(); confirmDeleteFile(f.name); };
            actions.appendChild(del);

            makeDraggable(row, f.name);
            _attachFileTooltip(row, { name: f.name });
            row.append(nameEl, ..._wsInfoCols(f.size, f.lastModified), actions);
            parentEl.appendChild(row);
        }
    }
}

// Opening a file was double-click only: nothing on the row said so, a keyboard could not do it, and a
// double tap on a phone zooms. The same action as a button.
function _openButton(name: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'ws-btn'; b.title = 'Open (or double-click the row)'; b.textContent = '↗';
    b.setAttribute('aria-label', `Open ${name}`);
    b.onclick = e => { e.stopPropagation(); openFileTab(name); };
    return b;
}

// The ▶ / ↓ / × buttons of a workspace file row. Shared by the Project files list and the
// sidebar Preview entry (playOnly: just the ▶ button, no download / delete).
export function buildFileActions(name: string, opts: { playOnly?: boolean } = {}): HTMLDivElement {
    const actions = document.createElement('div');
    actions.className = 'workspace-file-actions';

    if (/\.html?$/i.test(name)) {
        const play = document.createElement('button');
        play.className = 'ws-btn ws-btn-play'; play.title = 'Open as HTML tab'; play.textContent = '▶';
        play.onclick = async e => {
            e.stopPropagation();
            try { const content = await agentReadFile(name); openArtifactTab(name, content); }
            catch (err) { alert(`Could not open: ${err.message}`); }
        };
        actions.appendChild(play);
    }
    const kind = previewKindOfName(name);
    if (kind) {
        const play = document.createElement('button');
        play.className = 'ws-btn ws-btn-play';
        play.title = { image: 'Preview image', audio: 'Play audio', video: 'Play video', pdf: 'Preview PDF', sheet: 'Preview spreadsheet',
            docx: 'Preview document', odf: 'Preview document', pptx: 'Preview presentation', 'legacy-office': 'Open' }[kind];
        play.textContent = '▶';
        play.onclick = e => { e.stopPropagation(); openFileTab(name); };
        actions.appendChild(play);
    }
    if (/\.py$/i.test(name)) {
        const play = document.createElement('button');
        play.className = 'ws-btn ws-btn-play'; play.title = 'Run Python'; play.textContent = '▶';
        play.onclick = async e => {
            e.stopPropagation();
            play.textContent = '…'; play.disabled = true;
            try {
                const code = await agentReadFile(name);
                const idbRecs = await listWorkspaceFiles();
                const filesDict = Object.create(null);
                for (const rec of idbRecs) filesDict[rec.name] = rec.content;
                openArtifactTab(name, _buildPyRunnerHtml(name, code, filesDict), { isPreview: false });
            } catch (err) { alert(`Run failed: ${err.message}`); }
            finally { play.textContent = '▶'; play.disabled = false; }
        };
        actions.appendChild(play);
    }

    if (opts.playOnly) return actions;

    actions.appendChild(_openButton(name));

    const dl = document.createElement('button');
    dl.className = 'ws-btn'; dl.title = 'Download'; dl.textContent = '↓';
    dl.onclick = e => { e.stopPropagation(); downloadFile(name); };

    const del = document.createElement('button');
    del.className = 'ws-btn ws-btn-del'; del.title = 'Delete'; del.textContent = '×';
    del.onclick = e => { e.stopPropagation(); confirmDeleteFile(name); };

    actions.append(dl, del);
    return actions;
}

// ── Size / modified columns and sorting (Workspace and Local Folder lists) ──
type _WsSortKey = 'name' | 'size' | 'time';
let _wsSort: { key: _WsSortKey; dir: 1 | -1 } = (() => {
    try { const v = JSON.parse(localStorage.getItem('fg_ws_sort') || ''); if (['name', 'size', 'time'].includes(v?.key)) return { key: v.key, dir: v.dir === -1 ? -1 : 1 }; } catch {}
    return { key: 'name', dir: 1 };
})();

function _wsSetSort(key: _WsSortKey): void {
    // Name starts ascending; size and modified start with the biggest / newest first.
    _wsSort = _wsSort.key === key ? { key, dir: (_wsSort.dir * -1) as 1 | -1 } : { key, dir: key === 'name' ? 1 : -1 };
    try { localStorage.setItem('fg_ws_sort', JSON.stringify(_wsSort)); } catch {}
    renderFileList();
}

function _fmtWsSize(n?: number): string {
    if (typeof n !== 'number') return '';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
    return `${(n / 1073741824).toFixed(1)} GB`;
}
function _fmtWsTime(ms?: number): string {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const opts: Intl.DateTimeFormatOptions = sameYear
        ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
        : { year: 'numeric', month: 'short', day: 'numeric' };
    return d.toLocaleString([], opts);
}

// A folder's size is the total of its contents; its timestamp is the newest change inside it.
function _wsAgg(node): { size: number; lastModified: number } {
    if (node._agg) return node._agg;
    let size = 0, lastModified = 0;
    for (const f of node.files) { size += f.size || 0; lastModified = Math.max(lastModified, f.lastModified || 0); }
    for (const sub of node.dirs.values()) { const a = _wsAgg(sub); size += a.size; lastModified = Math.max(lastModified, a.lastModified); }
    return (node._agg = { size, lastModified });
}

// Rank of every entry in the directory order last computed. Ties in a sort keep that order, so
// switching sorts (or re-rendering after a file change) never reshuffles entries that compare equal.
const _wsRank = new Map<string, number>();

type _WsEntry = { kind: 'dir'; name: string; node: any; key: string } | { kind: 'file'; f: any; key: string };

// The entries of one directory in display order. Name sorts keep folders first; size and modified
// rank folders and files together, a folder counting by its contents (see _wsAgg).
function _wsOrder(node, pathPrefix: string): _WsEntry[] {
    const entries: _WsEntry[] = [
        ...[...node.dirs.entries()].map(([name, n]: [string, any]) => ({ kind: 'dir' as const, name, node: n, key: 'd:' + pathPrefix + name })),
        ...node.files.map((f: any) => ({ kind: 'file' as const, f, key: 'f:' + f.name })),
    ];
    const label = (e: _WsEntry) => e.kind === 'dir' ? e.name : e.f.name.split('/').pop() as string;
    const value = (e: _WsEntry) => {
        const a = e.kind === 'dir' ? _wsAgg(e.node) : { size: e.f.size || 0, lastModified: e.f.lastModified || 0 };
        return _wsSort.key === 'size' ? a.size : a.lastModified;
    };
    entries.sort((a, b) => {
        if (_wsSort.key === 'name') {
            if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
            return label(a).localeCompare(label(b)) * _wsSort.dir;
        }
        const d = (value(a) - value(b)) * _wsSort.dir;
        if (d) return d;
        const ra = _wsRank.get(a.key), rb = _wsRank.get(b.key);
        if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
        if ((ra === undefined) !== (rb === undefined)) return ra === undefined ? 1 : -1;
        return label(a).localeCompare(label(b));
    });
    entries.forEach((e, i) => _wsRank.set(e.key, i));
    return entries;
}

function _wsInfoCols(size?: number, lastModified?: number): HTMLElement[] {
    const sz = document.createElement('span');
    sz.className = 'ws-col-size'; sz.textContent = _fmtWsSize(size);
    const tm = document.createElement('span');
    tm.className = 'ws-col-time'; tm.textContent = _fmtWsTime(lastModified);
    if (lastModified) tm.title = new Date(lastModified).toLocaleString();
    return [sz, tm];
}

// Column header row: click Name / Size / Modified to sort; click again to reverse.
function _wsSortHeader(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ws-sort-hdr';
    for (const [key, label, cls] of [['name', 'Name', 'ws-sort-name'], ['size', 'Size', 'ws-col-size'], ['time', 'Modified', 'ws-col-time']] as [_WsSortKey, string, string][]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `ws-sort-btn ${cls}` + (_wsSort.key === key ? ' active' : '');
        b.textContent = label + (_wsSort.key === key ? (_wsSort.dir === 1 ? ' ▲' : ' ▼') : '');
        b.title = `Sort by ${label.toLowerCase()}`;
        b.onclick = () => _wsSetSort(key);
        row.appendChild(b);
    }
    return row;
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
    for (const _e of _wsOrder(node, pathPrefix)) {
        if (_e.kind === 'dir') {
            const dirName = _e.name, subtree = _e.node;
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

            const _agg = _wsAgg(subtree);
            dirRow.append(toggle, nameEl, ..._wsInfoCols(_agg.size, _agg.lastModified));
            dirRow.onclick = () => {
                if (collapsedDirs.has(fullPath)) collapsedDirs.delete(fullPath);
                else collapsedDirs.add(fullPath);
                renderFileList();
            };
            _makeDirRow(dirRow, subtree, 'Copy to local');

            parentEl.appendChild(dirRow);
            if (!isCollapsed) renderIdbTree(parentEl, subtree, depth + 1, fullPath + '/', fileOrder);
        } else {
            const f = _e.f;
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

            const actions = buildFileActions(f.name);
            _attachFileTooltip(row, { name: f.name, size: f.size, lastModified: f.lastModified });
            row.append(nameEl, ..._wsInfoCols(f.size, f.lastModified), actions);
            parentEl.appendChild(row);
        }
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
    const attachBtn = document.createElement('button');
    attachBtn.className = 'ws-col-hdr-btn';
    attachBtn.textContent = '↑ Attachment';
    attachBtn.title = "Upload from the device's attachment sheet (camera, photos, audio, video)";
    attachBtn.onclick = () => uploadFiles(false, false, true);
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'ws-col-hdr-btn';
    downloadBtn.textContent = '↓ Download';
    downloadBtn.title = 'Download the whole workspace as a folder (zip)';
    downloadBtn.onclick = () => downloadWorkspaceFolder(downloadBtn);
    uploadBtn.style.marginLeft = 'auto';   // title on the left, the four buttons right-aligned
    idbHdr.append(idbTitle, uploadBtn, uploadFolderBtn, attachBtn, downloadBtn);
    idbCol.appendChild(idbHdr);

    idbCol.appendChild(_wsSortHeader());

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
        let savedRoot = ''; try { savedRoot = localStorage.getItem('fg_localsync_folder') || ''; } catch {}
        const firstSeg = savedRoot || localFiles[0].name.replace(/^local\//, '').split('/')[0];
        folderName.textContent = firstSeg || '(imported)';
        folderName.title = `Imported snapshot — ${localFiles.length} file${localFiles.length !== 1 ? 's' : ''}`;
        const clearBtn = document.createElement('button');
        clearBtn.className = 'ws-col-hdr-btn ws-col-hdr-close-btn';
        clearBtn.textContent = '×';
        clearBtn.title = 'Clear imported files from Local Folder';
        clearBtn.onclick = () => clearImportedLocalFiles();
        const mkBtn = (text: string, title: string, fn: () => void) => {
            const b = document.createElement('button');
            b.className = 'ws-col-hdr-btn'; b.textContent = text; b.title = title; b.onclick = fn;
            return b;
        };
        localHdr.append(folderName,
            mkBtn('⇄ Sync', 'Compare this snapshot with the Workspace and choose what to copy', () => openLocalSyncDialog()),
            mkBtn('Export changes', 'Download (or share) a zip of the files changed here since the folder was imported', () => exportLocalChanges()),
            clearBtn);
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
    localCol.appendChild(_wsSortHeader());

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
    (window as any).updateRailPreview?.();
}

// The whole Workspace column (not the Local Folder) as one zip; extracting it gives the folder.
async function downloadWorkspaceFolder(btn?: HTMLButtonElement): Promise<void> {
    const label = btn?.textContent ?? '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
        const names = (await agentListFiles()).filter(f => !f.isLocal && !f.name.endsWith('/'));
        if (!names.length) { alert('The workspace has no files to download.'); return; }
        const files: { name: string; data: Uint8Array; mtime?: number }[] = [];
        for (const f of names) files.push({ name: f.name, data: await agentReadFileBytes(f.name), mtime: f.lastModified });
        const { zipFiles } = await import('./workspace-zip.js');
        const zip = await zipFiles(files);
        const base = (document.getElementById('project-name-input') as HTMLInputElement | null)?.value.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'workspace';
        const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
        const a = Object.assign(document.createElement('a'), { href: url, download: `${base}.zip` });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
        alert(`Download failed: ${e.message}`);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
}

async function downloadFile(name) {
    try {
        const rec = await readWorkspaceFile(name) ?? (() => { throw new Error(`File not found: ${name}`); })();
        let blob: Blob;
        if (rec.encoding === 'base64') {
            const mime = mimeOfName(name);
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
const UPLOAD_READ_MS    = 20_000; // per file: an online-only iCloud file may never arrive
const UPLOAD_MAX_BYTES  = 10 * 1024 * 1024; // 10 MB per file

// asLocal=true: write files under "local/" prefix so they appear in the Local Folder column.
// deviceAttach: offer only what a phone's attachment sheet is for (camera, photos, audio, video).
function uploadFiles(folder = false, asLocal = false, deviceAttach = false) {
    const input = document.createElement('input');
    input.type     = 'file';
    input.multiple = true;
    input.style.display = 'none';
    if (folder) {
        input.webkitdirectory = true;
    } else if (deviceAttach) {
        input.accept = 'image/*,audio/*,video/*';
    }
    // No `accept` filter: with none, phones and tablets offer their full attachment sheet (Photo
    // Library, Take Photo, Files) and desktops show every file type.
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
        const importedPaths = new Set<string>();
        const unreadable: string[] = [];
        // iCloud leaves a hidden `.name.icloud` stub for a file that is not on the device yet.
        const stubs = allFiles.filter(f => /^\..+\.icloud$/.test(f.name)).length;
        if (asLocal && folder) { const root = (toImport[0].webkitRelativePath || '').split('/')[0]; if (root) try { localStorage.setItem('fg_localsync_folder', root); } catch {} }
        for (let i = 0; i < toImport.length; i++) {
            const file = toImport[i];
            // webkitRelativePath gives "dirname/file.ext" for folder imports
            let rel  = file.webkitRelativePath || file.name;
            // A Local Folder is addressed from the folder's root (as with a live folder): drop the picked folder's own name.
            if (asLocal && folder && rel.includes('/')) rel = rel.slice(rel.indexOf('/') + 1);
            // Prefix with "local/" so files appear in the Local Folder column
            const path = asLocal ? 'local/' + rel : rel;
            if (asLocal) importedPaths.add(rel);
            try {
                // Photos, audio and video from a device picker can carry an extension the binary list
                // lacks (.heic, .m4a …): reading those as text would corrupt them.
                const bytes = await _readBytesWithin(file, UPLOAD_READ_MS);
                if (_isBinaryExt(path) || (/^(image|audio|video)\//.test(file.type) && file.type !== 'image/svg+xml')) {
                    await writeWorkspaceFile(path, _uint8ToBase64(bytes), null, 'base64');
                } else {
                    const text = decodeTextBytes(bytes);
                    if (text !== null) await writeWorkspaceFile(path, text);
                    else await writeWorkspaceFile(path, _uint8ToBase64(bytes), null, 'base64');
                }
            } catch (e) {
                console.error('[workspace] upload error:', path, e);
                unreadable.push(rel);
            }
            // Yield every BATCH files so the UI thread stays responsive.
            if ((i + 1) % BATCH === 0) await new Promise<void>(r => setTimeout(r, 0));
        }
        if (asLocal) {
            _hasImportedLocal = true;
            try { await _afterLocalImport(importedPaths); } catch (e) { console.warn('[workspace] post-import bookkeeping failed:', e); }
        }
        await renderFileList();
        if (unreadable.length || stubs) {
            const list = unreadable.slice(0, 8).join('\n') + (unreadable.length > 8 ? `\n…and ${unreadable.length - 8} more` : '');
            alert(`${unreadable.length + stubs} file${unreadable.length + stubs === 1 ? ' was' : 's were'} not imported because iCloud has not downloaded ${unreadable.length + stubs === 1 ? 'it' : 'them'} to this device.\n`
                + `In Files, long-press the folder and choose Download Now (Finder: Download Now), then import again.${list ? '\n\n' + list : ''}`);
        }
        // Merge on import: when the folder brought files that are new or differ from the Workspace's, show the diff.
        if (asLocal) openLocalSyncDialog({ onlyIfIncoming: true }).catch(() => {});
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
                    await _storeUploadedText(path, file);
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

// The id a saved project is stored under. Letters and digits of any script count: reducing the name to a-z0-9 gave every
// Persian, Japanese or Hindi project name the same id, so saving one replaced another.
function _projectSlug(name) {
    return (name || 'project').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'project';
}

// The localStorage keys that belong to a project's chats. Anything else (settings, API keys,
// role bodies that run as JavaScript) is out of project scope.
function _isProjectChatKey(k: string): boolean {
    return k === 'fg_chat_list' || k === 'fg_active_chat' || k.startsWith('fg_chat_') || k.startsWith('fg_draft_');
}

// A chat's rendered-message HTML. The app writes it from its own DOM, but a project file is
// external input, so it is never restored: the view is rebuilt from the validated history.
const _isChatHtmlSnapshot = (k: string) => /^fg_chat_.+_msgs$/.test(k);

function _chatKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && _isProjectChatKey(k)) keys.push(k);
    }
    return keys;
}

async function _collectProjectData(name) {
    const wsFiles = await listWorkspaceFiles();
    const chatData = {};
    for (const k of _chatKeys()) chatData[k] = localStorage.getItem(k);
    // localStorage caches only the most recent chats' history — read the rest from IndexedDB.
    if (typeof getChatList === 'function' && typeof sessionLoadHistory === 'function') {
        for (const c of getChatList()) {
            const k = `fg_chat_${c.id}_oh`;
            const h = await sessionLoadHistory(c.id);
            if (!h?.length) continue;
            // A cached copy may be a trimmed snapshot of the stored history; keep the longer one.
            // The cache is kept only when it is newer than the stored copy (its last save was not acknowledged by the store): comparing lengths picked the
            // older, longer history after a rewind, or the old answer after an edit (codex R15-001).
            if (chatData[k] != null && (window as any).chatCacheIsNewer?.(c.id)) continue;
            chatData[k] = JSON.stringify(h);
        }
    }
    return {
        fg_project: '1.0',
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
        // Resolved when the transaction has committed, not when the request was queued: an abort after that (quota) left the old backup while the
        // caller said "Saved" (codex R17-001).
        const tx = db.transaction(PROJ_STORE, 'readwrite');
        tx.objectStore(PROJ_STORE).put(data);
        tx.oncomplete = () => resolve();
        tx.onabort    = () => reject(tx.error ?? new Error('The project could not be saved (storage full?)'));
        tx.onerror    = () => { /* the abort that follows rejects */ };
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
    if (typeof CompressionStream === 'undefined') return null;
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    // Start draining the readable side before writing — avoids backpressure deadlock on large payloads
    const outPromise = new Response(cs.readable).arrayBuffer();
    await writer.write(bytes);
    await writer.close();
    return outPromise;
}

async function _gunzipToJson(buffer) {
    if (typeof DecompressionStream === 'undefined') {
        // Older Safari/iPad: no native streams, decode in JS.
        return JSON.parse(new TextDecoder().decode(gunzipSync(new Uint8Array(buffer))));
    }
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const textPromise = new Response(ds.readable).text();
    // Damaged data rejects the writer's promises and the reader's together. Each rejection must be observed or the
    // browser reports an unhandled one; the reader's carries the cause, so it is the one awaited.
    textPromise.catch(() => {});
    writer.write(new Uint8Array(buffer)).catch(() => {});
    writer.close().catch(() => {});
    let text: string;
    try { text = await textPromise; }
    catch { throw new Error('The compressed project file is damaged and cannot be read.'); }
    return JSON.parse(text);
}

async function _documentLibrary(name: 'pdfjsLib' | 'mammoth' | 'XLSX', selector: string): Promise<any> {
    const value = () => (globalThis as any)[name];
    if (value()) return value();
    let script = document.querySelector(selector) as HTMLScriptElement | null;
    // A reader whose download failed is fetched again: its failed element would stay failed for the life of the page, so
    // "check the connection and attach again" could never work without a reload.
    if (script?.dataset.loadFailed) {
        const fresh = document.createElement('script');
        for (const a of ['src', 'integrity', 'crossorigin']) { const v = script.getAttribute(a); if (v != null) fresh.setAttribute(a, v); }
        fresh.async = true;
        fresh.onerror = () => { fresh.dataset.loadFailed = '1'; };
        script.replaceWith(fresh);
        script = fresh;
    }
    if (!script) throw new Error(`${name} document reader could not load; check the connection and attach again`);
    await new Promise<void>((resolve, reject) => {
        const clean = () => { clearTimeout(timer); script.removeEventListener('load', loaded); script.removeEventListener('error', failed); };
        const loaded = () => { clean(); value() ? resolve() : reject(new Error(`${name} document reader is unavailable`)); };
        const failed = () => { clean(); script!.dataset.loadFailed = '1'; reject(new Error(`${name} document reader could not load; check the connection and attach again`)); };
        const timer = setTimeout(() => { clean(); reject(new Error(`${name} document reader did not load within 20 seconds`)); }, 20_000);
        script.addEventListener('load', loaded, { once: true });
        script.addEventListener('error', failed, { once: true });
        if (value()) loaded();
    });
    return value();
}

// Strict document extraction for attachments: failures must be visible, not a
// filename-only placeholder that looks like successful model input.
export async function extractDocumentText(name: string, base64Content: string): Promise<string> {
    const bytes = _base64ToUint8(base64Content);
    const ext = _extOf(name);
    if (ext === '.pdf') {
        const lib = await _documentLibrary('pdfjsLib', 'script[src*="pdfjs-dist@"]');
        if (!lib.GlobalWorkerOptions.workerSrc)
            lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/legacy/build/pdf.worker.min.js';
        const task = lib.getDocument({ data: bytes, isEvalSupported: false });
        let pdf: any;
        try {
            pdf = await task.promise;
            const pages: string[] = [];
            let chars = 0;
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                try {
                    const tc = await page.getTextContent();
                    const text = tc.items.map(it => it.str || '').join(' ');
                    pages.push(text); chars += text.length;
                } finally { page.cleanup?.(); }
                if (chars >= 50_000) { pages.push('[Remaining pages omitted: attachment text limit]'); break; }
            }
            return pages.join('\n\n');
        } finally { if (pdf) await pdf.destroy(); else await task.destroy?.(); }
    }
    if (ext === '.docx') {
        // Read word/document.xml directly (line breaks kept); mammoth is the fallback for what that cannot read.
        try { const text = docxText(bytes); if (text.trim()) return text; } catch { /* not a package we can read */ }
        const lib = await _documentLibrary('mammoth', 'script[src*="mammoth@"]');
        return (await lib.extractRawText({ arrayBuffer: bytes.buffer })).value;
    }
    if (['.xlsx', '.xls', '.ods'].includes(ext)) {
        const lib = await _documentLibrary('XLSX', 'script[src*="xlsx@"]');
        const wb = lib.read(await fixXlsxCharRefs(bytes), { type: 'array' });
        return wb.SheetNames.map(sn => `Sheet: ${sn}\n${lib.utils.sheet_to_csv(wb.Sheets[sn])}`).join('\n\n');
    }
    if (ext === '.pptx') {
        const text = pptxSlides(bytes).map((t, i) => `Slide ${i + 1}\n${t}`).join('\n\n');
        return text;
    }
    if (ext === '.odt' || ext === '.odp') return odfText(bytes);
    throw new Error(`Text extraction is not supported for ${ext || 'this document type'}`);
}
async function _extractDocText(name, base64Content) {
    try { return await extractDocumentText(name, base64Content); }
    catch (error) { return `[Document extraction failed for ${name}: ${error.message}]`; }
}


// A project file is checked completely before anything is replaced: the restore clears the workspace
// first, so a structure that fails halfway used to leave the user with neither project.
export function validateProjectData(data: any): void {
    if (!data || typeof data !== 'object') throw new Error('The file is not a project.');
    if (data.workspace !== undefined && !Array.isArray(data.workspace))
        throw new Error('The project\'s workspace must be a list of files.');
    for (const [i, f] of (data.workspace || []).entries()) {
        if (!f || typeof f !== 'object') throw new Error(`Workspace entry ${i + 1} is not a file.`);
        if (typeof f.name !== 'string' || !f.name.trim()) throw new Error(`Workspace entry ${i + 1} has no file name.`);
        if (typeof f.content !== 'string') throw new Error(`Workspace file "${f.name}" has no text content.`);
        if (f.encoding != null && f.encoding !== 'base64') throw new Error(`Workspace file "${f.name}" has an unknown encoding.`);
    }
    if (data.chatData !== undefined && (data.chatData === null || typeof data.chatData !== 'object' || Array.isArray(data.chatData)))
        throw new Error('The project\'s chat data is not valid.');
}

// A running turn belongs to the project being replaced: its tool calls would write into the imported
// workspace and its messages into the imported chat. Stop it and wait for it to wind down first.
async function _stopTurnsBeforeReplace(): Promise<boolean> {
    return (await (window as any).stopTurnAndWait?.()) !== false;
}

// Bumped when a project is cleared or replaced. A write that started before that must not land afterwards: it would
// put the old project's file into the new one (agentWriteFile checks it just before it commits).
let _workspaceGeneration = 0;

// What belongs to the project that is being cleared or replaced: messages queued behind the stopped turn, the text typed
// in the composer (which createNewChat would save again under the old chat), its attachments, and the open editors
// with their unsaved buffers. The user has already confirmed the operation, so none of it asks again.
function _discardProjectUiState(): void {
    const w = window as any;
    w.msgQueue?.clear?.();
    const input = document.getElementById('agent-input');
    if (input) w._setInputText?.(input, '');
    w.clearImageAttachments?.(); w.clearParkedAttachments?.();
    w.closeAllFileTabs?.();
}

async function _restoreProjectData(data) {
    validateProjectData(data);
    if (!(await _stopTurnsBeforeReplace())) throw new Error('Import cancelled: Autopilot is still running.');
    // The new workspace replaces the old one in ONE transaction: the clear and every file commit together, or the old workspace stays exactly as it was
    // (the clear was its own transaction, then one per file: a failure part-way left the new project half in and the old one gone, and an aborted
    // clear was taken for a successful one: codex R30-001, opencode §10). Before anything else is touched, so a failure leaves the page as it was.
    await applyWorkspaceBatch((data.workspace || []).map((f: any) => ({ name: f.name, content: f.content, encoding: f.encoding || null, lastModified: f.lastModified })), [], { clearAll: true });
    _workspaceGeneration++; bumpWorkspaceEpoch();
    _discardProjectUiState();
    // Snapshot all settings (API keys, model config, etc.) before touching anything.
    // Something in the restore chain can trigger saveSettings() with empty form fields;
    // this ensures settings survive the operation regardless.

    // Silently drop the local folder connection without triggering a premature renderFileList.
    // (closeFsaFolder() calls renderFileList() internally before we've written the new files.)
    if (fsaHandle) {
        stopFsaSync();
        fsaHandle = null;
        pendingFsaHandle = null;
        clearFsaHandle().catch(() => {});
        updateFsaBadge();
    }
    // Restore chat data to localStorage
    const replacedChatIds: string[] = typeof getChatList === 'function' ? getChatList().map((c: any) => c.id) : [];
    for (const k of _chatKeys()) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(data.chatData || {})) {
        if (typeof v !== 'string') continue;
        if (!_isProjectChatKey(k) || _isChatHtmlSnapshot(k)) continue;
        // History goes to IndexedDB, which loadChatHistory reads first; the localStorage copy
        // is a cache that may not fit for every chat (saveHistory prunes it to recent chats).
        const oh = /^fg_chat_(.+)_oh$/.exec(k);
        if (oh && typeof sessionSaveHistory === 'function') {
            try { sessionSaveHistory(oh[1], JSON.parse(v as string)); } catch {}
        }
        try { localStorage.setItem(k, v as string); } catch {}
    }
    // The session store still held the replaced project's chats and, after a reload, brought them back next to the restored ones (opencode §10):
    // the chats that are not in the restored project are deleted there, and the list it keeps is the restored one.
    try {
        const kept = new Set((typeof getChatList === 'function' ? getChatList() : []).map((c: any) => c.id));
        for (const id of replacedChatIds) if (!kept.has(id)) sessionDeleteChat?.(id);
        sessionSyncChatList?.(typeof getChatList === 'function' ? getChatList() : []);
    } catch {}
    // A restored chat that has no saved history is empty: its stored history, from before the restore or from later work, must go too
    // (loadChatHistory reads the durable copy first, so it would bring that back).
    if (typeof sessionSaveHistory === 'function') {
        try {
            for (const c of (typeof getChatList === 'function' ? getChatList() : [])) {
                if (!(`fg_chat_${c.id}_oh` in (data.chatData || {}))) await sessionSaveHistory(c.id, []);
            }
        } catch {}
    }
    // Update project name input
    const nameInput = document.getElementById('project-name-input') as HTMLInputElement | null;
    if (nameInput) nameInput.value = data.name || '';
    localStorage.setItem('fg_project_name', data.name || '');
    // Refresh in-memory state
    const activeId = localStorage.getItem('fg_active_chat') || '';
    // Loading until the restored chat's history and messages are in place (no Send, no save of the emptied history meanwhile).
    const endChatLoad = activeId && typeof (window as any).beginChatLoad === 'function' ? (window as any).beginChatLoad(activeId) as () => void : () => {};
    try {
    setActiveChatId(activeId);
    lastUserMessageText = '';
    setLastProvider('');
    // An import with no chat leaves no active chat: the replaced project's conversation must not stay in
    // memory, where the next message would send it to the model.
    if (!activeId) { clearChatHistory(); (window as any).cancelPendingApprovals?.(); (window as any).clearImageAttachments?.(); }
    // The replaced conversation must not survive in memory when the restored chat is empty.
    if (activeId) clearChatHistory();
    // Awaited: the view is rebuilt from this history below, and a still-loading one left a notice-only blank chat (codex 309/310).
    if (typeof loadChatHistory === 'function' && activeId) await loadChatHistory(activeId);
    await renderFileList();
    const msgEl = typeof getMessagesEl === 'function' ? getMessagesEl() : null;
    if (msgEl) msgEl.innerHTML = '';
    if (typeof restoreChatMessages === 'function' && activeId) {
        const ok = await restoreChatMessages(activeId);
        if (!ok && typeof renderHistoryFallback === 'function') renderHistoryFallback();
    }
    } finally { endChatLoad(); }
    if (typeof updateChatNameBar  === 'function') updateChatNameBar();
    if (typeof updateTokenLabel   === 'function') updateTokenLabel();
    // The restored active chat's unsent draft goes into the composer (an empty composer would later be flushed over the
    // stored draft when the user switches chats), and the recent-chats rail lists the restored chats.
    try { (window as any)._restoreDraft?.(activeId); } catch {}
    try { (window as any).updateRailRecentChats?.(); } catch {}
    loadAgentsContext?.();
    loadSkills?.();
    // The board still showed the replaced workspace's tasks until something else refreshed it.
    try { await (window as any).syncLedgerWithTaskFiles?.(); } catch { try { await (window as any).refreshTasks?.(); } catch {} }

}

function _showFolderPrompt(projectName, folderName, projectId) {
    const suppressKey = `fg_project_no_folder_prompt_${projectId}`;
    if (localStorage.getItem(suppressKey) === '1') return;
    const ov = document.createElement('div');
    ov.className = 'fg-modal-overlay';
    ov.innerHTML = `<div class="fg-modal fg-modal-sm">
        <div class="fg-modal-header"><span class="fg-modal-title">Local folder</span></div>
        <div class="fg-modal-body">
          <p>Project <strong>${escapeHtml(projectName)}</strong> was saved with local folder <code>${escapeHtml(folderName)}</code>. Open a local folder now?</p>
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
            <li>All chat history, drafts and checkpoints</li>
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
        // A running turn belongs to the project being cleared: its tool calls would write into the empty project and its
        // messages into the next chat. Import and chat deletion stop it first; so does this.
        if (!(await _stopTurnsBeforeReplace())) return;
        _workspaceGeneration++; bumpWorkspaceEpoch();
        _discardProjectUiState();
            // Clear workspace files
        await ensureDB();
        await new Promise<void>((resolve, reject) => {
            const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
        _hasImportedLocal = false;
        // Close local folder
        if (fsaHandle) closeFsaFolder();
        // Clear chat history from SQLite/IDB before wiping localStorage so we still have the IDs.
        const _chatListSnap = typeof getChatList === 'function' ? getChatList() : [];
        if (typeof sessionSyncChatList === 'function') sessionSyncChatList([]);
        // Per chat: localStorage cache and draft, message HTML and checkpoint data in IndexedDB,
        // session-store history.
        for (const c of _chatListSnap) {
            if (typeof clearChatStorage === 'function') clearChatStorage(c.id);
            else if (typeof sessionDeleteChat === 'function') sessionDeleteChat(c.id);
        }
        // All checkpoints belong to this project's chats, including older ones without a chatId.
        if (typeof clearCheckpoints === 'function') clearCheckpoints();
        // Leftovers of chats missing from the list (_chatKeys: fg_chat_list, fg_active_chat, fg_chat_*, fg_draft_*)
        for (const k of _chatKeys()) localStorage.removeItem(k);
        // Reset project name
        localStorage.removeItem('fg_project_name');
        const nameInput = document.getElementById('project-name-input') as HTMLInputElement | null;
        if (nameInput) nameInput.value = '';
        // Reset in-memory state and UI
        if (typeof createNewChat === 'function') createNewChat();
        await renderFileList();
        window.refreshStorageUsage?.();
    };
}

async function saveProject() {
    const nameInput = document.getElementById('project-name-input') as HTMLInputElement | null;
    const name = (nameInput?.value || '').trim() || localStorage.getItem('fg_project_name') || 'Project';
    if (nameInput && !nameInput.value.trim()) nameInput.value = name;
    localStorage.setItem('fg_project_name', name);
    try {
        const data = await _collectProjectData(name);
        // The id is the project's name reduced to letters and digits, so "Release 1.0" and "Release 1-0" share one. Saving the same
        // name again updates its slot; a different name that maps to a taken id gets its own.
        const base = data.id;
        // A name that is already saved keeps its slot, wherever it is: after the slot that took the plain id was deleted, the same name
        // saved again used to land on the freed id and show up twice.
        const sameName = (await _idbGetAllProjects()).find(p => p.name === data.name);
        if (sameName) data.id = sameName.id;
        else for (let n = 2; n < 1000; n++) {
            const other = await _idbGetProject(data.id);
            if (!other || other.name === data.name) break;
            data.id = `${base}-${n}`;
        }
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
           <button class="fg-proj-name fg-proj-load" title="Load this project" style="background:none;border:0;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer">${escapeHtml(p.name)}</button>
           <span class="fg-proj-date">${p.savedAt?.slice(0,16).replace('T',' ') || ''}</span>
           <button class="fg-proj-delete ws-action-btn" data-del="${p.id}" aria-label="Delete ${escapeHtml(p.name)}" title="Delete this saved project">✕</button>
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
            const row = btn.closest('.fg-proj-row');
            const next = (row.nextElementSibling ?? row.previousElementSibling) as HTMLElement | null;
            row.remove();
            if (!ov.querySelector('.fg-proj-row')) ov.remove();
            else next?.querySelector<HTMLElement>('.fg-proj-load')?.focus();   // focus left with the removed row, so the dialog's keys went nowhere
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
            try { await _restoreProjectData(data); }
            catch (err: any) { alert('Load failed: ' + (err?.message ?? err)); return; }   // an unhandled rejection said nothing
            if (data.localFolderName) _showFolderPrompt(data.name, data.localFolderName, data.id);
        };
    });
}

async function exportProject() {
    const nameInput = document.getElementById('project-name-input') as HTMLInputElement | null;
    const name = (nameInput?.value || '').trim() || localStorage.getItem('fg_project_name') || 'Project';
    try {
        const data = await _collectProjectData(name);
        // What this export holds is the common starting point of a later merge of an edited copy.
        await _saveBaseTexts('project', data.workspace.map((f: any) => ({ path: f.name, content: f.content, encoding: f.encoding }))).catch(() => {});
        const buf  = await _gzipJson(data);
        const slug = _projectSlug(name);
        // No CompressionStream (older Safari): export plain JSON; import accepts it.
        const blob = buf ? new Blob([buf], { type: 'application/gzip' }) : new Blob([JSON.stringify(data)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = buf ? `${slug}.fg_project.gz` : `${slug}.fg_project.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
        console.error('[export] export failed:', e);
        alert('Export failed: ' + e.message);
    }
}

/** `mode` 'replace' swaps the workspace and chats for the file's; 'merge' brings the file's workspace files into the current one, previewed, leaving chats alone. */
async function importProject(inputEl, mode: 'replace' | 'merge' = 'replace') {
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
        if (!(data?.fg_project || data?.fwproject)) throw new Error('Not a valid FreeGent project file.');
        if (mode === 'merge') { validateProjectData(data); await _mergeProjectFiles(data); return; }
        if (!confirm(`Import project "${data.name}"? Current workspace and chat history will be replaced.`)) return;
        await _restoreProjectData(data);
        await _saveBaseTexts('project', (data.workspace || []).map((f: any) => ({ path: f.name, content: f.content, encoding: f.encoding }))).catch(() => {});
        if (data.localFolderName) _showFolderPrompt(data.name, data.localFolderName, data.id || _projectSlug(data.name));
    } catch (e) {
        alert('Import failed: ' + e.message);
    }
}

try { if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshCloudSyncButton); else refreshCloudSyncButton(); } } catch {}

// ── Window bridge ─────────────────────────────────────────────────────────────
// fsaHandle is mutable module state — expose a live accessor, not a snapshot.
Object.defineProperty(window, 'fsaHandle', { get: () => fsaHandle, configurable: true });
Object.assign(window, { documentLibrary: _documentLibrary });
Object.assign(window, { writeFsaFile, deleteFsaFile, hasLocalFolder, hasFsaFolder,
    // IDB storage (called directly in tools.js, config.js, and tests)
    getChatSnapshotInfo,
    initDB, ensureDB, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceFile, applyWorkspaceBatch,
    // Document helpers exposed for tools.js and other classic scripts
    _isBinaryExt, _isDocExt, _extOf, _uint8ToBase64, _base64ToUint8, extractDocumentText,
    // Agent file ops (called via window.X in tools.js)
    agentListFiles, agentListFilesInDir, agentHiddenDirs, agentDirExists, agentListFilesNoStat, agentReadFile, agentReadFileBytes, agentWriteFile, agentDeleteFile, agentFileMtime,
    setWorkspaceAdapter, workspaceUsesAbsolutePaths, workspaceRootDir, workspaceName,
    readFileAsDataUrl,
    getWorkspaceFilesDict: async () => {
        const recs = await listWorkspaceFiles();
        const d = Object.create(null);
        for (const r of recs) d[r.name] = r.content;
        return d;
    },
    buildPyRunnerHtml: _buildPyRunnerHtml,
    // File list UI
    renderFileList, updateSelectionUI, downloadSelected, deleteSelected,
    copyFileBetween, openLocalSyncDialog, openCloudSyncDialog, refreshCloudSyncButton, undoLastSync, exportLocalChanges, downloadFile, confirmDeleteFile, uploadFiles,
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
