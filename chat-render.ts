// chat-render.js — FreeGent: markdown rendering, message UI, sequence graph
// Depends on: config.js, state.js (mainAgentRole).
import { mainAgentRole } from './state.js';
import { type RenderAdapter } from './render-adapter.js';
import { _stripTerminal } from './turn-protocol.js';

// ── Media rendering helpers ────────────────────────────────────────────────

// Render SVG text as a sandboxed iframe with srcdoc — same mechanism as the artifact preview tab.
// <object> blob URLs are often blocked by CSP (object-src 'none' is a common default).
// The iframe forces SVG to fill 100% of its box; aspect-ratio keeps proportions correct.
function _makeSvgObject(svgText) {
    const wm = svgText.match(/<svg[^>]*\bwidth="([\d.]+)"/i);
    const hm = svgText.match(/<svg[^>]*\bheight="([\d.]+)"/i);
    const vb = svgText.match(/\bviewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"/i);
    const w  = parseFloat(wm?.[1] ?? vb?.[1] ?? '0') || 400;
    const h  = parseFloat(hm?.[1] ?? vb?.[2] ?? '0') || 400;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.cssText = `display:block;width:min(100%,${w}px);aspect-ratio:${w}/${h};border:none;border-radius:6px;margin:6px 0;`;
    iframe.srcdoc = `<!DOCTYPE html><html><head><style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}svg{width:100%!important;height:100%!important;display:block;}</style></head><body>${svgText}</body></html>`;
    return iframe;
}

// Route a data-URI or SVG text to the right element type.
// Models sometimes line-wrap base64 strings; strip all whitespace before decoding.
function _makeMediaEl(src, alt = '') {
    const cleanSrc = src.replace(/\s/g, '');
    if (/^data:image\/svg\+xml/i.test(cleanSrc)) {
        try {
            let svgText: string;
            if (/^data:image\/svg\+xml;base64,/i.test(cleanSrc)) {
                svgText = atob(cleanSrc.replace(/^data:image\/svg\+xml;base64,/i, ''));
            } else {
                // URL-encoded form: data:image/svg+xml,... or data:image/svg+xml;charset=utf-8,...
                svgText = decodeURIComponent(cleanSrc.replace(/^data:image\/svg\+xml[^,]*,/i, ''));
            }
            return _makeSvgObject(svgText);
        } catch (e) {
            const div = document.createElement('div');
            div.className = 'chat-media-img';
            div.style.cssText = 'padding:8px;color:var(--text-muted,#888);font-size:0.85em;';
            div.textContent = `[SVG decode error: ${e.message}]`;
            return div;
        }
    }
    const img = document.createElement('img');
    img.src = cleanSrc; img.alt = alt; img.className = 'chat-media-img';
    img.onerror = () => {
        const div = document.createElement('div');
        div.className = 'chat-media-img';
        div.style.cssText = 'padding:8px;color:var(--text-muted,#888);font-size:0.85em;';
        div.textContent = `[Image failed to load${alt ? ': ' + alt : ''}]`;
        img.replaceWith(div);
    };
    return img;
}

// Module-level store: renderMarkdown() writes, processImgSlots() reads+clears.
let _mdImgStore: { src?: string; alt?: string; rawSvg?: string }[] = [];

// After setting container.innerHTML = renderMarkdown(...), call this to materialise
// the placeholder <div>s into real media elements.  Also catches any data-URI <img>s
// that marked happened to pass through unchanged.
export function processImgSlots(container: any): void {
    const store = _mdImgStore;
    _mdImgStore = [];
    container.querySelectorAll('div.md-img-slot[data-slot]').forEach(div => {
        const e = store[+div.dataset.slot];
        if (!e) return;
        if (e.rawSvg) {
            div.replaceWith(_makeSvgObject(e.rawSvg));
        } else {
            div.replaceWith(_makeMediaEl(e.src, e.alt));
        }
    });
    // Belt-and-suspenders: catch any SVG/raster imgs marked may have rendered directly
    container.querySelectorAll('img[src^="data:image/"]').forEach(img => {
        img.replaceWith(_makeMediaEl(img.src, img.alt));
    });
    // Wrap any bare <svg> elements that marked passed through as DOM nodes
    container.querySelectorAll('svg').forEach(svgEl => {
        if (!svgEl.closest('iframe')) svgEl.replaceWith(_makeSvgObject(svgEl.outerHTML));
    });
    // Resolve workspace filenames: model wrote ![alt](filename.svg) → marked → <img src="filename.svg">
    // If the filename exists in _pyodideImageStore, replace with the real image.
    container.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || '';
        if (!src || src.startsWith('data:') || /^https?:\/\/|^\/\//.test(src)) return;
        const stored = _pyodideImageStore?.[src];
        if (!stored) return;
        if (typeof stored === 'object' && stored.type === 'svg') {
            img.replaceWith(_makeSvgObject(stored.content));
        } else {
            const dataUrl = typeof stored === 'string' ? stored : stored.dataUrl || '';
            img.replaceWith(_makeMediaEl(dataUrl, img.alt));
        }
    });
}
window.processImgSlots = processImgSlots;

// Regex for strings that look like workspace file paths (with a meaningful extension).
// Matches bare filenames (game.html) and relative paths (src/index.ts, data/out.json).
// Deliberately conservative: no spaces, no absolute paths, no URLs.
const _FILE_PATH_RE = /^[\w][\w\-.]*(?:\/[\w\-.]+)*\.(html?|svg|js|ts|jsx|tsx|json|md|txt|py|css|csv|yaml|yml|toml|xml|ini|png|jpe?g|gif|webp|pdf)$/i;

// Regex for absolute /workspace/... paths the model may write without backticks.
// Captures the portion after the /workspace/ prefix as the relative workspace path.
const _WS_PATH_RE = /\/workspace\/([\w][\w\-.]*(?:\/[\w\-.]+)*\.(?:html?|svg|js|ts|jsx|tsx|json|md|txt|py|css|csv|yaml|yml|toml|xml|ini|png|jpe?g|gif|webp|pdf))/gi;

// Build an anchor element that opens a workspace file in a tab.
function _makeFileLink(displayText: string, filePath: string): HTMLAnchorElement {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'file-link';
    a.title = `Open ${filePath}`;
    a.textContent = displayText;
    a.onclick = async (e: MouseEvent) => {
        e.preventDefault();
        // HTML and SVG render natively in an iframe — open them directly in the artifact preview.
        if (/\.(html?|svg)$/i.test(filePath)) {
            try {
                const content = await agentReadFile?.(filePath);
                if (content != null) { openArtifactTab?.(filePath, content); return; }
            } catch {}
        }
        openFileTab?.(filePath);
    };
    return a;
}

