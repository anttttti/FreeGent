import { mimeOfExt, docKindOfExt, docKindOfMime, MODEL_IMAGE_MIMES } from './mime.js';
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
// Attachments whose read failed, per chat, until the next send takes them: the warning chip goes away when the send clears the
// composer, but the model and the transcript must still be told that the file did not arrive.
const _failedReads: { owner: string | null; text: string }[] = [];
function takeAttachmentFailures(): string[] {
    const mine = _failedReads.filter(f => f.owner === _readerChat());
    for (const f of mine) _failedReads.splice(_failedReads.indexOf(f), 1);
    return mine.map(f => f.text);
}
// One read can fail on two paths (the reader's own rejection and the caller that awaited it): report it once.
const _reportedErrors = new WeakSet<object>();
function _showAttachmentWarning(text: string): void {
    const strip = document.getElementById('img-strip');
    if (!strip) return;
    const warning = document.createElement('div');
    warning.className = 'file-chip media-warn-chip';
    warning.setAttribute('role', 'alert');
    warning.textContent = text;
    strip.appendChild(warning);
    strip.style.display = 'flex';
}
// `owner`: the chat the file was chosen in. A read that fails after the reader moved to another chat belongs to the chat it was
// started in (its chip and its note to the model), not to the one that happens to be open when the failure arrives.
function _attachmentError(name: string, error: any, owner: string | null = _readerChat()): void {
    if (error && typeof error === 'object') { if (_reportedErrors.has(error)) return; _reportedErrors.add(error); }
    const text = `${name}: ${error?.message || 'Could not read attachment'}`;
    _failedReads.push({ owner, text });
    if (owner !== _readerChat() && owner) { _parkFor(owner).warnings.push(text); return; }   // shown when the reader comes back
    _showAttachmentWarning(text);
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

type _Img = { mimeType: string; base64: string; name?: string; workspacePath?: string };
let _pendingImages: _Img[] = [];
let _pendingFiles: { name: string; mimeType: string; contentType: string; content: string; size: number; workspacePath?: string }[] = [];

// Vision APIs take PNG, JPEG, GIF and WebP. Other rasters (BMP, AVIF, ICO, HEIC, TIFF …) are decoded by the
// browser and re-encoded as PNG for the model; null when this browser cannot decode the format.
async function _rasterToPng(dataUrl: string): Promise<{ mimeType: string; base64: string } | null> {
    try {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const MAX = 2048, scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL('image/png');
        return out.startsWith('data:image/png') ? { mimeType: 'image/png', base64: out.slice(out.indexOf(',') + 1) } : null;
    } catch { return null; }
}

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
    if (mimeType.startsWith('image/'))     return '🖼️';
    if (mimeType.startsWith('audio/'))     return '🎵';
    if (mimeType.startsWith('video/'))     return '🎬';
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (ext === 'csv' || ext === 'tsv' || ['xlsx','xls','ods'].includes(ext)) return '📊';
    if (['pptx','ppt','odp'].includes(ext)) return '📽️';
    if (['docx','doc','odt','rtf'].includes(ext)) return '📄';
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
                'audio/aac':'aac', 'audio/webm':'webm', 'audio/aiff':'aiff',
                'audio/x-wav':'wav', 'audio/wave':'wav', 'audio/x-aiff':'aiff', 'audio/x-flac':'flac' };
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

