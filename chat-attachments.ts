import { mimeOfExt, docKindOfExt, docKindOfMime } from './mime.js';
// chat-attachments.ts — pending image/file attachment state and UI (thumbnails, chips, drag-drop, paste).
// Depends on: nothing (pure DOM + state).

// ── Pending attachment state ──────────────────────────────────────────────────
let _attachmentGeneration = 0;
const _attachmentReads = new Set<Promise<void>>();

// Sending waits for file decoding/extraction rather than snapshotting an empty list.
// Bounded: a read that never settles must not leave the composer stuck in "send-preparing", and one
// failed read must not sink the others (each read reports its own failure as a chip error).
const ATTACHMENT_WAIT_MS = 30_000;
async function waitForAttachments(): Promise<void> {
    const deadline = Date.now() + ATTACHMENT_WAIT_MS;
    while (_attachmentReads.size && Date.now() < deadline) {
        await Promise.race([
            Promise.allSettled(Array.from(_attachmentReads)),
            new Promise(r => setTimeout(r, Math.max(0, deadline - Date.now()))),
        ]);
    }
}
function hasPendingAttachments(): boolean { return !!(_pendingImages.length || _pendingFiles.length || _attachmentReads.size); }
function warnAttachmentSendBusy(): void {
    const strip = document.getElementById('img-strip');
    if (!strip || strip.querySelector('[data-attachment-send-status]')) return;
    const status = document.createElement('div'); status.className = 'file-chip media-warn-chip';
    status.dataset.attachmentSendStatus = 'busy'; status.setAttribute('role', 'status');
    status.textContent = 'Finish or stop the current response before sending attachments. Your draft and files are kept here.';
    strip.appendChild(status); strip.style.display = 'flex';
}
function _attachmentError(name: string, error: any): void {
    const strip = document.getElementById('img-strip');
    if (!strip) return;
    const warning = document.createElement('div');
    warning.className = 'file-chip media-warn-chip';
    warning.setAttribute('role', 'alert');
    warning.textContent = `${name}: ${error?.message || 'Could not read attachment'}`;
    strip.appendChild(warning);
    strip.style.display = 'flex';
}
function _readAttachment(file: Blob, how: 'readAsText' | 'readAsDataURL'): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Empty file reader result'));
        reader.onerror = () => reject(reader.error || new Error('Could not read file'));
        reader.onabort = () => reject(new Error('File reading cancelled'));
        try { reader[how](file); } catch (error) { reject(error); }
    });
}

let _pendingImages: { mimeType: string; base64: string }[] = [];
let _pendingFiles: { name: string; mimeType: string; contentType: string; content: string; size: number; workspacePath?: string }[] = [];

// ── File attachment helpers ───────────────────────────────────────────────────

const _TEXT_EXTS = new Set([
    'txt','log','md','mdx','csv','tsv','json','jsonc','yaml','yml','toml','ini','cfg','conf','env',
    'xml','svg','html','htm','css','scss','sass','less',
    'js','mjs','cjs','ts','tsx','jsx','vue','svelte',
    'py','pyw','rb','go','rs','java','cpp','cxx','cc','c','h','hpp','cs','php','swift',
    'kt','kts','scala','groovy','lua','dart','ex','exs','clj','cljs','hs','ml','r',
    'sh','bash','zsh','fish','ps1','bat','cmd',
    'sql','graphql','gql','prisma','tf','hcl',
    'dockerfile','makefile','gitignore','dockerignore','lock','cabal',
    'tex','rst','org','adoc','wiki',
]);

const _LANG_MAP = {
    py:'python', pyw:'python', js:'javascript', mjs:'javascript', cjs:'javascript',
    ts:'typescript', tsx:'tsx', jsx:'jsx', vue:'vue', svelte:'svelte',
    rb:'ruby', go:'go', rs:'rust', java:'java', cpp:'cpp', cxx:'cpp', cc:'cpp',
    c:'c', h:'c', hpp:'cpp', cs:'csharp', php:'php', swift:'swift',
    kt:'kotlin', kts:'kotlin', scala:'scala', lua:'lua', dart:'dart', r:'r',
    sh:'bash', bash:'bash', zsh:'bash', fish:'fish', ps1:'powershell', bat:'batch',
    sql:'sql', html:'html', htm:'html', css:'css', scss:'scss', xml:'xml',
    json:'json', yaml:'yaml', yml:'yaml', toml:'toml', tf:'hcl',
    md:'markdown', tex:'latex', graphql:'graphql', prisma:'prisma',
};

function _guessMime(ext: string): string { return mimeOfExt(ext); }