// After renderMarkdown + processImgSlots, scan inline <code> elements for file paths and
// scan plain text nodes for absolute /workspace/... paths, then wrap them in clickable
// links that open the file in a tab (same behaviour as the Projects tab).
export function processFileLinks(container: any): void {
    // 1. Inline <code> elements: relative paths (existing behaviour) + /workspace/... absolute paths
    container.querySelectorAll('code').forEach((codeEl: HTMLElement) => {
        if (codeEl.closest('pre') || codeEl.closest('a')) return; // skip blocks & already-linked
        const text = codeEl.textContent?.trim() ?? '';
        // Strip optional leading /workspace/ prefix for absolute workspace paths
        const wsMatch = text.match(/^\/workspace\/([\w][\w\-.]*(?:\/[\w\-.]+)*\.(?:html?|svg|js|ts|jsx|tsx|json|md|txt|py|css|csv|yaml|yml|toml|xml|ini|png|jpe?g|gif|webp|pdf))$/i);
        const filePath = wsMatch ? wsMatch[1] : (_FILE_PATH_RE.test(text) ? text : null);
        if (!filePath) return;

        const a = _makeFileLink(text, filePath);
        codeEl.parentNode!.insertBefore(a, codeEl);
        a.textContent = '';   // _makeFileLink sets textContent as label; clear before wrapping the <code> el
        a.appendChild(codeEl);
    });

    // 2. Plain text nodes: linkify bare /workspace/... references not already in <code> or <a>
    const _walkTextNodes = (node: Node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            if (el.tagName === 'A' || el.tagName === 'PRE' || el.tagName === 'CODE') return;
            Array.from(node.childNodes).forEach(_walkTextNodes);
        } else if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent ?? '';
            if (!text.includes('/workspace/')) return;
            _WS_PATH_RE.lastIndex = 0;
            const parts: (string | HTMLAnchorElement)[] = [];
            let last = 0, m: RegExpExecArray | null;
            while ((m = _WS_PATH_RE.exec(text)) !== null) {
                if (m.index > last) parts.push(text.slice(last, m.index));
                parts.push(_makeFileLink(m[0], m[1]));
                last = m.index + m[0].length;
            }
            if (!parts.length) return;
            if (last < text.length) parts.push(text.slice(last));
            const frag = document.createDocumentFragment();
            parts.forEach(p => frag.appendChild(typeof p === 'string' ? document.createTextNode(p) : p));
            node.parentNode?.replaceChild(frag, node);
        }
    };
    _walkTextNodes(container);

    // 3. Workspace hrefs: intercept <a href="/workspace/..."> links produced by the markdown
    //    renderer (e.g. [file.html](/workspace/file.html)). These would navigate the browser to
    //    a URL that isn't served, breaking mobile where a new tab opens to a 404. Rewire them
    //    to the same in-app handler used by _makeFileLink so tapping works on mobile.
    (container.querySelectorAll('a[href]') as NodeListOf<HTMLAnchorElement>).forEach((a) => {
        const href = a.getAttribute('href') ?? '';
        const wsMatch = href.match(/^\/workspace\/([\w][\w\-.]*(?:\/[\w\-.]+)*\.(?:html?|svg|js|ts|jsx|tsx|json|md|txt|py|css|csv|yaml|yml|toml|xml|ini|png|jpe?g|gif|webp|pdf))$/i);
        if (!wsMatch) return;
        const filePath = wsMatch[1];
        a.setAttribute('href', '#');
        a.removeAttribute('target');
        a.removeAttribute('rel');
        a.classList.add('file-link');
        a.title = `Open ${filePath}`;
        a.onclick = async (e: MouseEvent) => {
            e.preventDefault();
            if (/\.(html?|svg)$/i.test(filePath)) {
                try {
                    const content = await agentReadFile?.(filePath);
                    if (content != null) { openArtifactTab?.(filePath, content); return; }
                } catch {}
            }
            openFileTab?.(filePath);
        };
    });
}
window.processFileLinks = processFileLinks;

// Render tool output text, substituting [IMAGE:name] markers with media elements.
function _renderOutputText(pre, text) {
    pre.innerHTML = '';
    if (!text) return;
    const parts = text.split(/(\[IMAGE:[^\]]+\])/);
    for (const part of parts) {
        const m = part.match(/^\[IMAGE:([^\]]+)\]$/);
        const stored = m ? _pyodideImageStore?.[m[1]] : null;
        if (stored) {
            if (typeof stored === 'object' && stored.type === 'svg') {
                pre.appendChild(_makeSvgObject(stored.content));
            } else {
                pre.appendChild(_makeMediaEl(typeof stored === 'string' ? stored : stored.dataUrl, m[1]));
            }
        } else {
            pre.appendChild(document.createTextNode(part));
        }
    }
}

// ── Step label friendlification ────────────────────────────────────────────
// Maps raw internal step labels to human-readable verb phrases for the graph badges.