function addImageAttachment(mimeType: string, base64: string, extra: { name?: string; workspacePath?: string } = {}): void {
    const imgObj: _Img = { mimeType, base64, ...extra };
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

// A read that is still running belongs to the chat it was started in. Leaving the chat parks its attachments
// (parkPendingAttachments), and a read in flight then survives: it finishes into that chat's parked set, so the
// file is there when the reader comes back. Anything else that empties the composer (a send, Clear) cancels it.
type _ReadToken = { owner: string | null; cancelled: boolean; survives: boolean; read?: Promise<void>; name?: string };
const _readTokens = new Set<_ReadToken>();
const _readerChat = (): string | null => (globalThis as any).activeChatId ?? null;

function clearImageAttachments(): void {
    _attachmentGeneration++;
    for (const t of _readTokens) if (!t.survives) t.cancelled = true;
    _attachmentReads.clear();
    _pendingImages = [];
    _pendingFiles  = [];
    // Failure notes still waiting for the next send belong to the composer being emptied (a send has taken its own already).
    for (let i = _failedReads.length - 1; i >= 0; i--) if (_failedReads[i].owner === _readerChat()) _failedReads.splice(i, 1);
    const strip = document.getElementById('img-strip');
    if (strip) { strip.innerHTML = ''; strip.style.display = 'none'; }
}

// Pending attachments belong to the chat they were chosen in: switching chats parks them (in memory, per chat)
// and switching back puts the chips back, like the text draft. Before this the draft came back and the file
// did not, so a restored draft was sent without the attachment its author had chosen.
const _parkedAttachments = new Map<string, { images: _Img[]; files: typeof _pendingFiles; warnings: string[] }>();
function parkPendingAttachments(chatId: string | null | undefined): void {
    if (!chatId) return;
    for (const t of _readTokens) if (t.owner === chatId) t.survives = true;   // reads still running follow their chat
    const warnings = _parkedAttachments.get(chatId)?.warnings ?? [];
    if (_pendingImages.length || _pendingFiles.length || warnings.length) _parkedAttachments.set(chatId, { images: [..._pendingImages], files: [..._pendingFiles], warnings: [...warnings] });
    else _parkedAttachments.delete(chatId);
}
/** Forget every parked attachment and cancel every read (Clear project: they belong to the project that is going). */
function clearParkedAttachments(): void {
    _parkedAttachments.clear();
    _failedReads.length = 0;
    for (const t of _readTokens) t.cancelled = true;
}
function _parkFor(chatId: string): { images: _Img[]; files: typeof _pendingFiles; warnings: string[] } {
    let p = _parkedAttachments.get(chatId);
    if (!p) { p = { images: [], files: [], warnings: [] }; _parkedAttachments.set(chatId, p); }
    return p;
}
function restoreParkedAttachments(chatId: string | null | undefined): void {
    const parked = chatId ? _parkedAttachments.get(chatId) : null;
    if (!parked) return;
    _parkedAttachments.delete(chatId!);
    for (const img of parked.images) addImageAttachment(img.mimeType, img.base64, { name: img.name, workspacePath: img.workspacePath });
    for (const f of parked.files) restoreFileAttachment(f);
    for (const w of parked.warnings) _showAttachmentWarning(w);
}
// A read still running when the reader returns to its chat is waited for again and shown again, so a Send does not go out
// without a file the reader already chose (the file would otherwise turn up afterwards, attached to a later turn).
function resumePendingReads(chatId: string | null | undefined): void {
    if (!chatId) return;
    const strip = document.getElementById('img-strip');
    for (const t of _readTokens) {
        if (t.owner !== chatId || !t.survives || !t.read || t.cancelled) continue;
        t.survives = false;
        _attachmentReads.add(t.read);
        if (strip) {
            const chip = document.createElement('div');
            chip.className = 'file-chip attachment-loading'; chip.setAttribute('role', 'status');
            chip.textContent = `Reading ${t.name ?? 'file'}…`;
            strip.appendChild(chip); strip.style.display = 'flex';
            void t.read.then(() => chip.remove(), () => chip.remove());
        }
    }
}

// Returns snapshots of the pending arrays for callers that need to read state
// (saveCheckpoint, agentSend) without exposing the mutable arrays directly.
function getPendingAttachments(): {
    images: _Img[];
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

function addFileAttachment(file: File, existingPath?: string): Promise<void> {
    const token: _ReadToken = { owner: _readerChat(), cancelled: false, survives: false };
    _readTokens.add(token);
    const strip = document.getElementById('img-strip');
    const loading = document.createElement('div');
    loading.className = 'file-chip attachment-loading'; loading.setAttribute('role', 'status');
    loading.textContent = `Reading ${file.name}…`;
    if (strip) { strip.appendChild(loading); strip.style.display = 'flex'; }
    const read = _loadFileAttachment(file, token, existingPath);
    token.read = read; token.name = file.name;
    _attachmentReads.add(read);
    // Attach a rejection handler even when the caller is an inline event handler.
    void read.then(() => { loading.remove(); _attachmentReads.delete(read); _readTokens.delete(token); }, error => {
        loading.remove(); _attachmentReads.delete(read); _readTokens.delete(token);
        if (!token.cancelled) _attachmentError(file.name, error, token.owner);
    });
    return read;
}
// existingPath: the file already lives in the workspace there (Select mode), so no copy is written.
async function _loadFileAttachment(file: File, token: _ReadToken, existingPath?: string): Promise<void> {
    const name = file.name;
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const mimeType = file.type && file.type !== 'application/octet-stream' ? file.type : _guessMime(ext);
    const isText = mimeType.startsWith('text/')
        || ['application/json','application/xml','application/javascript','application/typescript','application/yaml','image/svg+xml'].includes(mimeType)
        || _TEXT_EXTS.has(ext);
    const docExt = docKindOfExt(ext) ?? (!_TEXT_EXTS.has(ext) ? docKindOfMime(mimeType) : undefined);
    if (!isText && file.size > 25 * 1024 * 1024) throw new Error('Binary attachment exceeds the 25 MB limit');
    const current = () => !token.cancelled;
    let imageUrl: string | undefined, sendImage: { mimeType: string; base64: string } | undefined;
    if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
        imageUrl = await _readAttachment(file, 'readAsDataURL');
        if (!current()) return;
        const base64 = imageUrl.slice(imageUrl.indexOf(',') + 1);
        sendImage = MODEL_IMAGE_MIMES.has(mimeType) ? { mimeType, base64 } : (await _rasterToPng(imageUrl)) ?? undefined;
        if (!current()) return;
    }
    // A raster the browser cannot decode (HEIC outside Safari, TIFF) is attached as a file instead: the model
    // is told its workspace path rather than receiving an image part the API would reject.
    if (imageUrl && sendImage) {
        const base64 = imageUrl.slice(imageUrl.indexOf(',') + 1);
        // Also store the image in the workspace, so tools can open it and the agent can move or
        // save it (as for other binary attachments); the model sees the pixels via the message.
        let workspacePath: string | undefined = existingPath;
        if (!existingPath && typeof agentWriteFile === 'function') {
            const basename = name.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..').pop() || 'image';
            workspacePath = `attachments/${Date.now()}-${Math.random().toString(36).slice(2, 10)}/${basename}`;
            try {
                await agentWriteFile(workspacePath, base64, 'base64');
                if (!current()) { await agentDeleteFile?.(workspacePath).catch(() => {}); return; }
            } catch { workspacePath = undefined; }
        }
        const extra = { name, ...(workspacePath ? { workspacePath } : {}) };
        if (token.owner !== _readerChat()) _parkFor(token.owner!).images.push({ mimeType: sendImage.mimeType, base64: sendImage.base64, ...extra });   // finished in another chat
        else addImageAttachment(sendImage.mimeType, sendImage.base64, extra);
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
    if (contentType === 'text' && content.length > 50_000) {
        // Do not cut between the two halves of a surrogate pair: a lone high surrogate is malformed Unicode in the request.
        let cut = 50_000;
        const last = content.charCodeAt(cut - 1);
        if (last >= 0xd800 && last <= 0xdbff) cut--;
        content = content.slice(0, cut) + '\n…[truncated — showing first 50,000 characters]';
    }
    let workspacePath: string | undefined = existingPath;
    if (!existingPath && original && typeof agentWriteFile === 'function') {
        // Last path segment only, with dot-segments dropped, so a hostile name cannot leave attachments/.
        const basename = name.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..').pop() || 'attachment';
        workspacePath = `attachments/${Date.now()}-${Math.random().toString(36).slice(2, 10)}/${basename}`;
        if (!current()) return;   // composer was cleared while reading: don't write a file nothing references
        await agentWriteFile(workspacePath, original, 'base64');
        if (!current()) { await agentDeleteFile?.(workspacePath).catch(() => {}); return; }
    }
    const att = { name, mimeType, contentType, content, size: file.size, ...(workspacePath ? { workspacePath } : {}) };
    if (token.owner !== _readerChat()) { _parkFor(token.owner!).files.push(att); return; }   // finished in another chat
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

// ── Attach menu: Attach (device camera / photos) · Upload (any file) · Select (workspace file) ──
function toggleAttachMenu(ev?: Event): void {
    ev?.stopPropagation();
    const menu = document.getElementById('attach-menu');
    if (!menu) return;
    menu.classList.toggle('open');
    menu.style.bottom = '';
    if (!menu.classList.contains('open') || menu.classList.contains('down')) return;
    // Open it above the composer's text field rather than over it (on a phone the field sits right above the button, and the menu hid
    // its top 44-65 px), when the screen has room for that.
    const input = document.getElementById('agent-input');
    const wrap = menu.parentElement;
    if (!input || !wrap) return;
    const wr = wrap.getBoundingClientRect(), ir = input.getBoundingClientRect();
    const bottom = wr.bottom - ir.top + 4;
    if (bottom > 48 && ir.top - menu.offsetHeight - 4 >= 0) menu.style.bottom = `${Math.round(bottom)}px`;
    // Keep it inside the screen sideways too (on a 280 px display it ran 31 px off the right edge).
    menu.style.left = '0px';
    const mr = menu.getBoundingClientRect();
    if (mr.right > innerWidth - 8) menu.style.left = `${Math.round(-(mr.right - (innerWidth - 8)))}px`;
    else if (mr.left < 8) menu.style.left = `${Math.round(8 - mr.left)}px`;
}
function closeAttachMenu(): void { document.getElementById('attach-menu')?.classList.remove('open'); }
document.addEventListener('click', e => {
    if (!(e.target as HTMLElement | null)?.closest?.('.attach-wrap')) closeAttachMenu();
});
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // Claim the key when the menu was open, so the global Escape (stop the reply) does not also act on it.
    if (document.getElementById('attach-menu')?.classList.contains('open')) e.preventDefault();
    closeAttachMenu();
});

// "Attach": the device's own attachment sheet (Photo Library / Take Photo / Files on phones).
function attachFromDevice(): void { closeAttachMenu(); (document.getElementById('attach-device-input') as HTMLInputElement | null)?.click(); }
// "Upload": the plain file picker, every file type.
function attachUpload(): void { closeAttachMenu(); (document.getElementById('attach-file-input') as HTMLInputElement | null)?.click(); }

// "Select": pick files that are already in the workspace (or the synced local folder).
// Resolves with the chosen paths, or [] when cancelled. Shared by the chat and the task dialog.
async function pickWorkspaceFiles(heading = 'Attach files from the workspace'): Promise<string[]> {
    if (typeof agentListFiles !== 'function') return [];
    let files: { name: string; size?: number }[] = [];
    try { files = await agentListFiles(); } catch { return []; }
    files = files.filter(f => !f.name.split('/').some(seg => seg.startsWith('.'))).sort((a, b) => a.name.localeCompare(b.name));

    return new Promise<string[]>(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'ws-pick-overlay';
        const box = document.createElement('div');
        box.className = 'ws-pick-box';
        const title = document.createElement('div');
        title.className = 'ws-pick-title'; title.textContent = heading;
        const filter = document.createElement('input');
        filter.className = 'settings-input'; filter.placeholder = 'Filter…'; filter.style.width = '100%';
        const list = document.createElement('div');
        list.className = 'ws-pick-list';
        const footer = document.createElement('div');
        footer.className = 'ws-pick-footer';
        const cancel = document.createElement('button');
        cancel.className = 'ws-action-btn'; cancel.textContent = 'Cancel';
        const ok = document.createElement('button');
        ok.className = 'ws-action-btn'; ok.textContent = 'Attach';
        footer.append(cancel, ok);
        box.append(title, filter, list, footer);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const chosen = new Set<string>();
        const render = () => {
            const q = filter.value.trim().toLowerCase();
            list.innerHTML = '';
            const matching = files.filter(f => !q || f.name.toLowerCase().includes(q));
            const shown = matching.slice(0, 300);
            if (!shown.length) { list.textContent = files.length ? 'No matching files.' : 'The workspace has no files.'; return; }
            for (const f of shown) {
                const row = document.createElement('label');
                row.className = 'ws-pick-row';
                const cb = document.createElement('input');
                cb.type = 'checkbox'; cb.checked = chosen.has(f.name);
                cb.onchange = () => { cb.checked ? chosen.add(f.name) : chosen.delete(f.name); ok.textContent = chosen.size ? `Attach (${chosen.size})` : 'Attach'; };
                const nm = document.createElement('span');
                nm.textContent = f.name;
                row.append(cb, nm);
                if (typeof f.size === 'number') { const sz = document.createElement('span'); sz.className = 'ws-pick-size'; sz.textContent = _fmtSz(f.size); row.appendChild(sz); }
                list.appendChild(row);
            }
            if (matching.length > shown.length) {
                const more = document.createElement('div');
                more.className = 'ws-pick-size';
                more.textContent = `Showing ${shown.length} of ${matching.length} files. Type in the filter to find the others.`;
                list.appendChild(more);
            }
        };
        filter.oninput = render;
        render();
        const close = (result: string[]) => { overlay.remove(); resolve(result); };
        cancel.onclick = () => close([]);
        overlay.onclick = e => { if (e.target === overlay) close([]); };
        ok.onclick = () => close([...chosen]);
        filter.focus();
    });
}