function _fileIcon(mimeType: string, name: string): string {
    if (mimeType === 'application/pdf')    return '📄';
    if (mimeType.startsWith('audio/'))     return '🎵';
    if (mimeType.startsWith('video/'))     return '🎬';
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (ext === 'csv' || ext === 'tsv')    return '📊';
    if (['json','yaml','yml','toml','xml'].includes(ext)) return '{}';
    return '📝';
}

function _fmtSz(n: number): string {
    return n >= 1048576 ? `${(n/1048576).toFixed(1)} MB`
         : n >= 1024    ? `${(n/1024).toFixed(0)} KB`
         : `${n} B`;
}

function _audioFmt(mimeType: string): string {
    const m = { 'audio/mpeg':'mp3', 'audio/mp3':'mp3', 'audio/wav':'wav',
                'audio/ogg':'ogg', 'audio/flac':'flac', 'audio/mp4':'mp4',
                'audio/aac':'aac', 'audio/webm':'webm', 'audio/aiff':'aiff' };
    return m[mimeType] || 'mp3';
}

function _addFileChip(att: any): void {
    const strip = document.getElementById('img-strip');
    if (!strip) return;
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.title = `${att.name} · ${_fmtSz(att.size)}`;
    const nameShort = att.name.length > 26 ? att.name.slice(0, 23) + '…' : att.name;
    const icon = document.createElement('span'); icon.className = 'file-chip-icon'; icon.textContent = _fileIcon(att.mimeType, att.name);
    const label = document.createElement('span'); label.className = 'file-chip-name'; label.textContent = nameShort;
    chip.append(icon, label);
    const rm = document.createElement('button');
    rm.className = 'img-remove-btn'; rm.textContent = '×'; rm.title = 'Remove';
    rm.onclick = () => {
        const i = _pendingFiles.indexOf(att);
        if (i >= 0) _pendingFiles.splice(i, 1);
        chip.remove();
        if (!strip.children.length) strip.style.display = 'none';
    };
    chip.appendChild(rm);
    strip.appendChild(chip);
    strip.style.display = 'flex';
}

// ── Public API ────────────────────────────────────────────────────────────────

function addImageAttachment(mimeType: string, base64: string): void {
    const imgObj = { mimeType, base64 };
    _pendingImages.push(imgObj);
    const strip = document.getElementById('img-strip');
    if (!strip) return;
    const wrap = document.createElement('div');
    wrap.className = 'img-thumb-wrap';
    const img = document.createElement('img');
    img.className = 'img-thumb'; img.alt = 'attachment';
    img.src = `data:${mimeType};base64,${base64}`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'img-remove-btn'; removeBtn.textContent = '×'; removeBtn.title = 'Remove';
    removeBtn.onclick = () => {
        const i = _pendingImages.indexOf(imgObj);
        if (i >= 0) _pendingImages.splice(i, 1);
        wrap.remove();
        if (!strip.children.length) strip.style.display = 'none';
    };
    wrap.append(img, removeBtn);
    strip.appendChild(wrap);
    strip.style.display = 'flex';
}

function clearImageAttachments(): void {
    _attachmentGeneration++;
    _attachmentReads.clear();
    _pendingImages = [];
    _pendingFiles  = [];
    const strip = document.getElementById('img-strip');
    if (strip) { strip.innerHTML = ''; strip.style.display = 'none'; }
}

// Returns snapshots of the pending arrays for callers that need to read state
// (saveCheckpoint, agentSend) without exposing the mutable arrays directly.
function getPendingAttachments(): {
    images: { mimeType: string; base64: string }[];
    files: { name: string; mimeType: string; contentType: string; content: string; size: number; workspacePath?: string }[];
} {
    return { images: [..._pendingImages], files: [..._pendingFiles] };
}

// Restores a saved attachment entry into pending state (used by rerunCheckpoint and
// _startEditUserMsg when replaying a turn with previously-attached files).
function restoreFileAttachment(att: { name: string; mimeType: string; contentType: string; content: string; size: number; workspacePath?: string }): void {
    _pendingFiles.push(att);
    _addFileChip(att);
}

