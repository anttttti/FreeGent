// tabs.js — FreeGent: tab management, file tabs, notify local file changed
// Depends on: config.js, settings-ui.js, skills.js, tasks.js, editor.js

const fileTabs = new Map(); // filename -> { tab, panel, editor, savedContent }

function activateTab(key) {
    // Rail nav button active state
    document.querySelectorAll('.left-rail .rail-nav-btn').forEach(b => b.classList.remove('active'));
    const railBtn = document.querySelector(`.left-rail .rail-nav-btn[data-tab="${key}"]`);
    if (railBtn) railBtn.classList.add('active');
    // File tabs (in #tab-bar)
    document.querySelectorAll('#tab-bar .tab').forEach(t => t.classList.remove('active'));
    // Tab panels
    document.querySelectorAll('#tab-content .tab-panel').forEach(p => p.classList.remove('active'));
    const panelEl = document.querySelector(`#tab-content [data-panel="${key}"]`);
    if (panelEl) panelEl.classList.add('active');
    const ft = fileTabs.get(key);
    if (ft) { ft.tab.classList.add('active'); ft.panel.classList.add('active'); }
    // Hide the sidebar entirely when a preview tab (artifact iframe, image, PDF, …) is active.
    document.body.classList.toggle('preview-mode', !!(ft?.isPreview));
    if (key === 'settings') { populateSettingsForm(); switchSettingsTab('profiles'); renderProfilesTab(); }
    if (key === 'tasks')    { refreshTasks(); initRunner?.(); }
    if (key === 'skills')   loadSkills();
    if (key === 'workspace') pollFsaChanges?.();
    if (key === 'chat')     _updateChatEmpty?.();
}

