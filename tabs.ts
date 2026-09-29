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

// The workspace file a page's reference points to, resolved as a browser would: relative to the
// referring file's folder, or from the workspace root for "/x" (or "/workspace/x"). Query and
// fragment are dropped. Preview pages are srcdoc documents with no base URL of their own, so
// without this "app.js" in app/index.html was looked up as the root's app.js.
export function resolvePageRef(ref: string, fromPath: string): string {
    const clean = ref.split(/[?#]/)[0].replace(/^\/workspace(?=\/|$)/, '');
    const dir = clean.startsWith('/') || !fromPath.includes('/') ? '' : fromPath.slice(0, fromPath.lastIndexOf('/') + 1);
    const parts: string[] = [];
    for (const seg of (dir + clean).split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') parts.pop(); else parts.push(seg);
    }
    return parts.join('/');
}

// A reference to a workspace file, not a URL scheme, protocol-relative URL or in-page anchor.
const _isLocalRef = (r: string) => !!r && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(r.trim());

// A workspace file as a data: URL (binary files are stored as base64; SVG may be stored as text).
async function _dataUrlFor(name: string): Promise<string | null> {
    try { if (typeof readFileAsDataUrl === 'function') { const d = await readFileAsDataUrl(name); if (d) return d; } } catch {}
    try {
        const t = await agentReadFile(name);
        if (typeof t === 'string' && /\.svg$/i.test(name)) return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(t);
    } catch {}
    return null;
}

// url(...) references to workspace files in CSS become data: URLs, resolved from fromPath (the
// stylesheet's own file, or the page for inline <style>).
async function _inlineCssUrls(css: string, fromPath: string): Promise<string> {
    return _replaceAsync(css, /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, async (m, q, val) => {
        if (!_isLocalRef(val)) return m;
        const d = await _dataUrlFor(resolvePageRef(val, fromPath));
        return d ? `url(${q || '"'}${d}${q || '"'})` : m;
    });
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
        // Only treat as local if it looks like a path: must start with ./ ../ or /.
        // Bare specifiers ('vue', 'react', 'pyodide', …) are npm-style — browsers
        // never resolve them as relative URLs and we cannot inline them from the workspace.
        if (!dep.startsWith('http') && !dep.startsWith('//') &&
            (dep.startsWith('./') || dep.startsWith('../') || dep.startsWith('/'))) {
            imports.push(resolvePageRef(dep, path));
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
// Handles: <link rel="stylesheet" href="...">, <script src="..." [type="module"]>,
//          inline <script> blocks containing static ES import statements.
async function _inlineWorkspaceRefs(html, pagePath = '') {
    const readFile = typeof agentReadFile === 'function' ? agentReadFile : null;
    if (!readFile) return html;
    const ref = (r: string) => resolvePageRef(r, pagePath);

    // Inline <link rel="stylesheet" href="...">
    html = await _replaceAsync(html,
        /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/gi,
        async (match, href) => {
            if (href.startsWith('http') || href.startsWith('//')) return match;
            try {
                const css = await readFile(ref(href));
                if (css == null) return match;
                return `<style>\n${await _inlineCssUrls(css, ref(href))}\n</style>`;
            } catch { return match; }
        });

    // Remaining url(...) in the page's own <style> blocks resolve from the page.
    html = await _replaceAsync(html, /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
        async (m, open, css, close) => `${open}${await _inlineCssUrls(css, pagePath)}${close}`);

    // Workspace images, media and icons in the page's tags become data: URLs: a srcdoc page has no
    // base URL, so a relative src/href in it would not load.
    html = await _replaceAsync(html, /<(img|audio|video|source|track|input|embed|link)\b[^>]*>/gi, async (tag, name) => {
        if (name.toLowerCase() === 'link' && !/\brel=["'][^"']*\b(?:icon|apple-touch-icon|preload)\b/i.test(tag)) return tag;
        return _replaceAsync(tag, /\b(src|href|poster)=(["'])([^"']*)\2/gi, async (m, attr, q, val) => {
            if (!_isLocalRef(val)) return m;
            const d = await _dataUrlFor(ref(val));
            return d ? `${attr}=${q}${d}${q}` : m;
        });
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
                    ? await _inlineJsModule(ref(src), readFile)
                    : await readFile(ref(src));
                if (js == null) return match;
                return `<script>\n${js}\n</script>`;
            } catch { return match; }
        });

    // Inline static ES import statements inside inline <script> blocks.
    // Agent-generated HTML often writes <script>import {x} from './x.js'</script> without
    // type="module", which causes "Unexpected token 'import'" in a classic script context.
    // We handle it the same way as <script src="..." type="module">: recursively inline the
    // imported workspace files and strip import/export keywords, yielding a classic script.
    // External imports (http//) are left as-is so the browser can handle them natively.
    const _STATIC_IMPORT_RE = /^\s*import\s+(?:(?:\*\s+as\s+\w+|(?:\w+|{[^}]*})(?:\s*,\s*(?:\*\s+as\s+\w+|\w+|{[^}]*}))*)\s+from\s+)?['"][^'"]+['"]\s*;?/m;
    html = await _replaceAsync(html,
        /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
        async (match, attrs, content) => {
            // Skip external-src scripts (already handled above) and scripts without static imports.
            if (/\bsrc=/i.test(attrs)) return match;
            if (!_STATIC_IMPORT_RE.test(content)) return match;
            try {
                const importRe = /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]\s*;?/gm;
                const localDeps: string[] = [];
                let im: RegExpExecArray | null;
                while ((im = importRe.exec(content)) !== null) {
                    const dep = im[1];
                    // Only local if it's a path (./ ../ /). Bare specifiers ('vue', 'react', …)
                    // are external and cannot be inlined from the workspace.
                    if (!dep.startsWith('http') && !dep.startsWith('//') &&
                        (dep.startsWith('./') || dep.startsWith('../') || dep.startsWith('/')))
                        localDeps.push(ref(dep));
                }
                if (!localDeps.length) {
                    // All imports are external (http/CDN) — the browser handles them natively,
                    // but only in a module script.  If the tag lacks type="module", add it so
                    // the browser doesn't throw "Unexpected token 'import'" on the import syntax.
                    if (/\btype=["']module["']/i.test(attrs)) return match;
                    const modAttrs = (attrs.trim() ? attrs.trim() + ' ' : '') + 'type="module"';
                    return `<script ${modAttrs}>${content}</script>`;
                }
                const depSrcs = await Promise.all(localDeps.map(d => _inlineJsModule(d, readFile)));
                // Strip static import/export declarations from the inline script body.
                const stripped = content
                    .replace(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"][^'"]+['"]\s*;?/gm, '')
                    .replace(/^\s*export\s+default\s+/gm, '')
                    .replace(/^\s*export\s+\{[^}]*\}\s*;?/gm, '')
                    .replace(/^(\s*)export\s+((?:async\s+)?(?:function|class|const|let|var)\s)/gm, '$1$2');
                const cleanAttrs = attrs.replace(/\s*\btype=["']module["']/gi, '').trim();
                return `<script${cleanAttrs ? ' ' + cleanAttrs : ''}>\n${[...depSrcs, stripped].join('\n')}\n</script>`;
            } catch { return match; }
        });

    // Promote top-level const/let declarations to window.X so inline event handlers
    // (onclick="fetchData()") can reach them.  This applies to BOTH classic and
    // type="module" scripts: in a classic script, const/let are script-scoped (not
    // window properties); in a module script they are module-scoped.  Either way,
    // event attribute handlers (onclick="fetchData()") look up the name on window
    // and never find it unless we promote it.
    // Only column-0 simple-identifier declarations are promoted; destructuring
    // (const {a}=, const [a]=) and indented/nested declarations are left alone.
    html = html.replace(
        /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
        (match, attrs, content) => {
            if (/\bsrc=/i.test(attrs)) return match; // external src — skip
            const out = content.replace(
                /^(const|let)\s+([a-zA-Z_$][\w$]*)\s*=/gm,
                'window.$2 ='
            );
            return out === content ? match : `<script${attrs}>${out}</script>`;
        }
    );

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
            try { const d = await readDataUrl(ref(p)); if (d) assetMap[p] = d; } catch {}
        }));
    }

    // Build shims to inject before </head>:
    // 1. Passive event listener fix — Chrome blocks preventDefault() in default-passive touch listeners.
    // 2. Fetch interceptor — serves workspace asset files by data URL; falls back to silent WAV for
    //    missing audio so the game doesn't 404 and the AudioManager degrades cleanly.
    // 3. CORS proxy — relays cross-origin GET requests to this page (_relayPreviewFetch), which
    //    fetches them through the FG proxy, so agent-written HTML apps can fetch external APIs
    //    without CORS errors and without hardcoding 3rd-party proxies.
    const mapJson = JSON.stringify(assetMap);
    const _proxyUrl = typeof getEffectiveProxy === 'function' ? getEffectiveProxy() : '';
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
/* 3. fetch interceptor: workspace assets + silent-audio fallback + CORS proxy */
const _M=${mapJson};
const _PX=${JSON.stringify(_proxyUrl)};
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
const _SAFE_H=new Set(['accept','accept-language','cache-control','referer','x-requested-with']);
/* The sandbox gives this frame Origin "null", which the proxy rejects, so cross-origin GETs are
   relayed to the parent page, which fetches them through the proxy with its own origin. */
const _pend={};let _seq=0;
const _NULL_BODY=new Set([101,204,205,304]);
window.addEventListener('message',function(e){
  const d=e.data;
  if(e.source!==parent||!d||d.type!=='fg-fetch-result'||!_pend[d.id])return;
  const p=_pend[d.id];delete _pend[d.id];
  if(d.error)p.rej(new TypeError('Failed to fetch '+p.url+': '+d.error));
  else p.res(new Response(_NULL_BODY.has(d.status)?null:d.body,{status:d.status,statusText:d.statusText,headers:d.headers}));
});
function _relay(u,headers,sig){
  return new Promise(function(res,rej){
    const abort=function(){rej(new DOMException('The operation was aborted.','AbortError'));};
    if(sig&&sig.aborted){abort();return;}
    const id=++_seq;
    _pend[id]={res:res,rej:rej,url:u};
    if(sig)sig.addEventListener('abort',function(){if(_pend[id]){delete _pend[id];abort();}});
    parent.postMessage({type:'fg-fetch',id:id,url:u,headers:headers},'*');
  });
}
const _F=window.fetch;
window.fetch=function(u,opts){
  if(u instanceof URL)u=u.href;
  if(typeof u==='string'){
    /* workspace assets + silent audio */
    if(!u.startsWith('http')&&!u.startsWith('//')&&!u.startsWith('data:')){
      if(_M[u]) return _dataUrlResponse(_M[u]);
      if(_audioExts.test(u)) return _dataUrlResponse(_silentWav);
    }
    /* CORS proxy: relay cross-origin GET requests to the parent page */
    if(_PX&&(u.startsWith('https://')||u.startsWith('http://'))){
      const _m=((opts&&opts.method)||'GET').toUpperCase();
      if(_m==='GET'){
        const _hd={};
        try{
          const _h=opts&&opts.headers?(opts.headers instanceof Headers?Object.fromEntries(opts.headers.entries()):opts.headers):{};
          for(const[k,v]of Object.entries(_h||{}))if(_SAFE_H.has(k.toLowerCase()))_hd[k]=String(v);
        }catch{}
        return _relay(u,_hd,opts&&opts.signal);
      }
    }
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

// Preview iframes are sandboxed without allow-same-origin, so their requests carry Origin "null",
// which the CF proxy rejects. Their fetch shim posts cross-origin GETs here instead; this page
// fetches them through the proxy with its own origin and posts the response back.
const _RELAY_SAFE_HEADERS = new Set(['accept', 'accept-language', 'cache-control', 'referer', 'x-requested-with']);

function _isPreviewWindow(win: MessageEventSource | null): boolean {
    if (!win) return false;
    for (const f of document.querySelectorAll('iframe.artifact-iframe'))
        if ((f as HTMLIFrameElement).contentWindow === win) return true;
    return false;
}

async function _relayPreviewFetch(e: MessageEvent) {
    const d = e.data;
    if (!d || d.type !== 'fg-fetch' || typeof d.id !== 'number' || typeof d.url !== 'string') return;
    if (!_isPreviewWindow(e.source)) return;
    const src = e.source as Window;
    try {
        const proxy = typeof getEffectiveProxy === 'function' ? getEffectiveProxy() : '';
        if (!proxy) throw new Error('no CORS proxy configured');
        const _parsedRelayUrl = new URL(d.url);
        const { protocol } = _parsedRelayUrl;
        if (protocol !== 'https:' && protocol !== 'http:') throw new Error('only http(s) URLs can be fetched');
        // Address policy lives in the proxy (dev-api.ts publicGet / the CF Worker's _publicUrlOk):
        // relayed GETs reach public addresses only, checked when the connection is made.
        if (_parsedRelayUrl.host === window.location.host) throw new Error('the FreeGent server itself cannot be relayed');
        let url = `${proxy}?url=${encodeURIComponent(d.url)}`;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(d.headers || {}))
            if (_RELAY_SAFE_HEADERS.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
        if (Object.keys(headers).length) url += `&h=${btoa(JSON.stringify(headers))}`;
        const resp = await fetch(url);
        const body = await resp.arrayBuffer();
        // The proxy's own failures (blocked URL, upstream unreachable) must not look like the
        // upstream's response, or apps parse the proxy's {"error": …} JSON as data.
        if (resp.headers.get('X-FG-Proxy-Error')) {
            let msg = '';
            try { msg = JSON.parse(new TextDecoder().decode(body)).error; } catch {}
            throw new Error(`proxy: ${msg || `HTTP ${resp.status}`}`);
        }
        src.postMessage({ type: 'fg-fetch-result', id: d.id, status: resp.status, statusText: resp.statusText,
            headers: [...resp.headers], body }, '*', [body]);
    } catch (err) {
        src.postMessage({ type: 'fg-fetch-result', id: d.id, error: String((err as Error)?.message || err) }, '*');
    }
}
window.addEventListener('message', _relayPreviewFetch);

// ── check_page: run a workspace page headlessly and report what happens ──────
// The page is built exactly like a ▶ Preview (workspace CSS/JS inlined, same sandbox) and loaded
// into a hidden iframe. A capture script injected first reports console output, uncaught errors
// and failed resources to this page, and answers commands (click, key, eval) posted to it.
// Agents otherwise debug "the button does nothing" by reading code: in the Cowork game chat of
// 2026-09-27 a syntax error (`const ring-count`) broke the whole script, and a later "nothing
// moves" turn spent 100 steps guessing. The sandbox has no allow-same-origin and no allow-modals
// (alert/confirm are ignored rather than blocking the run).
const _CHECK_CAPTURE = `<script>(function(){
var P=parent,T0=Date.now();
function s(v){try{if(typeof v==='string')return v;if(v instanceof Error)return v.name+': '+v.message;if(v===undefined)return 'undefined';if(typeof v==='function')return 'function';return JSON.stringify(v)}catch(e){return String(v)}}
function send(l,t){try{P.postMessage({type:'fg-check-log',level:l,text:String(t).slice(0,500),t:Date.now()-T0},'*')}catch(e){}}
['log','info','warn','error','debug'].forEach(function(k){var o=console[k];console[k]=function(){send(k,[].map.call(arguments,s).join(' '));try{o&&o.apply(console,arguments)}catch(e){}}});
addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){send('error','Failed to load resource: '+(t.src||t.href)+(t.integrity?' — it has integrity="'+t.integrity+'": a wrong hash blocks the file, so check it or remove the attribute':''));return}
 send('error','Uncaught '+(e.error&&e.error.name?e.error.name+': '+e.error.message:e.message)+(e.lineno?' (line '+e.lineno+':'+e.colno+' of the inlined page)':''))},true);
addEventListener('unhandledrejection',function(e){send('error','Unhandled promise rejection: '+s(e.reason))});
var FR=0;(function f(){FR++;requestAnimationFrame(f)})();
function code(k){if(/^Arrow/.test(k))return k;if(k===' ')return 'Space';if(/^[a-z]$/i.test(k))return 'Key'+k.toUpperCase();if(/^[0-9]$/.test(k))return 'Digit'+k;return k}
function run(d){
 if(d.cmd==='click'){var el=document.querySelector(d.selector);if(!el)return{error:'no element matches '+d.selector};
  var r=el.getBoundingClientRect(),cs=getComputedStyle(el),o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,view:window};
  ['pointerdown','mousedown','pointerup','mouseup'].forEach(function(t){try{el.dispatchEvent(new (t.charAt(0)==='p'&&window.PointerEvent?PointerEvent:MouseEvent)(t,o))}catch(e){}});
  el.click();return{ok:true,visible:cs.display!=='none'&&cs.visibility!=='hidden'&&r.width>0&&r.height>0,disabled:!!el.disabled}}
 if(d.cmd==='key'){var tg=document.activeElement||document.body;tg.dispatchEvent(new KeyboardEvent(d.kind,{key:d.key,code:code(d.key),bubbles:true,cancelable:true}));return{ok:true}}
 if(d.cmd==='eval'){return{value:s((0,eval)(d.expr)).slice(0,300)}}
 if(d.cmd==='stats'){return{frames:FR,ms:Date.now()-T0}}
 return{error:'unknown command'}}
addEventListener('message',function(e){var d=e.data;if(e.source!==P||!d||d.type!=='fg-check-cmd')return;var r;try{r=run(d)}catch(x){r={error:String(x&&x.message||x)}}
 P.postMessage({type:'fg-check-reply',id:d.id,result:r},'*')});
addEventListener('load',function(){P.postMessage({type:'fg-check-ready'},'*')});
})();<\/script>`;

const _sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const _clampMs = (v: any, dflt: number, max: number) => Math.max(0, Math.min(Number.isFinite(Number(v)) ? Number(v) : dflt, max));

async function runPageCheck(path: string, { actions = [] as any[], probes = [] as string[], waitMs = 1500 } = {}) {
    const html = await agentReadFile(path);
    if (typeof html !== 'string' || !html.trim()) return { error: `check_page: "${path}" is empty or could not be read` };
    let content = _wrapArtifact(await _inlineWorkspaceRefs(html, path));
    // The capture script must run before every other script, so it goes first in <head>.
    content = /<head[^>]*>/i.test(content) ? content.replace(/(<head[^>]*>)/i, `$1${_CHECK_CAPTURE}`) : _CHECK_CAPTURE + content;

    const iframe = document.createElement('iframe');
    // artifact-iframe: lets the page's cross-origin GETs use the preview fetch relay.
    iframe.className = 'artifact-iframe fg-check-iframe';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    // Rendered visibly, as a small live preview in the corner: browsers throttle
    // requestAnimationFrame in frames they consider hidden — a near-transparent frame behind the
    // app ran a game at ~3% speed (0.48 s of game time in ~15 s; fg-chat 2026-09-27-08-44-35), so
    // movement checks were meaningless. The page keeps a full 1024×640 layout, scaled down.
    const _W = 1024, _H = 640, _SCALE = 0.28;
    const wrap = document.createElement('div');
    wrap.className = 'fg-check-preview';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = `position:fixed;right:12px;bottom:12px;width:${Math.round(_W * _SCALE)}px;height:${Math.round(_H * _SCALE) + 18}px;`
        + 'z-index:2147483000;pointer-events:none;border-radius:6px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.35);'
        + 'background:#111;font:11px/18px system-ui,sans-serif;color:#ddd';
    const label = document.createElement('div');
    label.style.cssText = 'height:18px;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    label.textContent = `check_page · ${path}`;
    iframe.style.cssText = `display:block;width:${_W}px;height:${_H}px;border:0;background:#fff;transform:scale(${_SCALE});transform-origin:0 0`;
    wrap.append(label, iframe);

    const logs: Array<{ level: string; text: string; t: number }> = [];
    const pending = new Map<number, (r: any) => void>();
    let seq = 0, readyResolve: (v: boolean) => void = () => {};
    const ready = new Promise<boolean>(r => { readyResolve = r; });
    const onMsg = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        const d = e.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'fg-check-log' && logs.length < 500) logs.push({ level: d.level, text: d.text, t: d.t });
        else if (d.type === 'fg-check-ready') readyResolve(true);
        else if (d.type === 'fg-check-reply') { const p = pending.get(d.id); if (p) { pending.delete(d.id); p(d.result); } }
    };
    const cmd = (c: any): Promise<any> => new Promise(res => {
        const id = ++seq;
        pending.set(id, res);
        iframe.contentWindow?.postMessage({ type: 'fg-check-cmd', id, ...c }, '*');
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: 'no reply — the page script is not running or is stuck' }); } }, 3000);
    });

    const steps: any[] = [];
    let loaded = false, fps: number | null = null;
    window.addEventListener('message', onMsg);
    try {
        iframe.srcdoc = content;
        document.body.appendChild(wrap);
        loaded = await Promise.race([ready, _sleep(8000).then(() => false)]);
        await _sleep(300);
        const probeAll = async (when: string) => {
            if (!probes.length) return;
            const values: Record<string, string> = {};
            for (const expr of probes) { const r = await cmd({ cmd: 'eval', expr }); values[expr] = r.error ? `error: ${r.error}` : r.value; }
            steps.push({ probes: when, values });
        };
        await probeAll('after load');
        for (const a of actions.slice(0, 20)) {
            if (!a || typeof a !== 'object') continue;
            if (typeof a.click === 'string') {
                steps.push({ click: a.click, ...(await cmd({ cmd: 'click', selector: a.click })) });
            } else if (typeof a.key === 'string') {
                const hold = _clampMs(a.hold_ms, 0, 5000);
                const down = await cmd({ cmd: 'key', kind: 'keydown', key: a.key });
                if (hold) await _sleep(hold);
                await cmd({ cmd: 'key', kind: 'keyup', key: a.key });
                steps.push({ key: a.key, held_ms: hold, ...(down.error ? { error: down.error } : {}) });
            } else if (a.wait_ms != null) {
                const w = _clampMs(a.wait_ms, 0, 5000);
                await _sleep(w);
                steps.push({ waited_ms: w });
            }
            await _sleep(100);   // let handlers and a frame or two run
        }
        await _sleep(_clampMs(waitMs, 1500, 10000));
        await probeAll('at end');
        const st = await cmd({ cmd: 'stats' });
        if (typeof st?.frames === 'number' && st.ms > 0) fps = Math.round(st.frames / (st.ms / 1000));
    } finally {
        window.removeEventListener('message', onMsg);
        wrap.remove();
    }

    // Collapse repeats (an error thrown every frame shows once, with a count).
    const collapse = (items: typeof logs, max: number) => {
        const out: Array<{ text: string; count: number; first_ms: number }> = [];
        const byText = new Map<string, { text: string; count: number; first_ms: number }>();
        for (const l of items) {
            const e = byText.get(l.text);
            if (e) { e.count++; continue; }
            const n = { text: l.text, count: 1, first_ms: l.t };
            byText.set(l.text, n); out.push(n);
        }
        return out.slice(0, max);
    };
    const errors = collapse(logs.filter(l => l.level === 'error'), 20);
    const warnings = collapse(logs.filter(l => l.level === 'warn'), 10);
    const consoleOut = collapse(logs.filter(l => l.level !== 'error' && l.level !== 'warn'), 30);
    const notes: string[] = [];
    if (!loaded) notes.push('The page did not finish loading within 8 s.');
    if (fps !== null && fps < 20) notes.push(`Animation frames ran at only ~${fps} fps (browser throttling), so game time advanced far slower than real time — treat movement and timing results as unreliable.`);
    if (document.hidden) notes.push('The FreeGent tab was in the background, so the browser paused animation frames — movement and timers may look frozen; re-run with the tab visible.');
    const summary = !errors.length
        ? `Loaded ${loaded ? 'fine' : 'partially'}; no errors.`
        : `${errors.reduce((n, e) => n + e.count, 0)} error(s): ${errors[0].text}`;
    return {
        path, loaded, summary, ...(fps !== null ? { fps } : {}),
        errors, ...(warnings.length ? { warnings } : {}), console: consoleOut,
        ...(steps.length ? { steps } : {}), ...(notes.length ? { notes } : {}),
    };
}

// title is the page's workspace path when it is a workspace file; its references resolve from there.
async function openArtifactTab(title, html, { isPreview = true } = {}) {
    const inlined = await _inlineWorkspaceRefs(html, title);
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
Object.assign(window, { activateTab, openFileTab, closeFileTab, openArtifactTab, runPageCheck, notifyLocalFileChanged, toggleRailExpanded, closeMobileRail, toggleChatToolbar, expandChatToolbar });
