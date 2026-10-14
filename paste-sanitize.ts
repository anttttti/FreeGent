// paste-sanitize.ts — FreeGent: clipboard HTML reduced to a small set of formatting tags.
//
// The composer used regexes that removed quoted on*="…" attributes and a few tag names; unquoted
// handlers (<img src=x onerror=alert(1)>) and other tags passed straight into the contenteditable.
// Here the HTML is parsed into an inert document and rebuilt from an allowlist: everything not on it
// is unwrapped to its text, and no attribute survives except a safe link target.

const KEEP = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'br', 'p', 'div', 'ul', 'ol', 'li',
    'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'a']);
// Dropped with their content, not unwrapped: the text of these is never what the user copied.
const DROP = new Set(['script', 'style', 'head', 'meta', 'link', 'title', 'template', 'noscript', 'iframe',
    'object', 'embed', 'svg', 'math', 'form', 'textarea', 'select', 'option', 'button', 'input', 'img', 'video', 'audio']);

function _copy(src: Node, into: Node, doc: Document): void {
    for (const n of Array.from(src.childNodes)) {
        if (n.nodeType === 3) { into.appendChild(doc.createTextNode(n.nodeValue ?? '')); continue; }
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        const tag = el.tagName.toLowerCase();
        if (DROP.has(tag)) continue;
        if (!KEEP.has(tag)) { _copy(el, into, doc); continue; }   // unwrap: span, font, label ...
        const out = doc.createElement(tag);
        if (tag === 'a') {
            const href = el.getAttribute('href') ?? '';
            if (/^https?:\/\//i.test(href.trim())) { out.setAttribute('href', href.trim()); out.setAttribute('rel', 'noopener noreferrer'); }
        }
        _copy(el, out, doc);
        into.appendChild(out);
    }
}

/** HTML for execCommand('insertHTML'): allowlisted tags, no attributes except an http(s) link target. */
export function sanitizePastedHtml(html: string): string {
    const parsed = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const holder = parsed.createElement('div');
    _copy(parsed.body, holder, parsed);
    return holder.innerHTML;
}