function openFileTab(name) {
    if (fileTabs.has(name)) { activateTab(name); return; }

    document.querySelectorAll('.workspace-file-row').forEach(r => {
        const n = r.querySelector('.workspace-file-name') as HTMLElement | null;
        r.classList.toggle('tab-open', (n?.dataset.fullname ?? n?.textContent) === name);
    });

    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.onclick = () => activateTab(name);
    const label = document.createElement('span');
    label.textContent = name;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.onclick = e => { e.stopPropagation(); closeFileTab(name); };
    tab.append(label, closeBtn);
    document.getElementById('tab-bar').appendChild(tab);

    const panel = document.createElement('div');
    panel.className = 'tab-panel file-panel';

    const hdr = document.createElement('div');
    hdr.className = 'file-panel-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'file-panel-name';
    nameEl.textContent = name;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'ws-action-btn file-save-btn';
    saveBtn.textContent = '↑ Save';
    saveBtn.title = 'Save (Ctrl+S)';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'ws-action-btn';
    dlBtn.textContent = '↓ Download';
    dlBtn.onclick = () => downloadFile(name);

    // Shared reference: wired up in the .md loading block below.
    let _mdToggleBtn: HTMLButtonElement | null = null;

    if (/\.(png|jpe?g|gif|webp|bmp|ico|avif|pdf|xlsx|xls|ods|pptx|ppt|docx|doc|odt)$/i.test(name)) {
        hdr.append(nameEl, dlBtn); // no save button for binary files
    } else if (/\.(html?|svg)$/i.test(name)) {
        const previewBtn = document.createElement('button');
        previewBtn.className = 'ws-action-btn';
        previewBtn.textContent = '▶ Preview';
        previewBtn.title = 'Open in sandbox';
        previewBtn.onclick = () => openArtifactTab(name, ft.editor ? ft.editor.state.doc.toString() : ft.savedContent);
        hdr.append(nameEl, saveBtn, dlBtn, previewBtn);
    } else if (/\.md$/i.test(name)) {
        _mdToggleBtn = document.createElement('button');
        _mdToggleBtn.className = 'ws-action-btn';
        _mdToggleBtn.textContent = '✎ Edit';
        _mdToggleBtn.title = 'Toggle between rendered preview and editor';
        hdr.append(nameEl, saveBtn, dlBtn, _mdToggleBtn);
    } else {
        hdr.append(nameEl, saveBtn, dlBtn);
    }

    const body = document.createElement('div');
    body.className = 'file-panel-body';
    const editorWrap = document.createElement('div');
    editorWrap.className = 'file-editor-wrap';
    editorWrap.textContent = 'Loading…';
    body.appendChild(editorWrap);

    panel.append(hdr, body);
    document.getElementById('tab-content').appendChild(panel);

    // Binary/visual file types have no code editor — they display as a preview.
    const isPreview = /\.(png|jpe?g|gif|webp|bmp|ico|avif|pdf|xlsx|xls|ods|pptx|ppt|docx|doc|odt)$/i.test(name);
    const ft: any = { tab, panel, editor: null, savedContent: '', isPreview };
    fileTabs.set(name, ft);
    activateTab(name);

    async function doSave(content) {
        try {
            await agentWriteFile(name, content);
            ft.savedContent = content;
            saveBtn.textContent = '✓ Saved';
            saveBtn.classList.remove('file-unsaved');
            setTimeout(() => { saveBtn.textContent = '↑ Save'; }, 1500);
        } catch (e) {
            saveBtn.textContent = '✗ Error';
            setTimeout(() => { saveBtn.textContent = '↑ Save'; }, 2000);
        }
    }

    saveBtn.onclick = () => {
        if (ft.editor) doSave(ft.editor.state.doc.toString());
    };

    if (/\.pdf$/i.test(name)) {
        editorWrap.textContent = 'Loading…';
        readWorkspaceFile?.(name).then(rec => {
            if (!rec?.content) {
                editorWrap.textContent = 'PDF preview unavailable — file is empty.';
                return;
            }
            // Detect whether content is actually a PDF binary.
            // Base64-encoded PDFs decode to bytes starting with %PDF-
            // Plain-text "PDFs" written by the AI won't have this signature.
            let isRealPdf: boolean = false;
            let pdfBytes: Uint8Array | null = null;
            if (rec.encoding === 'base64') {
                pdfBytes = _base64ToUint8?.(rec.content);
                if (pdfBytes) isRealPdf = pdfBytes[0] === 0x25 && pdfBytes[1] === 0x50; // %P
            } else {
                isRealPdf = rec.content.trimStart().startsWith('%PDF-');
            }

            if (!isRealPdf) {
                // Show as plain text — the AI wrote text content to a .pdf file
                editorWrap.textContent = '';
                editorWrap.style.cssText = 'flex:1;overflow:auto;padding:14px 16px;';
                const pre = document.createElement('pre');
                pre.style.cssText = 'margin:0;font-family:inherit;font-size:13px;white-space:pre-wrap;word-break:break-word;';
                pre.textContent = rec.encoding === 'base64'
                    ? '[Binary file — not a valid PDF]'
                    : rec.content;
                editorWrap.appendChild(pre);
                return;
            }

            const blob = pdfBytes
                ? new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
                : new Blob([rec.content], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            ft._blobUrl = url;
            editorWrap.textContent = '';
            editorWrap.style.cssText = 'flex:1;display:flex;padding:0;overflow:hidden;height:100%;';
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'flex:1;border:none;width:100%;height:100%;';
            iframe.src = url;
            editorWrap.appendChild(iframe);
        }).catch(e => { editorWrap.textContent = 'Error loading PDF: ' + e.message; });
        return;
    }

    if (/\.(xlsx|xls|ods)$/i.test(name)) {
        editorWrap.textContent = 'Loading…';
        readWorkspaceFile?.(name).then(rec => {
            if (!rec?.content || !XLSX) {
                editorWrap.textContent = 'Spreadsheet preview unavailable.';
                return;
            }
            const bytes = rec.encoding === 'base64'
                ? _base64ToUint8?.(rec.content)
                : new TextEncoder().encode(rec.content);
            if (!bytes) { editorWrap.textContent = 'Could not decode spreadsheet.'; return; }
            const wb = XLSX.read(bytes, { type: 'array' });
            editorWrap.textContent = '';
            editorWrap.style.cssText = 'flex:1;overflow:auto;padding:12px;';
            wb.SheetNames.forEach(sheetName => {
                const label = document.createElement('div');
                label.style.cssText = 'font-weight:600;font-size:12px;color:var(--muted);margin:8px 0 4px;';
                label.textContent = sheetName;
                editorWrap.appendChild(label);
                const html = XLSX.utils.sheet_to_html(wb.Sheets[sheetName]);
                const wrap = document.createElement('div');
                wrap.style.cssText = 'overflow-x:auto;margin-bottom:12px;';
                wrap.innerHTML = `<style>
                    .fg-xl-tbl { border-collapse:collapse; font-size:12px; font-family:inherit; }
                    .fg-xl-tbl td, .fg-xl-tbl th { border:1px solid var(--border); padding:3px 8px; white-space:nowrap; }
                    .fg-xl-tbl tr:first-child td { background:var(--sidebar-bg); font-weight:600; }
                </style>` + html.replace(/<table/g, '<table class="fg-xl-tbl"');
                editorWrap.appendChild(wrap);
            });
        }).catch(e => { editorWrap.textContent = 'Error loading spreadsheet: ' + e.message; });
        return;
    }

    if (/\.(pptx|ppt)$/i.test(name)) {
        editorWrap.textContent = '';
        editorWrap.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;';
        editorWrap.textContent = 'PowerPoint preview not available in the browser — download the file to open it.';
        return;
    }

    if (/\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(name)) {
        editorWrap.textContent = 'Loading…';
        (readFileAsDataUrl?.(name) ?? agentReadFile(name)).then(dataUrl => {
            editorWrap.textContent = '';
            editorWrap.style.cssText = 'display:flex;align-items:flex-start;justify-content:center;padding:16px;box-sizing:border-box;overflow:auto;';
            const img = document.createElement('img');
            img.src = dataUrl;
            img.alt = name.split('/').pop();
            img.style.cssText = 'max-width:100%;height:auto;border-radius:4px;box-shadow:0 2px 12px rgba(0,0,0,0.3);';
            editorWrap.appendChild(img);
        }).catch(e => {
            editorWrap.textContent = 'Error loading image: ' + e.message;
        });
        return;
    }

    if (/\.md$/i.test(name)) {
        editorWrap.textContent = 'Loading…';
        agentReadFile(name).then(async content => {
            ft.savedContent = content;
            editorWrap.textContent = '';
            editorWrap.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;';

            // Rendered preview div — shown by default
            const previewDiv = document.createElement('div');
            previewDiv.className = 'agent-response-text md-file-preview';
            previewDiv.style.cssText = 'flex:1;overflow:auto;padding:16px 20px;box-sizing:border-box;';
            const _refreshPreview = (src: string) => {
                previewDiv.innerHTML = renderMarkdown?.(src) ?? src;
                processImgSlots?.(previewDiv);
                processFileLinks?.(previewDiv);
            };
            _refreshPreview(content);
            editorWrap.appendChild(previewDiv);
            saveBtn.style.display = 'none';

            // Editor wrap — created lazily, hidden initially
            const editWrap = document.createElement('div');
            editWrap.style.cssText = 'flex:1;min-height:0;display:none;flex-direction:column;overflow:hidden;';
            editorWrap.appendChild(editWrap);

            let _mdShowPreview = true;
            if (_mdToggleBtn) {
                _mdToggleBtn.onclick = async () => {
                    if (_mdShowPreview) {
                        // Switch to edit mode
                        _mdShowPreview = false;
                        _mdToggleBtn!.textContent = '👁 Preview';
                        previewDiv.style.display = 'none';
                        editWrap.style.display = 'flex';
                        saveBtn.style.display = '';
                        if (!ft.editor) {
                            ft.editor = await createEditor(editWrap, name, ft.savedContent, {
                                onSave: doSave,
                                onChange(newContent: string) {
                                    const dirty = newContent !== ft.savedContent;
                                    saveBtn.textContent = dirty ? '↑ Save ●' : '↑ Save';
                                    saveBtn.classList.toggle('file-unsaved', dirty);
                                },
                            });
                            if (!ft.editor) saveBtn.style.display = 'none';
                        }
                    } else {
                        // Switch to preview mode
                        _mdShowPreview = true;
                        _mdToggleBtn!.textContent = '✎ Edit';
                        editWrap.style.display = 'none';
                        previewDiv.style.display = '';
                        _refreshPreview(ft.editor?.state.doc.toString() ?? ft.savedContent);
                        saveBtn.style.display = 'none';
                    }
                };
            }
        }).catch(e => {
            editorWrap.innerHTML = '';
            const pre = document.createElement('pre');
            pre.className = 'file-panel-pre';
            pre.textContent = 'Error: ' + e.message;
            editorWrap.appendChild(pre);
            saveBtn.style.display = 'none';
        });
        return;
    }

    agentReadFile(name).then(async content => {
        ft.savedContent = content;
        editorWrap.textContent = '';

        // Plain <pre> fallback for very large files
        if (content.length > 800_000) {
            const pre = document.createElement('pre');
            pre.className = 'file-panel-pre';
            pre.textContent = content;
            editorWrap.appendChild(pre);
            saveBtn.style.display = 'none';
            return;
        }

        ft.editor = await createEditor(editorWrap, name, content, {
            onSave: doSave,
            onChange(newContent) {
                const dirty = newContent !== ft.savedContent;
                saveBtn.textContent = dirty ? '↑ Save ●' : '↑ Save';
                saveBtn.classList.toggle('file-unsaved', dirty);
            },
        });

        if (!ft.editor) {
            // createEditor fell back to <pre> — hide save button
            saveBtn.style.display = 'none';
        }
    }).catch(e => {
        editorWrap.innerHTML = '';
        const pre = document.createElement('pre');
        pre.className = 'file-panel-pre';
        pre.textContent = 'Error: ' + e.message;
        editorWrap.appendChild(pre);
        saveBtn.style.display = 'none';
    });
}

function closeFileTab(name) {
    const ft = fileTabs.get(name);
    if (!ft) return;
    const wasActive = ft.tab.classList.contains('active');
    ft.editor?.destroy();
    if (ft._blobUrl) URL.revokeObjectURL(ft._blobUrl);
    ft.tab.remove();
    ft.panel.remove();
    fileTabs.delete(name);
    document.querySelectorAll('.workspace-file-row').forEach(r => {
        const n = r.querySelector('.workspace-file-name') as HTMLElement | null;
        if ((n?.dataset.fullname ?? n?.textContent) === name) r.classList.remove('tab-open');
    });
    if (wasActive) activateTab('chat');
}

// localStorage/sessionStorage polyfill injected into every sandboxed artifact iframe.
// Sandboxed iframes (no allow-same-origin) throw SecurityError on Storage access; the
// polyfill silently replaces the broken property with an in-memory Map-backed store so
// games and apps that use localStorage don't crash.
const _STORAGE_POLYFILL = `<script>(function(){function mk(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(n){return Object.keys(d)[n]??null},get length(){return Object.keys(d).length}}};['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('_')}catch(e){try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch(_){}}})})();<\/script>`;

function _wrapArtifact(content) {
    // Bare SVG document → wrap in HTML so the iframe renders it with full animation support.
    // Without this, srcdoc parses it as HTML quirks mode which breaks SMIL and some CSS anims.
    if (/^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(content)) {
        return `<!DOCTYPE html><html><head>${_STORAGE_POLYFILL}<style>html,body{margin:0;background:#fff;display:flex;justify-content:center;align-items:flex-start;}svg{max-width:100%;height:auto;}</style></head><body>${content}</body></html>`;
    }
    // Inject the storage polyfill into HTML: right after <head> if present, else at the top.
    if (/<head[^>]*>/i.test(content)) {
        return content.replace(/(<head[^>]*>)/i, `$1${_STORAGE_POLYFILL}`);
    }
    return _STORAGE_POLYFILL + content;
}

// Recursively inline a JS module: strip import/export statements, inline imported files first.
// visited guards against circular imports.
async function _inlineJsModule(path, readFile, visited = new Set()) {
    if (visited.has(path)) return '';
    visited.add(path);
    let src = '';
    try { src = await readFile(path) ?? ''; } catch { return ''; }

    // Collect static import paths: import ... from './x.js'  or  import './x.js'
    const importRe = /^\s*import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]\s*;?/gm;
    const imports = [];
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
        const dep = m[1];
        if (!dep.startsWith('http') && !dep.startsWith('//')) {
            // Resolve relative to the directory of path
            const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
            const depPath = dep.startsWith('./') ? dir + dep.slice(2)
                          : dep.startsWith('../') ? dep  // best-effort; skip complex traversal
                          : dir + dep;
            imports.push(depPath);
        }
    }

    // Recursively inline dependencies first
    const depSrcs = await Promise.all(imports.map(d => _inlineJsModule(d, readFile, visited)));

    // Strip import and export statements from this file's source
    const stripped = src
        .replace(/^\s*import\s+(?:[^'"]*\s+from\s+)?['"][^'"]+['"]\s*;?/gm, '')
        .replace(/^\s*export\s+default\s+/gm, '')
        .replace(/^\s*export\s+\{[^}]*\}\s*;?/gm, '')
        .replace(/^(\s*)export\s+((?:async\s+)?(?:function|class|const|let|var)\s)/gm, '$1$2');

    return [...depSrcs, stripped].join('\n');
}

// Inline external CSS and JS file references so the HTML is self-contained for srcdoc.
// Handles: <link rel="stylesheet" href="...">, <script src="..." [type="module"]>
async function _inlineWorkspaceRefs(html) {
    const readFile = typeof agentReadFile === 'function' ? agentReadFile : null;
    if (!readFile) return html;

    // Inline <link rel="stylesheet" href="...">
    html = await _replaceAsync(html,
        /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/gi,
        async (match, href) => {
            if (href.startsWith('http') || href.startsWith('//')) return match;
            try {
                const css = await readFile(href);
                if (css == null) return match;
                return `<style>\n${css}\n</style>`;
            } catch { return match; }
        });

    // Inline <script src="..." [type="module"]>
    // Note: check `match` (full tag) for type="module" — `attrs` only captures before src=,
    // so <script src="..." type="module"> would miss the attribute if checked via attrs.
    html = await _replaceAsync(html,
        /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi,
        async (match, src) => {
            if (src.startsWith('http') || src.startsWith('//')) return match;
            try {
                const isModule = /\btype=["']module["']/i.test(match);
                const js = isModule
                    ? await _inlineJsModule(src, readFile)
                    : await readFile(src);
                if (js == null) return match;
                return `<script>\n${js}\n</script>`;
            } catch { return match; }
        });

    // Scan for quoted asset paths (audio, images, fonts) referenced in the inlined scripts.
    // For any that exist in the workspace, build a fetch() interceptor so runtime fetches resolve.
    const assetRe = /["']([^"']+\.(?:wav|mp3|ogg|flac|aac|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot))["']/gi;
    const assetPaths = new Set<string>();
    let am: RegExpExecArray | null;
    while ((am = assetRe.exec(html)) !== null) {
        const p = am[1];
        if (!p.startsWith('http') && !p.startsWith('//') && !p.startsWith('data:')) assetPaths.add(p);
    }
    const assetMap: Record<string, any> = {};
    const readDataUrl = typeof readFileAsDataUrl === 'function' ? readFileAsDataUrl : null;
    if (readDataUrl) {
        await Promise.all([...assetPaths].map(async p => {
            try { const d = await readDataUrl(p); if (d) assetMap[p] = d; } catch {}
        }));
    }

    // Build shims to inject before </head>:
    // 1. Passive event listener fix — Chrome blocks preventDefault() in default-passive touch listeners.
    // 2. Fetch interceptor — serves workspace asset files by data URL; falls back to silent WAV for
    //    missing audio so the game doesn't 404 and the AudioManager degrades cleanly.
    const mapJson = JSON.stringify(assetMap);
    const shimTag = `<script>
(function(){
/* 1. localStorage shim — srcdoc sandboxes lack allow-same-origin so localStorage throws;
      provide an in-memory drop-in so artifacts that use it degrade gracefully */
try { window.localStorage; } catch(e) {
  const _ls={};
  Object.defineProperty(window,'localStorage',{get:function(){return{
    getItem:function(k){return Object.prototype.hasOwnProperty.call(_ls,k)?_ls[k]:null;},
    setItem:function(k,v){_ls[k]=String(v);},
    removeItem:function(k){delete _ls[k];},
    clear:function(){Object.keys(_ls).forEach(function(k){delete _ls[k];});},
    get length(){return Object.keys(_ls).length;},
    key:function(i){return Object.keys(_ls)[i]??null;}
  };},configurable:true});
}
/* 2. passive touch fix */
const _ael=EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener=function(t,f,p){
  if((t==='touchstart'||t==='touchmove')&&(p==null||p===true||p===false))
    p={passive:false,capture:p===true};
  return _ael.call(this,t,f,p);
};
/* 3. fetch interceptor: workspace assets + silent-audio fallback */
const _M=${mapJson};
const _silentWav=(function(){
  const b=new Uint8Array(46),v=new DataView(b.buffer); /* 44-byte header + 2-byte sample */
  [82,73,70,70].forEach(function(x,i){b[i]=x;});
  v.setUint32(4,38,true); /* RIFF chunk size = 36 + 2 data bytes */
  [87,65,86,69].forEach(function(x,i){b[i+8]=x;});
  [102,109,116,32].forEach(function(x,i){b[i+12]=x;});
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,44100,true);v.setUint32(28,88200,true);
  v.setUint16(32,2,true);v.setUint16(34,16,true);
  [100,97,116,97].forEach(function(x,i){b[i+36]=x;});
  v.setUint32(40,2,true); /* data chunk size = 2 bytes (one 16-bit zero sample) */
  /* b[44] and b[45] are already 0 — the silent sample */
  let s='';for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);
  return 'data:audio/wav;base64,'+btoa(s);
})();
function _dataUrlResponse(dataUrl){
  const s=dataUrl.split(','),mt=s[0].split(':')[1].split(';')[0],
      b=atob(s[1]),a=new Uint8Array(b.length);
  for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);
  return Promise.resolve(new Response(new Blob([a],{type:mt})));
}
const _audioExts=/\\.(wav|mp3|ogg|flac|aac|m4a)$/i;
const _F=window.fetch;
window.fetch=function(u,opts){
  if(typeof u==='string'&&!u.startsWith('http')&&!u.startsWith('//')&&!u.startsWith('data:')){
    if(_M[u]) return _dataUrlResponse(_M[u]);
    if(_audioExts.test(u)) return _dataUrlResponse(_silentWav);
  }
  return _F.call(this,u,opts);
};
})();
</script>
`;
    html = html.includes('</head>') ? html.replace('</head>', shimTag + '</head>') : shimTag + html;

    return html;
}

// Async string replace helper — callback receives (match, ...groups) and returns a Promise.
async function _replaceAsync(str, re, asyncFn) {
    const matches = [];
    str.replace(re, (match, ...args) => { matches.push({ match, args }); return match; });
    const results = await Promise.all(matches.map(({ match, args }) => asyncFn(match, ...args)));
    let i = 0;
    return str.replace(re, () => results[i++]);
}

async function openArtifactTab(title, html, { isPreview = true } = {}) {
    const inlined = await _inlineWorkspaceRefs(html);
    const content = _wrapArtifact(inlined);
    const key = `artifact:${title}`;
    const existing = fileTabs.get(key);
    if (existing) {
        const iframe = existing.panel.querySelector('.artifact-iframe');
        if (iframe) iframe.srcdoc = content;
        activateTab(key);
        return;
    }

    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.onclick = () => activateTab(key);
    const label = document.createElement('span');
    label.textContent = `▶ ${title.split('/').pop()}`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close'; closeBtn.textContent = '×'; closeBtn.title = 'Close';
    closeBtn.onclick = e => { e.stopPropagation(); closeFileTab(key); };
    tab.append(label, closeBtn);
    document.getElementById('tab-bar').appendChild(tab);

    const panel = document.createElement('div');
    panel.className = 'tab-panel artifact-panel';
    const iframe = document.createElement('iframe');
    iframe.className = 'artifact-iframe';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
    iframe.srcdoc = content;
    panel.appendChild(iframe);
    document.getElementById('tab-content').appendChild(panel);

    fileTabs.set(key, { tab, panel, editor: null, savedContent: html, isPreview });
    activateTab(key);
}
window.openArtifactTab = openArtifactTab;

function notifyLocalFileChanged(fullPath, content) {
    const ft = fileTabs.get(fullPath);
    if (!ft) return;
    if (ft.editor) {
        setEditorContent(ft.editor, content);
        ft.savedContent = content;
        const saveBtn = ft.panel.querySelector('.file-save-btn');
        if (saveBtn) { saveBtn.textContent = '↑ Save'; saveBtn.classList.remove('file-unsaved'); }
    } else {
        const pre = ft.panel.querySelector('.file-panel-pre');
        if (pre) pre.textContent = content;
    }
}

function toggleRailExpanded() {
    const rail = document.getElementById('left-rail');
    if (!rail) return;
    // On mobile: expand-btn toggles between minimized (icon strip) and expanded (overlay)
    if (rail.classList.contains('mobile-open')) {
        rail.classList.toggle('expanded');
    } else {
        rail.classList.toggle('expanded');
    }
    const btn = document.getElementById('rail-expand-btn') as HTMLButtonElement | null;
    if (btn) btn.title = rail.classList.contains('expanded') ? 'Shrink sidebar' : 'Expand sidebar';
}

function closeMobileRail() {
    const rail = document.getElementById('left-rail');
    if (!rail) return;
    rail.classList.remove('mobile-open', 'expanded');
    // Restore hamburger button
    const mBtn = document.getElementById('mobile-menu-btn') as HTMLButtonElement | null;
    if (mBtn) mBtn.style.display = '';
}

function toggleChatToolbar() {
    const toolbar = document.querySelector('.chat-toolbar') as HTMLElement | null;
    const btn = document.getElementById('toolbar-toggle-btn');
    const collapsed = toolbar?.classList.toggle('collapsed');
    if (btn) {
        btn.textContent = collapsed ? '▶' : '▼';
        btn.title = collapsed ? 'Show toolbar' : 'Hide toolbar';
    }
}

function expandChatToolbar() {
    const toolbar = document.querySelector('.chat-toolbar') as HTMLElement | null;
    const btn = document.getElementById('toolbar-toggle-btn');
    toolbar?.classList.remove('collapsed');
    if (btn) { btn.textContent = '▼'; btn.title = 'Hide toolbar'; }
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { activateTab, openFileTab, closeFileTab, openArtifactTab, notifyLocalFileChanged, toggleRailExpanded, closeMobileRail, toggleChatToolbar, expandChatToolbar });