function _friendlyLabel(raw) {
    if (!raw) return raw;
    const s = raw.trim();

    // Worker role labels — e.g. "worker:W1:researcher", "worker:W2:coder"
    if (s.startsWith('worker:')) {
        const parts = s.slice(7).split(':');
        // Label format is "worker:id:role" — role is always parts[1] (line 1011 in workers.ts
        // guarantees every agent has a role before labels are built; id is an internal key).
        const id = parts[1].toLowerCase();
        if (/director/i.test(id))             return 'Directing';
        if (/orchestrat/i.test(id))           return 'Orchestrating';
        if (/planner?$/i.test(id) || id === 'plan' || id === 'replan') return 'Planning';
        if (/research/i.test(id))             return 'Researching';
        if (/cod(e|er|ing)/i.test(id))        return 'Coding';
        if (/synthes/i.test(id))              return 'Synthesising';
        if (/reduc/i.test(id))                return 'Reducing';
        if (/review/i.test(id))               return 'Reviewing';
        if (/config.*read|read.*config/i.test(id)) return 'Reading config';
        if (/ui.*config|config.*ui/i.test(id))     return 'Reading UI config';
        if (/task.*find|find.*task/i.test(id))     return 'Finding tasks';
        if (/search/i.test(id))               return 'Searching';
        if (/find/i.test(id))                 return 'Finding';
        if (/read/i.test(id))                 return 'Reading';
        if (/write|generat|creat/i.test(id))  return 'Writing';
        if (/analys|analyz/i.test(id))        return 'Analysing';
        if (/test|verif/i.test(id))           return 'Verifying';
        if (/fix|patch|repair/i.test(id))     return 'Fixing';
        if (/plan/i.test(id))                 return 'Planning';
        if (/locat|disambig/i.test(id))       return 'Locating';
        if (/resolv/i.test(id))               return 'Resolving';
        // Capitalise unknown role ids, replacing underscores/hyphens with spaces
        return id.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    // Special named steps
    if (/^Thinking/i.test(s))           return 'Working';
    if (/^compact/i.test(s))            return 'Compacting';
    if (/summariz/i.test(s))            return 'Synthesising';

    if (/resolv.*conflict/i.test(s))    return 'Resolving';
    if (s.startsWith('read:'))          return 'Reading';
    if (s.startsWith('write:'))         return 'Writing';
    if (s.startsWith('replace:') && s.includes('ledger.md')) return 'Updating ledger';
    if (s.startsWith('replace:'))       return 'Editing';
    if (s.startsWith('patch:'))         return 'Patching';
    if (s.startsWith('append:'))        return 'Appending';
    if (s.startsWith('del:'))           return 'Deleting';
    if (s.startsWith('undo:'))          return 'Undoing';
    if (s.startsWith('search:'))        return 'Searching';
    if (s.startsWith('wiki:'))          return 'Looking up';
    if (s.startsWith('fetch:'))         return 'Fetching';
    if (s.startsWith('context7_'))     return 'Looking up docs';
    if (s.startsWith('grep:'))          return 'Searching';
    if (s.startsWith('arxiv:'))         return 'Researching';
    if (s.startsWith('s2:'))            return 'Researching';
    if (s.startsWith('sem:'))           return 'Searching';
    if (s.startsWith('repo_map'))       return 'Mapping';
    if (s.startsWith('exec('))          return 'Executing';
    if (s.startsWith('workers(')) {
        // Parse role from "id:role" segments, e.g. "workers(news:researcher,code:coder)"
        const inner = s.slice(8, -1);
        const roles = inner ? inner.split(',').map(a => { const p = a.split(':'); return p[1] || ''; }).filter(Boolean) : [];
        const r = roles[0] || '';
        if (/research/i.test(r))              return 'Researching';
        if (/cod(e|er|ing)/i.test(r))         return 'Coding';
        if (/synthes/i.test(r))               return 'Synthesising';
        if (/review/i.test(r))                return 'Reviewing';
        if (/planner?$|^plan$/i.test(r))      return 'Planning';
        if (/director|orchestrat/i.test(r))   return 'Directing';
        if (/find|search/i.test(r))           return 'Searching';
        if (/write|generat|creat/i.test(r))   return 'Writing';
        return 'Delegating';
    }
    if (s.startsWith('task:'))          return 'Updating task';
    // entity memory removed
    if (s.startsWith('git '))           return 'Git';
    if (s === 'list_files')             return 'Listing files';

    // Fallback for any unrecognized label. Strip angle-bracket markup and clamp length so a
    // malformed input (e.g. a model emitting an XML block as a tool name) can't dump a wall
    // of text or raw tags into a step badge.
    const clean = s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    return clean.length > 48 ? clean.slice(0, 45) + '…' : clean;
}


// SVG element tag names that may appear as leaked fragments after a truncated data-URI SVG.
const _SVG_TAGS = 'g|path|circle|ellipse|rect|line|polygon|polyline|text|tspan|defs|' +
    'animate|animateTransform|animateMotion|use|symbol|linearGradient|radialGradient|' +
    'stop|clipPath|mask|filter|foreignObject|image|title|desc';
// Matches a run of SVG XML fragments: comments + SVG open/close/self-closing tags.
const _SVG_FRAG_RE = new RegExp(
    '^((?:\\s|<!--[\\s\\S]*?-->|</?(?:' + _SVG_TAGS + ')[^>]*\\/?>)*)',
    'i'
);

export function renderMarkdown(text: any): any {
    _mdImgStore = [];

    // Step 0: Pre-render math expressions before marked.parse so that $$ / \( delimiters
    // are not escaped as text.  Rendered HTML is stashed and restored after DOMPurify.
    const _mathParts: string[] = [];
    if (typeof katex !== 'undefined') {
        let s: string = typeof text === 'string' ? text : String(text ?? '');
        // Block math: $$...$$ (newline-separated display equations)
        s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
            try {
                const html = katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false });
                return `<div class="fg-math-block">%%FWMATH${_mathParts.push(html) - 1}%%</div>`;
            } catch { return `$$${expr}$$`; }
        });
        // Block math: \[...\]
        s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => {
            try {
                const html = katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false });
                return `<div class="fg-math-block">%%FWMATH${_mathParts.push(html) - 1}%%</div>`;
            } catch { return `\\[${expr}\\]`; }
        });
        // Inline math: \(...\)
        s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => {
            try {
                const html = katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false });
                return `<span class="fg-math-inline">%%FWMATH${_mathParts.push(html) - 1}%%</span>`;
            } catch { return `\\(${expr}\\)`; }
        });
        text = s;
    }

    // Step 1: Replace data-URI <img> tags with short indexed placeholders.
    // Very long base64 src attributes cause marked's HTML-block regex to silently fail,
    // leaving the raw tag as visible text.  The <div class="md-img-slot"> placeholder is
    // a block element marked always passes through; processImgSlots() resolves it later.
    let preprocessed: string = text.replace(
        /<img\s[^>]*src="(data:[^"]+)"[^>]*\/?>/gi,
        (match, src) => {
            const alt = (match.match(/\balt="([^"]*)"/) || [])[1] || '';
            return `<div class="md-img-slot" data-slot="${_mdImgStore.push({src, alt}) - 1}"></div>`;
        }
    );

    // Step 1b: Replace markdown ![alt](data:...) image syntax before marked processes it.
    // marked can silently drop or mangle very long data URIs in link/image syntax.
    preprocessed = preprocessed.replace(
        /!\[([^\]]*)\]\((data:[^)\s]+)\)/g,
        (_, alt, src) => `<div class="md-img-slot" data-slot="${_mdImgStore.push({src: src.replace(/\s/g, ''), alt}) - 1}"></div>`
    );

    // Step 1c: Replace [IMAGE:key] markers so models can re-embed tool-generated images.
    preprocessed = preprocessed.replace(
        /\[IMAGE:([^\]]+)\]/g,
        (_, key) => {
            const stored = _pyodideImageStore?.[key];
            if (!stored) return `[IMAGE:${key}]`;
            const entry = (typeof stored === 'object' && stored.type === 'svg')
                ? { rawSvg: stored.content }
                : { src: typeof stored === 'string' ? stored : stored.dataUrl, alt: key };
            return `<div class="md-img-slot" data-slot="${_mdImgStore.push(entry) - 1}"></div>`;
        }
    );

    // Step 2: Replace bare <svg>...</svg> blocks with placeholders.
    // Models sometimes output SVG markup directly rather than as a data URI.
    preprocessed = preprocessed.replace(
        /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
        match => `<div class="md-img-slot" data-slot="${_mdImgStore.push({rawSvg: match}) - 1}"></div>`
    );

    // Step 3: Fix truncated SVG data URIs.
    // Models occasionally base64-encode only the beginning of the SVG and then continue
    // writing the remaining XML as plain text.  Detect this by checking if the decoded SVG
    // is missing </svg>, then pull in the leaked SVG element fragments that follow the slot
    // and reconstruct a complete SVG.
    for (let i = 0; i < _mdImgStore.length; i++) {
        const e = _mdImgStore[i];
        if (e.rawSvg || !/^data:image\/svg\+xml;base64,/i.test((e.src || '').trim())) continue;
        let svgText: string;
        try {
            svgText = atob(e.src.replace(/^data:image\/svg\+xml;base64,/i, '').replace(/\s/g, ''));
        } catch { continue; }
        if (/<\/svg>/i.test(svgText)) continue; // Complete — no fix needed

        const placeholder = `<div class="md-img-slot" data-slot="${i}"></div>`;
        const idx = preprocessed.indexOf(placeholder);
        if (idx < 0) continue;
        const after = preprocessed.slice(idx + placeholder.length);
        const m = after.match(_SVG_FRAG_RE);
        if (!m || !m[1].trim()) continue;

        const leaked = m[1];
        const hasClose = /<\/svg>/i.test(leaked);
        _mdImgStore[i] = { rawSvg: svgText + leaked + (hasClose ? '' : '\n</svg>') };
        preprocessed = preprocessed.slice(0, idx + placeholder.length) + after.slice(leaked.length);
    }

    if (typeof marked !== 'undefined' && marked) {
        try {
            const raw = marked.parse(preprocessed, { gfm: true, breaks: true });
            // Sanitize before setting innerHTML — DOMPurify strips injected scripts and
            // event handlers while preserving benign HTML. ADD_ATTR keeps target="_blank"
            // that the replace below adds. Falls back to HTML-escaped text if DOMPurify absent.
            let html = (typeof DOMPurify !== 'undefined')
                ? DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] })
                : raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html = html.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
            // Restore pre-rendered math (%%FWMATH0%% placeholders survive DOMPurify as text)
            if (_mathParts.length) {
                html = html.replace(/%%FWMATH(\d+)%%/g, (_, i) => _mathParts[+i] ?? '');
            }
            return html;
        } catch {}
    }
    // Fallback: escape everything but preserve our short placeholder divs
    return preprocessed
        .split(/(<div class="md-img-slot"[^>]*><\/div>)/g)
        .map(chunk => chunk.startsWith('<div class="md-img-slot"') ? chunk :
            chunk.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                 .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                 .replace(/`([^`]+)`/g, '<code>$1</code>')
                 .replace(/\n/g, '<br>'))
        .join('');
}

// Build a self-contained HTML page showing Python execution output.
// stdout lines that are [IMAGE:name] markers are resolved from _pyodideImageStore.
function _buildPyOutput({ stdout = '', stderr = '', exit_code = 0 } = {}) {
    let body: string = '';
    for (const line of (stdout || '').split('\n')) {
        const m = line.match(/^\[IMAGE:(.+)\]$/);
        if (m) {
            const stored = _pyodideImageStore?.[m[1]];
            if (stored) {
                if (typeof stored === 'object' && stored.type === 'svg') {
                    body += stored.content + '\n';
                } else {
                    const src = typeof stored === 'string' ? stored : stored.dataUrl;
                    body += `<img src="${src}" style="max-width:100%;margin:4px 0;display:block;">\n`;
                }
                continue;
            }
        }
        body += `<span class="out">${esc(line)}\n</span>`;
    }
    if (stderr) body += `<pre class="err">${esc(stderr)}</pre>`;
    if (exit_code) body += `<div class="exit">Exit: ${exit_code}</div>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Consolas,Monaco,monospace;font-size:13px;background:#1a1a1a;color:#d4d4d4;padding:12px}