async function attachFromWorkspace(): Promise<void> {
    closeAttachMenu();
    for (const path of await pickWorkspaceFiles()) await addWorkspaceAttachment(path).catch(e => _attachmentError(path, e));
}

// Store an uploaded file in the workspace under attachments/ (as chat attachments are) and return its path.
async function saveFileToWorkspace(file: File): Promise<string> {
    const url = await _readAttachment(file, 'readAsDataURL');
    const basename = file.name.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..').pop() || 'attachment';
    const path = `attachments/${Date.now()}-${Math.random().toString(36).slice(2, 10)}/${basename}`;
    await agentWriteFile(path, url.slice(url.indexOf(',') + 1), 'base64');
    return path;
}

// Attach a file that is already in the workspace: same pipeline as an upload, no extra copy.
// mimeType: the type the file was attached with, when known (a checkpoint keeps it); the name's extension is only a guess.
function addWorkspaceAttachment(path: string, mimeType?: string): Promise<void> {
    return (async () => {
        const bytes = await agentReadFileBytes(path);
        const name = path.split('/').pop() || path;
        const file = new File([bytes as BlobPart], name, { type: mimeType || _guessMime(name.split('.').pop()?.toLowerCase() || '') });
        await addFileAttachment(file, path);
    })();
}

Object.assign(window, {
    toggleAttachMenu, attachFromDevice, attachUpload, attachFromWorkspace, addWorkspaceAttachment,
    pickWorkspaceFiles, saveFileToWorkspace,
});

Object.assign(window, {
    addImageAttachment, clearImageAttachments, parkPendingAttachments, restoreParkedAttachments, clearParkedAttachments, addFileAttachment, waitForAttachments, hasPendingAttachments, warnAttachmentSendBusy,
    setupChatDropZone, restoreFileAttachment, getPendingAttachments, takeAttachmentFailures, resumePendingReads,
    _guessMime, _fileIcon, _fmtSz, _LANG_MAP, _audioFmt,
});
