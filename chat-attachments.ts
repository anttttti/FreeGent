// chat-attachments.ts — pending image/file attachment state and UI (thumbnails, chips, drag-drop, paste).
// Depends on: nothing (pure DOM + state).

// ── Pending attachment state ──────────────────────────────────────────────────
let _pendingImages: { mimeType: string; base64: string }[] = [];
let _pendingFiles: { name: string; mimeType: string; contentType: string; content: string; size: number }[] = [];

// ── File attachment helpers ───────────────────────────────────────────────────

const _TEXT_EXTS = new Set([
    'txt','md','mdx','csv','tsv','json','jsonc','yaml','yml','toml','ini','cfg','conf','env',
    'xml','html','htm','css','scss','sass','less',
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

function _guessMime(ext: string): string {
    const m = {
        pdf:'application/pdf',
        mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', m4a:'audio/mp4',
        flac:'audio/flac', aac:'audio/aac', weba:'audio/webm',
        mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime',
        avi:'video/x-msvideo', mkv:'video/x-matroska',
    };
    return m[ext] || 'application/octet-stream';
}

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
    chip.innerHTML = `<span class="file-chip-icon">${_fileIcon(att.mimeType, att.name)}</span>`
                   + `<span class="file-chip-name">${nameShort}</span>`;
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
    _pendingImages = [];
    _pendingFiles  = [];
    const strip = document.getElementById('img-strip');
    if (strip) { strip.innerHTML = ''; strip.style.display = 'none'; }
}

// Returns snapshots of the pending arrays for callers that need to read state
// (saveCheckpoint, agentSend) without exposing the mutable arrays directly.
function getPendingAttachments(): {
    images: { mimeType: string; base64: string }[];
    files: { name: string; mimeType: string; contentType: string; content: string; size: number }[];
} {
    return { images: [..._pendingImages], files: [..._pendingFiles] };
}

// Restores a saved attachment entry into pending state (used by rerunCheckpoint and
// _startEditUserMsg when replaying a turn with previously-attached files).
function restoreFileAttachment(att: { name: string; mimeType: string; contentType: string; content: string; size: number }): void {
    _pendingFiles.push(att);
    _addFileChip(att);
}

async function addFileAttachment(file: File): Promise<void> {
    const name = file.name;
    const ext  = name.split('.').pop()?.toLowerCase() || '';
    const mimeType = file.type || _guessMime(ext);

    // Images → existing thumbnail path (includes SVG)
    if (mimeType.startsWith('image/')) {
        return new Promise<void>(resolve => {
            const reader = new FileReader();
            reader.onload = () => {
                const url = reader.result as string;
                addImageAttachment(mimeType, url.slice(url.indexOf(',') + 1));
                resolve();
            };
            reader.readAsDataURL(file);
        });
    }

    // Text files → read content, inject as formatted blocks
    const isText = mimeType.startsWith('text/')
        || ['application/json','application/xml','application/javascript',
            'application/typescript','application/yaml'].includes(mimeType)
        || _TEXT_EXTS.has(ext);
    if (isText) {
        const MAX = 50_000;
        const raw = await file.text();
        const content = raw.length > MAX
            ? raw.slice(0, MAX) + `\n…[truncated — file is ${_fmtSz(raw.length)}, showing first 50 KB]`
            : raw;
        const att = { name, mimeType: mimeType || 'text/plain', contentType: 'text', content, size: file.size };
        _pendingFiles.push(att);
        _addFileChip(att);
        return;
    }

    // Binary (PDF, audio, video, etc.) → base64
    return new Promise<void>(resolve => {
        const reader = new FileReader();
        reader.onload = () => {
            const url = reader.result as string;
            const att = { name, mimeType, contentType: 'binary',
                          content: url.slice(url.indexOf(',') + 1), size: file.size };
            _pendingFiles.push(att);
            _addFileChip(att);
            resolve();
        };
        reader.readAsDataURL(file);
    });
}

let _chatDropZoneSetup = false;
function setupChatDropZone(): void {
    if (_chatDropZoneSetup) return;
    const chatPanel = document.querySelector('#tab-content [data-panel="chat"]') as HTMLElement | null;
    const overlay   = document.getElementById('chat-drop-overlay');
    if (!chatPanel) return;
    _chatDropZoneSetup = true;

    chatPanel.addEventListener('dragover', e => {
        if (!e.dataTransfer?.types.includes('Files')) return;
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
        for (const file of [...(e.dataTransfer?.files || [])])
            await addFileAttachment(file).catch(() => {});
    });
}

// Paste any file (image or otherwise) into the chat tab
document.addEventListener('paste', e => {
    const items = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file');
    if (!items.length) return;
    const chatPanel = document.querySelector('#tab-content [data-panel="chat"]') as HTMLElement | null;
    if (!chatPanel?.classList.contains('active')) return;
    e.preventDefault();
    for (const item of items) {
        const file = item.getAsFile();
        if (file) addFileAttachment(file).catch(() => {});
    }
});

Object.assign(window, {
    addImageAttachment, clearImageAttachments, addFileAttachment,
    setupChatDropZone, restoreFileAttachment, getPendingAttachments,
    _guessMime, _fileIcon, _fmtSz, _LANG_MAP, _audioFmt,
});