.out{white-space:pre-wrap;display:block}
.err{color:#f48771;white-space:pre-wrap;margin-top:8px}
.exit{color:#808080;margin-top:8px;font-size:.85em}
img{max-width:100%;border-radius:4px;margin:4px 0}
svg{max-width:100%}
</style></head><body>${body || '<span class="out">(no output)</span>'}</body></html>`;
}

export function cleanResponse(text: any): any {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*/gi, '')          // unclosed <think> to EOT
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<thinking>[\s\S]*/gi, '')       // unclosed <thinking> to EOT
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/<thought>[\s\S]*/gi, '')        // unclosed <thought> to EOT
        .replace(/(<\/think>|<\/thinking>|<\/thought>)\s*/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ── Message helpers ────────────────────────────────────────────────────────

export function getMessagesEl(containerId: string | undefined = 'agent-messages'): HTMLElement | null { return document.getElementById(containerId); }

export function scrollBottom(el: any, threshold: number | undefined = 80): void {
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold)
        el.scrollTop = el.scrollHeight;
    // Keep jump-to-latest button state consistent after any programmatic scroll
    _updateScrollBtn?.();
}

export function appendMessage(role: any, html: any, container: HTMLElement | null | undefined = null): HTMLDivElement {
    const msgs = container || getMessagesEl();
    const div  = document.createElement('div');
    div.className = `agent-msg agent-msg-${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'agent-msg-bubble';
    bubble.innerHTML = html;
    div.appendChild(bubble);
    // Copy button on user turns — sits inside the bubble, top-right corner.
    // Hidden until the bubble is hovered (CSS: .agent-msg-user:hover .user-msg-copy-btn).
    // data-action persists in saved HTML so the delegation in init.ts can re-bind
    // the onclick after page reload (JS properties don't survive serialization).
    if (role === 'user') {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'user-msg-copy-btn';
        copyBtn.dataset.action = 'copy-user-message';
        copyBtn.textContent = '⎘';
        copyBtn.title = 'Copy message';
        // stopPropagation prevents the outer .agent-msg-user click handler (which
        // opens the edit dialog) from firing when the copy button is clicked.
        copyBtn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            // Clone the bubble and strip the copy button to get only the message text.
            const clone = bubble.cloneNode(true) as HTMLElement;
            clone.querySelector('[data-action="copy-user-message"]')?.remove();
            navigator.clipboard.writeText(clone.innerText.trim()).then(() => {
                copyBtn.textContent = '✓';
                setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500);
            }).catch(() => {
                copyBtn.textContent = '✗';
                setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500);
            });
        });
        bubble.appendChild(copyBtn);
    }
    msgs.appendChild(div);
    // Near-bottom guard (Zetaphor pattern §F): only snap scroll when the user
    // is already within threshold px of the bottom. Preserves position if they
    // have scrolled up to re-read earlier content.
    scrollBottom(msgs);
    if (role === 'model') addVoiceButtons?.();
    return div;
}

// ── Shared step-timer clock ────────────────────────────────────────────────
// One 100ms interval drives all active step elapsed-time labels instead of
// one interval per step, so N parallel workers cost one timer, not N.
const _activeStepTimers = new Set<{ start: number; el: HTMLElement }>();
let _stepClockId: ReturnType<typeof setInterval> | null = null;

// Tracks which badge elements have had _attachClickInspect registered via markTruncated().
// WeakSet so badge GC is not blocked when the turn's DOM is removed during compaction.
const _clickInspectedBadges = new WeakSet<Element>();

function _addStepTimer(start: number, el: HTMLElement) {
    const entry = { start, el };
    _activeStepTimers.add(entry);
    // Headless (TUI / bench): el is a stub JSDOM element nobody renders — skip the
    // 100 ms interval that would tick 10×/s updating .textContent for nothing.
    if (window._fgHeadless) return entry;
    if (!_stepClockId) {
        // 100 ms on desktop (smooth sub-second display); 2 s on touch-only devices
        // (phones/tablets) — A5-era hardware stalls visibly at 10 Hz DOM updates.
        // navigator.maxTouchPoints is undefined on iOS ≤12; omit it.
        const _isTouchOnly = 'ontouchstart' in window
            && !window.matchMedia('(hover: hover)').matches;
        const _tickMs = _isTouchOnly ? 2000 : 100;
        _stepClockId = setInterval(() => {
            const now = Date.now();
            _activeStepTimers.forEach(t => { t.el.textContent = ` ${((now - t.start) / 1000).toFixed(1)}s`; });
        }, _tickMs);
    }
    return entry;
}

function _removeStepTimer(entry: { start: number; el: HTMLElement }) {
    _activeStepTimers.delete(entry);
    if (!_activeStepTimers.size && _stepClockId) { clearInterval(_stepClockId); _stepClockId = null; }
}

// ── Sequence graph / response placeholder ─────────────────────────────────

/** Add ▶ Run button to every `pre > code` block inside a rendered response element.
 *  Copy is intentionally omitted here — the single turn-level ⎘ at the bottom of
 *  each AI response handles copying; per-block copy buttons were visually noisy. */