function addFileAttachment(file: File): Promise<void> {
    const generation = _attachmentGeneration;
    const strip = document.getElementById('img-strip');
    const loading = document.createElement('div');
    loading.className = 'file-chip attachment-loading'; loading.setAttribute('role', 'status');
    loading.textContent = `Reading ${file.name}…`;
    if (strip) { strip.appendChild(loading); strip.style.display = 'flex'; }
    const read = _loadFileAttachment(file, generation);
    _attachmentReads.add(read);
    // Attach a rejection handler even when the caller is an inline event handler.
    void read.then(() => { loading.remove(); _attachmentReads.delete(read); }, error => {
        loading.remove(); _attachmentReads.delete(read);
        if (generation === _attachmentGeneration) _attachmentError(file.name, error);
    });
    return read;
}
async function _loadFileAttachment(file: File, generation: number): Promise<void> {
    const name = file.name;
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const mimeType = file.type && file.type !== 'application/octet-stream' ? file.type : _guessMime(ext);
    const isText = mimeType.startsWith('text/')
        || ['application/json','application/xml','application/javascript','application/typescript','application/yaml','image/svg+xml'].includes(mimeType)
        || _TEXT_EXTS.has(ext);
    const docExt = docKindOfExt(ext) ?? (!_TEXT_EXTS.has(ext) ? docKindOfMime(mimeType) : undefined);
    if (!isText && file.size > 25 * 1024 * 1024) throw new Error('Binary attachment exceeds the 25 MB limit');
    const current = () => generation === _attachmentGeneration;
    if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
        const url = await _readAttachment(file, 'readAsDataURL');
        if (current()) addImageAttachment(mimeType, url.slice(url.indexOf(',') + 1));
        return;
    }

    let content: string, contentType: string, original: string | null = null;
    if (isText) {
        // FileReader also works on Safari versions without Blob.text().
        content = await _readAttachment(file.size > 200_000 ? file.slice(0, 200_000, file.type) : file, 'readAsText');
        contentType = 'text';
    } else {
        const url = await _readAttachment(file, 'readAsDataURL');
        content = url.slice(url.indexOf(',') + 1);
        original = content;
        if (docExt) {
            if (typeof extractDocumentText !== 'function') throw new Error('Document reader is not ready; try attaching again');
            content = await extractDocumentText(docExt === ext ? name : `${name}.${docExt}`, content);
            if (!content.trim()) throw new Error('No readable text in this document; image-only documents need OCR');
            contentType = 'text';
        } else contentType = 'binary';
    }
    if (!current()) return;
    if (contentType === 'text' && content.length > 50_000) content = content.slice(0, 50_000) + '\n…[truncated — showing first 50,000 characters]';
    let workspacePath: string | undefined;
    if (original && typeof agentWriteFile === 'function') {
        // Last path segment only, with dot-segments dropped, so a hostile name cannot leave attachments/.
        const basename = name.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..').pop() || 'attachment';
        workspacePath = `attachments/${Date.now()}-${Math.random().toString(36).slice(2, 10)}/${basename}`;
        if (!current()) return;   // composer was cleared while reading: don't write a file nothing references
        await agentWriteFile(workspacePath, original, 'base64');
        if (!current()) { await agentDeleteFile?.(workspacePath).catch(() => {}); return; }
    }
    const att = { name, mimeType, contentType, content, size: file.size, ...(workspacePath ? { workspacePath } : {}) };
    _pendingFiles.push(att);
    _addFileChip(att);
}

let _chatDropZoneSetup = false;
function setupChatDropZone(): void {
    if (_chatDropZoneSetup) return;
    const chatPanel = document.querySelector('#tab-content [data-panel="chat"]') as HTMLElement | null;
    const overlay   = document.getElementById('chat-drop-overlay');
    if (!chatPanel) return;
    _chatDropZoneSetup = true;

    chatPanel.addEventListener('dragover', e => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        overlay?.classList.add('active');
    });
    chatPanel.addEventListener('dragleave', e => {
        if (e.relatedTarget && chatPanel.contains(e.relatedTarget as Node)) return;
        overlay?.classList.remove('active');
    });
    chatPanel.addEventListener('drop', async e => {
        e.preventDefault();
        overlay?.classList.remove('active');
        for (const file of Array.from(e.dataTransfer?.files || []))
            await addFileAttachment(file).catch(() => {});
    });
}

// Paste any file (image or otherwise) into the chat tab
document.addEventListener('paste', e => {
    const items = Array.from(e.clipboardData?.items || []).filter(i => i.kind === 'file');
    const fromItems = items.map(item => item.getAsFile()).filter((file): file is File => !!file);
    const files = fromItems.length ? fromItems : Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    const chatPanel = document.querySelector('#tab-content [data-panel="chat"]') as HTMLElement | null;
    if (!chatPanel?.classList.contains('active')) return;
    e.preventDefault();
    for (const file of files) void addFileAttachment(file).catch(() => {});
});

Object.assign(window, {
    addImageAttachment, clearImageAttachments, addFileAttachment, waitForAttachments, hasPendingAttachments, warnAttachmentSendBusy,
    setupChatDropZone, restoreFileAttachment, getPendingAttachments,
    _guessMime, _fileIcon, _fmtSz, _LANG_MAP, _audioFmt,
});
