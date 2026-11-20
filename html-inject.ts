// html-inject.ts — put markup at the start of a page's <head>, for the preview, check_page and the dev server's page script.
//
// Each caller had `/<head[^>]*>/` and otherwise prepended. That regex also matches <header>, which put the script into the page's body,
// and prepending to a page that starts with a doctype but has no <head> moved the doctype behind the script: the browser then parsed the
// page in quirks mode (codex R240). The doctype, comments before it and an <html> tag stay first.
// What the HTML parser would see as a tag: a comment, a raw-text or template element (its content is not markup: a `<head>` there is text or inert),
// or a tag whose quoted attribute values may hold `>` and `<head>`. The first real <head> open tag is the insertion point (explorations O019, X008).
const _ATTRS = `(?:"[^"]*"|'[^']*'|[^>"'])*`;
const _TOKEN = new RegExp(`<!--[\\s\\S]*?-->|<(script|style|textarea|title|template|xmp|noembed|noframes|iframe)(?=[\\s/>])${_ATTRS}>[\\s\\S]*?(?:<\\/\\1\\s*>|$)|<(\\/?)([a-zA-Z][^\\s/>]*)${_ATTRS}>`, 'gi');
function headOpenEnd(html: string): number {
    _TOKEN.lastIndex = 0;
    for (let m; (m = _TOKEN.exec(html)); ) {
        const name = m[3]?.toLowerCase();
        if (name === 'head' && !m[2]) return m.index + m[0].length;
        if (name === 'body' && !m[2]) return -1;   // no head before the body: the browser makes one
    }
    return -1;
}
const _PRELUDE = /^(?:﻿)?(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?(?:\s|<!--[\s\S]*?-->)*(?:<html(?:\s[^>]*)?>)?/i;
export function injectIntoHead(html: string, markup: string): string {
    const end = headOpenEnd(html);
    if (end >= 0) return html.slice(0, end) + markup + html.slice(end);
    const prelude = html.match(_PRELUDE)?.[0] ?? '';
    return prelude + markup + html.slice(prelude.length);
}