function _addCodeBlockButtons(responseEl: HTMLElement): void {
    responseEl.querySelectorAll('pre > code').forEach(codeEl => {
        const pre = codeEl.parentElement!;

        // Syntax highlighting
        if (typeof hljs !== 'undefined') {
            try { hljs.highlightElement(codeEl as HTMLElement); } catch {}
        }

        // Run button — only for runnable languages
        const cls = [...codeEl.classList].find(c => /^language-(html?|svg|jsx?|tsx?|py(?:thon)?)$/i.test(c));
        if (!cls) return;
        const btn = document.createElement('button');
        btn.className = 'artifact-run-btn'; btn.textContent = '▶ Run';

        if (/^language-py(?:thon)?$/i.test(cls)) {
            btn.onclick = async () => {
                btn.disabled = true; btn.textContent = '⏳ Running…';
                try {
                    const files = await getWorkspaceFilesDict?.() ?? {};
                    const _pyName = codeEl.textContent.match(/^#\s*(\S+\.py)\b/m)?.[1] ?? 'script.py';
                    const html = buildPyRunnerHtml?.(_pyName, codeEl.textContent, files);
                    if (html) {
                        openArtifactTab?.(_pyName, html);
                    } else {
                        openArtifactTab?.('python-output', _buildPyOutput({ stderr: 'Python runner not available', exit_code: 1 }));
                    }
                } catch (e) {
                    openArtifactTab?.('python-output', _buildPyOutput({ stderr: String(e), exit_code: 1 }));
                } finally {
                    btn.textContent = '▶ Run'; btn.disabled = false;
                }
            };
        } else {
            const isJs = /^language-jsx?$|^language-tsx?$/i.test(cls);
            btn.onclick = () => {
                const src = isJs
                    ? `<!DOCTYPE html><html><body><script>\n${codeEl.textContent}\n<\/script></body></html>`
                    : codeEl.textContent;
                openArtifactTab?.('artifact.html', src);
            };
        }
        pre.insertAdjacentElement('afterend', btn);
    });
}

/**
 * Parse a step label into a display role and job-name for the step badge.
 * Pure function — no side effects.
 */
function _parseStepRole(label: string): { role: string; jobName: string } {
    const friendly = _friendlyLabel(label);
    let role: string = 'System', jobName: string = friendly;
    if (label.startsWith('worker:')) {
        const parts = label.slice(7).split(':');
        role    = parts[1].replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    } else if (/^Thinking/i.test(label)) {
        const ci = label.indexOf(':');
        role    = ci >= 0 ? label.slice(ci + 1).replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Director';
        jobName = 'Working';
    } else if (label.startsWith('replace:') && label.includes('ledger.md')) {
        role = 'System'; jobName = 'Updating ledger';
    }
    return { role, jobName };
}

export function createResponsePlaceholder(container: null | undefined = null): RenderAdapter & { div: HTMLDivElement } {
    const msgs = container || getMessagesEl();
    // Close previous AI turn detail sections when a new response starts.
    msgs?.querySelectorAll('.agent-msg-model').forEach((prevDiv: any) => {
        ['.seq-graph-detail', '.seq-agg-detail'].forEach(sel => {
            const el = prevDiv.querySelector(sel);
            if (el && el.style.display !== 'none') { el.dataset.chidden = '1'; el.style.display = 'none'; }
        });
        const prevBtn = prevDiv.querySelector('.agent-turn-collapse-row > .step-toggle');
        if (prevBtn) prevBtn.textContent = '▶';
    });
    // Grab checkpoint row appended just before this call (agentSend flow).
    const _prevCkptRow = msgs?.lastElementChild?.classList.contains('agent-ckpt-row')
        ? msgs.lastElementChild as HTMLElement : null;
    // For multi-step native-FW turns (steps 2+, where there is no preceding checkpoint
    // row), remove the copy button from the previous model response so only the FINAL
    // response of a turn ends up with one.
    if (!_prevCkptRow) {
        const _modelMsgs = msgs?.querySelectorAll('.agent-msg-model');
        const _lastModel = _modelMsgs?.item(_modelMsgs.length - 1) as HTMLElement | null;
        _lastModel?.querySelector('[data-action="copy-response"]')?.remove();
    }
    const div  = document.createElement('div');
    div.className = 'agent-msg agent-msg-model';

    const bubble = document.createElement('div');
    bubble.className = 'agent-msg-bubble';

    const turnCollapseRow = document.createElement('div');
    turnCollapseRow.className = 'step-sub-label agent-turn-collapse-row';
    const turnCollapseBtn = document.createElement('button');
    turnCollapseBtn.className = 'step-toggle';
    turnCollapseBtn.textContent = '▼';
    turnCollapseRow.appendChild(turnCollapseBtn);
    // Step graph and event log toggles live inline on the same header row —
    // hidden until the first step / output arrives, at most one open at a time.
    const graphRowEl  = document.createElement('div');    graphRowEl.className  = 'seq-graph-row';
    const graphToggle = document.createElement('button'); graphToggle.className = 'step-toggle'; graphToggle.textContent = '▼';
    const graphLabel  = document.createElement('span');   graphLabel.className  = 'seq-graph-label'; graphLabel.textContent = 'Step graph';
    graphRowEl.append(graphToggle, graphLabel);
    graphRowEl.style.display = 'none'; // hidden until first step is added
    turnCollapseRow.appendChild(graphRowEl);

    const aggRowEl  = document.createElement('div');    aggRowEl.className  = 'seq-agg-row';
    const aggToggle = document.createElement('button'); aggToggle.className = 'step-toggle'; aggToggle.textContent = '▶';
    const aggLabel  = document.createElement('span');   aggLabel.className  = 'seq-agg-label'; aggLabel.textContent = 'Event log';
    aggRowEl.append(aggToggle, aggLabel);
    aggRowEl.style.display = 'none'; // hidden until first output chunk
    turnCollapseRow.appendChild(aggRowEl);

    // Inline checkpoint row content (Rewind, Rerun, model label) right-aligned on the same line.
    if (_prevCkptRow) {
        const ckptId = _prevCkptRow.dataset.checkpointId;
        const ckptGroup = document.createElement('div');
        ckptGroup.className = 'agent-ckpt-group';
        if (ckptId) {
            ckptGroup.dataset.checkpointId = ckptId;
            div.dataset.checkpointId = ckptId;
        }
        while (_prevCkptRow.firstChild) ckptGroup.appendChild(_prevCkptRow.firstChild);
        turnCollapseRow.appendChild(ckptGroup);
        _prevCkptRow.remove();
    }
    bubble.appendChild(turnCollapseRow);

    const graphEl    = document.createElement('div'); graphEl.className    = 'seq-graph';
    const liveEl     = document.createElement('div'); liveEl.className     = 'seq-live-detail';
    const selectedEl = document.createElement('div'); selectedEl.className = 'seq-selected-detail';

    // ── Step graph detail (direct bubble child, shown when first step arrives) ──
    const graphDetailEl = document.createElement('div'); graphDetailEl.className = 'seq-graph-detail';
    graphDetailEl.style.display = 'none'; // hidden until first step is added
    graphDetailEl.append(graphEl, liveEl, selectedEl);
    bubble.appendChild(graphDetailEl);

    // ── Aggregated output detail (direct bubble child) ────────────────────
    const aggDetail  = document.createElement('div'); aggDetail.className  = 'seq-agg-detail';
    aggDetail.style.display = 'none'; // starts collapsed; user can expand while streaming
    const aggContent = document.createElement('div'); aggContent.className = 'seq-agg-content';
    aggDetail.appendChild(aggContent);
    bubble.appendChild(aggDetail);

    div.appendChild(bubble);
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;

    let _turnCollapsed = false;
    turnCollapseRow.addEventListener('click', e => {
        e.stopPropagation();
        _turnCollapsed = !_turnCollapsed;
        const _collapseEls: any[] = [graphDetailEl, aggDetail];
        if (_turnCollapsed) {
            _collapseEls.forEach(el => {
                if (el.style.display !== 'none') { el.dataset.chidden = '1'; el.style.display = 'none'; }
            });
            turnCollapseBtn.textContent = '▶';
        } else {
            _collapseEls.forEach(el => {
                if (el.dataset.chidden) { delete el.dataset.chidden; el.style.display = ''; }
            });
            turnCollapseBtn.textContent = '▼';
        }
    });

    // Toggle handlers — at most one detail open at a time.
    // _userPreferEventLog: tracks whether the user has explicitly switched to the Event Log.
    // When true, new steps arriving do NOT auto-switch back to the Step Graph.
    let _userPreferEventLog = false;
    graphRowEl.addEventListener('click', e => {
        e.stopPropagation();
        const open = graphDetailEl.style.display === 'none';
        graphDetailEl.style.display = open ? '' : 'none';
        graphToggle.textContent = open ? '▼' : '▶';
        if (open) {
            _userPreferEventLog = false; // user switched to Step Graph
            if (aggDetail.style.display !== 'none') {
                aggDetail.style.display = 'none';
                aggToggle.textContent = '▶';
            }
        }
    });
    aggRowEl.addEventListener('click', e => {
        e.stopPropagation();
        const open = aggDetail.style.display === 'none';
        aggDetail.style.display = open ? '' : 'none';
        aggToggle.textContent = open ? '▼' : '▶';
        if (open) {
            _userPreferEventLog = true; // user switched to Event Log
            if (graphDetailEl.style.display !== 'none') {
                graphDetailEl.style.display = 'none';
                graphToggle.textContent = '▶';
            }
        } else {
            _userPreferEventLog = false; // user closed Event Log — reset preference
        }
    });

    let stepCount: number     = 0;
    let taskId: number        = 0;
    let selectedBadge: Element | null = null;
    const timers      = new Set<any>();
    let _finalized: boolean    = false;
    let _ghostCol: Element | null      = null; // last completed colEl kept visible until a newer step produces output
    let _ghostColClose: (() => void) | null = null; // deferred colTabs.close() — runs when ghost is actually removed
    const _liveHandles = new Set<any>(); // handles not yet complete/aborted — for stopAll cleanup

    // Streaming markdown preview — shows debounced rendered markdown as tokens arrive.
    // Replaced by the authoritative renderMarkdown() call in finalize().
    let _previewText   = '';
    let _previewTimer: ReturnType<typeof setTimeout> | null = null;
    let _previewEl: HTMLDivElement | null = null;
    // The handle returned by addThinkingTask() — the only one whose 'output' tokens
    // should accumulate into _previewText. Workers use addToolStep() handles and must
    // NOT feed the preview (their output is shown in step columns, not the main bubble).
    let _mainThinkHandle: any = null;
    function _refreshStreamPreview() {
        if (_finalized || !_previewText.trim()) return;
        if (!_previewEl) {
            _previewEl = document.createElement('div');
            _previewEl.className = 'agent-response-text agent-stream-preview';
            bubble.appendChild(_previewEl);
        }
        // Strip terminal tokens (COMPLETED/BLOCKED) from the live preview — they are
        // protocol markers, not content, and should not be visible to the user during streaming.
        try { _previewEl.innerHTML = renderMarkdown(_stripTerminal(_previewText)); } catch {}
        scrollBottom(msgs);
    }

    function _makeTabs(): {
        tabsEl: HTMLDivElement; contentEl: HTMLDivElement; pres: Record<string, HTMLPreElement>;
        openTab(name: string): void; getActive: () => string | null; close(): void;
    } {
        const TABS = ['Prompt', 'Thinking', 'Output', 'Request'];
        const tabsEl   = document.createElement('div'); tabsEl.className = 'step-tabs';
        const contentEl = document.createElement('div'); contentEl.className = 'step-tab-content';
        contentEl.style.display = 'none';
        const pres: Record<string, HTMLPreElement> = {}, btns: Record<string, HTMLButtonElement> = {};
        let active: string | null = null;

        for (const name of TABS) {
            const pre = document.createElement('pre');
            pre.className = 'step-content-pre'; pre.dataset.tabName = name; pre.style.display = 'none';
            contentEl.appendChild(pre);
            pres[name] = pre;

            const btn = document.createElement('button');
            btn.className = 'step-tab-btn'; btn.textContent = name;
            tabsEl.appendChild(btn);
            btns[name] = btn;

            btn.addEventListener('click', e => {
                e.stopPropagation();
                const scrollTop = msgs.scrollTop;
                if (active === name) { _set(null); } else { _set(name); }
                btn.blur();
                msgs.scrollTop = scrollTop;
            });
        }

        function _set(name) {
            if (active) { pres[active].style.display = 'none'; btns[active].classList.remove('step-tab-active'); }
            active = name;
            if (name) { pres[name].style.display = ''; btns[name].classList.add('step-tab-active'); contentEl.style.display = ''; }
            else { contentEl.style.display = 'none'; }
        }
        return {
            tabsEl, contentEl, pres,
            openTab(name) { if (active !== name) _set(name); },
            getActive: () => active,
            close() { _set(null); },
        };
    }

    function createTask(stepEl, label) {
        const stepId   = ++taskId;
        const badge    = document.createElement('div'); badge.className = 'seq-task seq-running';

        const { role, jobName } = _parseStepRole(label);
        const stepTitle = role === jobName ? `[${stepId}] ${role}` : `[${stepId}] ${role} · ${jobName}`;

        const labelEl     = document.createElement('span'); labelEl.className     = 'seq-task-label'; labelEl.textContent = stepTitle;
        const modelEl     = document.createElement('span'); modelEl.className     = 'seq-task-model';
        const tokenEl     = document.createElement('span'); tokenEl.className     = 'seq-task-tokens';
        const startTimeEl = document.createElement('span'); startTimeEl.className = 'seq-task-start';
        startTimeEl.textContent = new Date().toTimeString().slice(0, 8);
        const timerEl     = document.createElement('span'); timerEl.className     = 'seq-task-timer'; timerEl.textContent = '0.0s';
        const timeRowEl   = document.createElement('div');  timeRowEl.className   = 'seq-task-time-row';
        timeRowEl.append(startTimeEl, timerEl);
        badge.append(labelEl, modelEl, tokenEl, timeRowEl);
        stepEl.appendChild(badge);

        let aggEntry: HTMLElement | null = null, aggTabs: ReturnType<typeof _makeTabs> | null = null, entryTimeEl: HTMLElement | null = null, hdrModelEl: HTMLElement | null = null;
        const _triedModels = [];

        function _renderModelEls() {
            function _fill(el, prefix) {
                if (!el) return;
                el.innerHTML = '';
                if (!_triedModels.length) return;
                el.appendChild(document.createTextNode(prefix));
                _triedModels.forEach((m, i) => {
                    if (i > 0) el.appendChild(document.createTextNode(' '));
                    if (i < _triedModels.length - 1) {
                        const s = document.createElement('s'); s.textContent = m; el.appendChild(s);
                    } else {
                        el.appendChild(document.createTextNode(m));
                    }
                });
            }
            _fill(modelEl, ' ');
            _fill(hdrModelEl, ' · ');
        }
        function _fmtTime() { return new Date().toTimeString().slice(0, 8); }

        function _ensureAggEntry() {
            if (aggEntry) return;
            if (aggRowEl.style.display === 'none') aggRowEl.style.display = '';
            aggEntry = document.createElement('div'); aggEntry.className = 'seq-agg-entry';

            const entryRow = document.createElement('div'); entryRow.className = 'seq-agg-entry-row';
            const hdr      = document.createElement('div'); hdr.className = 'seq-agg-step-header';
            hdr.appendChild(document.createTextNode(stepTitle));
            hdrModelEl = document.createElement('span'); hdrModelEl.className = 'seq-agg-entry-model';
            hdr.appendChild(hdrModelEl);
            _renderModelEls();
            entryTimeEl = document.createElement('span'); entryTimeEl.className = 'seq-agg-entry-time';
            entryTimeEl.textContent = _fmtTime();
            hdr.appendChild(entryTimeEl);
            aggTabs = _makeTabs();
            entryRow.append(hdr, aggTabs.tabsEl);
            aggEntry.appendChild(entryRow);
            aggEntry.appendChild(aggTabs.contentEl);
            aggContent.appendChild(aggEntry);
        }

        const start      = Date.now();
        const _timerEntry = _addStepTimer(start, timerEl);
        timers.add(_timerEntry);

        // ── Live column ──────────────────────────────────────────────────────
        const colEl     = document.createElement('div'); colEl.className = 'seq-detail-col';
        const colHeader = document.createElement('div'); colHeader.className = 'seq-col-header';
        const colTitle  = document.createElement('span'); colTitle.textContent = stepTitle;
        const colTabs   = _makeTabs();
        colHeader.append(colTitle, colTabs.tabsEl);
        colEl.append(colHeader, colTabs.contentEl);
        liveEl.appendChild(colEl);

        let done: boolean = false, latestOut: HTMLSpanElement | null = null, latestThink: HTMLSpanElement | null = null, hasOutput: boolean = false, _scrollRafPending: boolean = false, _innerScrollRafPending: boolean = false;
        function commit(ref, set) { if (ref) ref.classList.remove('seq-stream-latest'); set(null); }

        function _attachClickInspect() {
            badge.addEventListener('click', () => {
                if (selectedBadge === badge) {
                    badge.classList.remove('seq-selected'); selectedEl.innerHTML = ''; selectedBadge = null;
                } else {
                    if (selectedBadge) selectedBadge.classList.remove('seq-selected');
                    selectedEl.innerHTML = '';
                    selectedEl.appendChild(colEl);
                    badge.classList.add('seq-selected'); selectedBadge = badge;
                    requestAnimationFrame(() => selectedEl.scrollIntoView({ block: 'nearest' }));
                }
            });
        }

        const handle = {
            markCompact() { badge.classList.add('seq-compact'); },
            setModel(name) {
                if (!name) return;
                if (_triedModels[_triedModels.length - 1] !== name) _triedModels.push(name);
                _renderModelEls();
            },
            setTokens(inp, out) {
                const parts = [];
                if (inp != null) parts.push(`↑${inp}`);
                if (out != null) parts.push(`↓${out}`);
                if (parts.length) tokenEl.textContent = ' ' + parts.join(' ');
            },
            setPrompt(text) {
                colTabs.pres.Prompt.textContent = text;
                // Auto-open the Prompt tab in the live column so the step graph
                // shows content immediately (before Output/Thinking tokens arrive).
                colTabs.openTab('Prompt');
                _ensureAggEntry(); aggTabs.pres.Prompt.textContent = text;
                scrollBottom(msgs);
            },
            setRequest(text) {
                colTabs.pres.Request.textContent = text;
                _ensureAggEntry(); aggTabs.pres.Request.textContent = text;
            },
            append(text, type) {
                if (text && _ghostCol && _ghostCol !== colEl) { _ghostColClose?.(); _ghostColClose = null; _ghostCol.remove(); _ghostCol = null; }
                if (text) hasOutput = true;
                if (type === 'thinking') {
                    colTabs.openTab('Thinking');
                    if (latestThink) {
                        // Append a new text node instead of textContent += to avoid O(n²)
                        // string reallocation on every token during long thinking phases.
                        latestThink.appendChild(document.createTextNode(text));
                    } else {
                        const span = document.createElement('span');
                        span.className = 'seq-stream-latest'; span.textContent = text;
                        colTabs.pres.Thinking.appendChild(span);
                        latestThink = span;
                    }
                    // RAF-throttle the scroll — reading scrollHeight forces a synchronous
                    // layout reflow; doing it on every token freezes mobile browsers.
                    if (!_innerScrollRafPending) {
                        _innerScrollRafPending = true;
                        requestAnimationFrame(() => {
                            _innerScrollRafPending = false;
                            colTabs.pres.Thinking.scrollTop = colTabs.pres.Thinking.scrollHeight;
                        });
                    }
                    _ensureAggEntry();
                    aggTabs.openTab('Thinking');
                    // Always append a new text node — avoids O(n²) textContent += on the agg panel too.
                    aggTabs.pres.Thinking.appendChild(document.createTextNode(text));
                } else {
                    const isError = type === 'error';
                    colTabs.openTab('Output');
                    if (latestOut && !isError && !latestOut.classList.contains('step-err')) {
                        latestOut.appendChild(document.createTextNode(text));
                    } else {
                        if (latestOut) latestOut.classList.remove('seq-stream-latest');
                        const span = document.createElement('span');
                        span.className = 'seq-stream-latest' + (isError ? ' step-err' : ''); span.textContent = text;
                        colTabs.pres.Output.appendChild(span);
                        latestOut = span;
                    }
                    if (!_innerScrollRafPending) {
                        _innerScrollRafPending = true;
                        requestAnimationFrame(() => {
                            _innerScrollRafPending = false;
                            colTabs.pres.Output.scrollTop = colTabs.pres.Output.scrollHeight;
                        });
                    }
                    _ensureAggEntry();
                    aggTabs.openTab('Output');
                    if (isError) {
                        const es = document.createElement('span'); es.className = 'step-err'; es.textContent = text;
                        aggTabs.pres.Output.appendChild(es);
                        // Auto-expand the event log so errors are immediately visible.
                        // Enforce mutual exclusion — close Step Graph and set preference to Event Log.
                        if (aggDetail.style.display === 'none') {
                            aggDetail.style.display = '';
                            aggToggle.textContent = '▼';
                            _userPreferEventLog = true;
                            if (graphDetailEl.style.display !== 'none') {
                                graphDetailEl.style.display = 'none';
                                graphToggle.textContent = '▶';
                            }
                        }
                        aggRowEl.style.display = '';
                    } else {
                        aggTabs.pres.Output.appendChild(document.createTextNode(text));
                    }
                }
                // Update streaming markdown preview — only for the main thinking step.
                // Worker handles must not contribute here; their tokens go to step columns.
                if (type === 'output' && text && handle === _mainThinkHandle) {
                    _previewText += text;
                    if (_previewTimer) clearTimeout(_previewTimer);
                    _previewTimer = setTimeout(_refreshStreamPreview, 150);
                }
                if (!_scrollRafPending) {
                    _scrollRafPending = true;
                    requestAnimationFrame(() => { _scrollRafPending = false; scrollBottom(msgs); });
                }
            },
            setOutput(text) {
                if (text && _ghostCol && _ghostCol !== colEl) { _ghostColClose?.(); _ghostColClose = null; _ghostCol.remove(); _ghostCol = null; }
                if (text) hasOutput = true;
                latestOut = null;
                colTabs.openTab('Output');
                _renderOutputText(colTabs.pres.Output, text);
                if (text) {
                    _ensureAggEntry();
                    aggTabs.openTab('Output');
                    if (!aggTabs.pres.Output.hasChildNodes()) {
                        // Lead with \n so consecutive step-output boxes in the aggregate
                        // panel are visually separated rather than running together.
                        aggTabs.pres.Output.appendChild(document.createTextNode('\n' + text));
                    }
                }
                scrollBottom(msgs);
            },
            complete() {
                if (done) return; done = true;
                _liveHandles.delete(handle);
                commit(latestOut,   v => latestOut  = v);
                commit(latestThink, v => latestThink = v);
                if (entryTimeEl) entryTimeEl.textContent += ` – ${_fmtTime()}`;
                _removeStepTimer(_timerEntry); timers.delete(_timerEntry);
                timerEl.textContent = ` ${((Date.now()-start)/1000).toFixed(1)}s`;
                badge.classList.remove('seq-running'); badge.classList.add('seq-done');
                if (aggTabs) aggTabs.close();
                if (hasOutput) {
                    // Keep column visible as ghost; defer colTabs.close() until ghost is replaced.
                    if (_ghostCol && _ghostCol !== colEl) { _ghostColClose?.(); _ghostColClose = null; _ghostCol.remove(); }
                    _ghostCol = colEl;
                    _ghostColClose = () => colTabs.close();
                } else {
                    colTabs.close();
                    colEl.remove();
                }
                _attachClickInspect();
            },
            abort() {
                if (done) return; done = true;
                _liveHandles.delete(handle);
                commit(latestOut,   v => latestOut  = v);
                commit(latestThink, v => latestThink = v);
                if (entryTimeEl) entryTimeEl.textContent += ` – ${_fmtTime()}`;
                _removeStepTimer(_timerEntry); timers.delete(_timerEntry);
                badge.classList.remove('seq-running'); badge.classList.add('seq-stopped');
                if (aggTabs) aggTabs.close();
                if (hasOutput) {
                    if (_ghostCol && _ghostCol !== colEl) { _ghostColClose?.(); _ghostColClose = null; _ghostCol.remove(); }
                    _ghostCol = colEl;
                    _ghostColClose = () => colTabs.close();
                } else {
                    colEl.remove();
                }
                _attachClickInspect();
            },
            markTruncated(reason) {
                done = true;
                _liveHandles.delete(handle);
                // Same finalisation as abort() so the box is inspectable afterwards —
                // committing the streamed spans and closing the tab groups is what
                // makes the click-inspect column render its content.
                commit(latestOut,   v => latestOut  = v);
                commit(latestThink, v => latestThink = v);
                if (entryTimeEl) entryTimeEl.textContent += ` – ${_fmtTime()}`;
                _removeStepTimer(_timerEntry); timers.delete(_timerEntry);
                colTabs.close();
                if (aggTabs) aggTabs.close();
                badge.classList.remove('seq-running', 'seq-done', 'seq-stopped');
                badge.classList.add('seq-stopped');
                if (!badge.querySelector('.seq-task-truncated-note')) {
                    const note = document.createElement('span');
                    note.className = 'seq-task-truncated-note';
                    note.textContent = reason || 'truncated — retrying';
                    badge.appendChild(note);
                }
                if (!_clickInspectedBadges.has(badge)) {
                    _clickInspectedBadges.add(badge);
                    _attachClickInspect();
                }
            }
        };
        _liveHandles.add(handle);
        return handle;
    }

    let lastStepEl: Element | null = null;

    const _noopTaskHandle = { setModel: ()=>{}, setPrompt: ()=>{}, setRequest: ()=>{},
                               setOutput: ()=>{}, setTokens: ()=>{}, append: ()=>{},
                               complete: ()=>{}, abort: ()=>{}, markCompact: ()=>{}, markTruncated: ()=>{} };

    function addStep(labels) {
        if (_finalized) return labels.map(() => _noopTaskHandle);
        if (graphRowEl.style.display === 'none') {
            graphRowEl.style.display = '';
            // Auto-open Step Graph on first step, but only if the user hasn't switched to Event Log.
            if (!_userPreferEventLog) {
                graphDetailEl.style.display = '';
                graphToggle.textContent = '▼';
                // Enforce mutual exclusion — close Event Log if it was open.
                if (aggDetail.style.display !== 'none') { aggDetail.style.display = 'none'; aggToggle.textContent = '▶'; }
            }
        }
        if (stepCount > 0) {
            const arrow = document.createElement('div');
            arrow.className = 'seq-arrow'; arrow.textContent = '→';
            graphEl.appendChild(arrow);
        }
        stepCount++;
        const stepEl = document.createElement('div'); stepEl.className = 'seq-step';
        graphEl.appendChild(stepEl);
        lastStepEl = stepEl;
        scrollBottom(msgs);
        return labels.map(l => createTask(stepEl, l));
    }

    function stopAll() {
        _finalized = true;
        // Abort all handles that haven't finished — sets done=true so later complete() is a no-op.
        for (const h of [..._liveHandles]) h.abort();
        _liveHandles.clear();
        // Belt-and-suspenders: clear any timers not already cleaned up by abort()
        timers.forEach(e => _removeStepTimer(e)); timers.clear();
        while (liveEl.firstChild) liveEl.removeChild(liveEl.firstChild);
    }

    function finalize(text) {
        // Discard streaming preview — the authoritative render below replaces it.
        if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = null; }
        if (_previewEl) { _previewEl.remove(); _previewEl = null; }
        // Save before clearing — used as fallback for stop/break markers (see below).
        // After the _mainThinkHandle gate fix, _previewText contains only the main
        // agent's streamed output, not worker tokens.
        const _savedPreviewText = _previewText.trim();
        _previewText = '';

        // liveContent: fallback text for when the final response is empty or a stop marker.
        // Use the saved streaming preview (main agent only) rather than the DOM query that
        // previously captured ALL worker Output tabs.
        // Strip protocol markers (_stripTerminal) before display — on the stop/break path the
        // return value is '*(stopped)*'/'*(break)*' so runTurn's own stripping is bypassed;
        // the model may have streamed STATUS:/BLOCKED:/COMPLETED just before the abort.
        const liveContent = _stripTerminal(_savedPreviewText).trim();
        stopAll();
        // Collapse the event log once the response is complete
        aggDetail.style.display = 'none';
        aggToggle.textContent = '▶';
        // Strip terminal markers as a safety net — callers (native harness, Pi harness,
        // error paths) should strip before calling finalize(), but an unstripped "COMPLETED"
        // leaking here would render visibly.  cleanResponse() only strips think-tags, so
        // _stripTerminal() must also run here to prevent the leak.
        const cleaned = _stripTerminal(cleanResponse(typeof text === 'string' ? text : String(text ?? '')));
        // For stop/break markers, prefer whatever was already streamed so content isn't lost.
        const isStopMarker = /^\*\(stopped\)\*$|^\*\(break\)\*$/.test(cleaned);
        // For tool-only turns (no text) the Pi harness calls finalize('') — show nothing rather
        // than a confusing "(no text response)" marker; the step graph already shows the tools.
        const toShow = (!cleaned || isStopMarker) ? (liveContent || cleaned || '') : cleaned;
        const responseEl = document.createElement('div');
        responseEl.className = 'agent-response-text';
        // Guard: renderMarkdown / processImgSlots / processFileLinks / _addCodeBlockButtons
        // can throw (e.g. malformed HTML, null DOM refs).  Catch here so the copy button
        // is always appended — a missing copy button is harder to debug than a render glitch.
        try {
            responseEl.innerHTML = renderMarkdown(toShow);
            processImgSlots(responseEl);
            processFileLinks(responseEl);
            // Add ⎘ Copy / ▶ Run buttons to every code block
            _addCodeBlockButtons(responseEl);
        } catch (e) {
            console.warn('[finalize] render error:', e);
            if (!responseEl.innerHTML) responseEl.textContent = toShow; // fallback: plain text
        }
        bubble.appendChild(responseEl);

        // Action row — always present below the response text.
        // Starts with a "Copy response" button; _appendDiffButton() may later
        // append a "⊟ Diff" button to the same row after it saves the snapshot.
        // data-action persists in saved HTML so delegation in init.ts can re-bind
        // the onclick after page reload (JS properties don't survive serialization).
        const actionRow = document.createElement('div');
        actionRow.className = 'agent-turn-diff-row';
        const copyResponseBtn = document.createElement('button');
        copyResponseBtn.className = 'agent-ckpt-btn';
        copyResponseBtn.dataset.action = 'copy-response';
        copyResponseBtn.textContent = '⎘';
        copyResponseBtn.title = 'Copy this response to clipboard';
        copyResponseBtn.onclick = () => {
            navigator.clipboard.writeText(responseEl.innerText ?? '').then(() => {
                copyResponseBtn.textContent = '✓';
                setTimeout(() => { copyResponseBtn.textContent = '⎘'; }, 1500);
            }).catch(() => {
                copyResponseBtn.textContent = '✗';
                setTimeout(() => { copyResponseBtn.textContent = '⎘'; }, 1500);
            });
        };
        actionRow.appendChild(copyResponseBtn);
        bubble.appendChild(actionRow);

        scrollBottom(msgs);
    }

    return {
        div,
        addThinkingTask: () => {
            const roleName = mainAgentRole?.name ?? null;
            const label = roleName ? `Thinking:${roleName}` : 'Thinking…';
            const handle = addStep([label])[0];
            // If a previous step already wrote preview text, separate with a blank line so
            // consecutive step outputs ("Sentence one.Sentence two.") don't run together.
            if (_previewText && !_previewText.endsWith('\n\n')) _previewText += '\n\n';
            _mainThinkHandle = handle; // only this handle's output tokens feed _previewText
            return handle;
        },
        addToolStep:     labels => addStep(labels),
        addCompactStep:  () => { const t = addStep(['compacting…'])[0]; t.markCompact(); return t; },
        addSystemStep: label => {
            if (_finalized) return;
            if (graphRowEl.style.display === 'none') {
                graphRowEl.style.display = '';
                if (!_userPreferEventLog) {
                    graphDetailEl.style.display = '';
                    graphToggle.textContent = '▼';
                    if (aggDetail.style.display !== 'none') { aggDetail.style.display = 'none'; aggToggle.textContent = '▶'; }
                }
            }
            if (stepCount > 0) {
                const arrow = document.createElement('div');
                arrow.className = 'seq-arrow'; arrow.textContent = '→';
                graphEl.appendChild(arrow);
            }
            stepCount++;
            const el = document.createElement('div');
            el.className = 'seq-step-system';
            el.textContent = label;
            el.title = label;
            graphEl.appendChild(el);
            lastStepEl = el;
            scrollBottom(msgs);
        },
        finalize,
    };
}

// ── Chat empty / welcome state ─────────────────────────────────────────────
export function _updateChatEmpty(): void {
    const msgs  = getMessagesEl();
    const panel = msgs?.closest('.tab-panel[data-panel="chat"]') as HTMLElement | null;
    if (!panel) return;
    panel.classList.toggle('chat-empty', !msgs || msgs.children.length === 0);
    if (typeof updateInputModelBtn === 'function') updateInputModelBtn();
}

export function initChatEmpty(): void {
    _updateChatEmpty();
    const msgs = getMessagesEl();
    if (!msgs) return;
    new MutationObserver(() => _updateChatEmpty()).observe(msgs, { childList: true });
}

// Window bridge for classic scripts.
Object.assign(window, { processImgSlots, processFileLinks, renderMarkdown, cleanResponse,
    getMessagesEl, scrollBottom, appendMessage, createResponsePlaceholder,
    _updateChatEmpty, initChatEmpty });
