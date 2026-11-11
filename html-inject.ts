// html-inject.ts — put markup at the start of a page's <head>, for the preview, check_page and the dev server's page script.
//
// Each caller had `/<head[^>]*>/` and otherwise prepended. That regex also matches <header>, which put the script into the page's body,
// and prepending to a page that starts with a doctype but has no <head> moved the doctype behind the script: the browser then parsed the
// page in quirks mode (codex R240). The doctype, comments before it and an <html> tag stay first.
const _HEAD = /<head(?:\s[^>]*)?>/i;
const _PRELUDE = /^(?:﻿)?(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?(?:\s|<!--[\s\S]*?-->)*(?:<html(?:\s[^>]*)?>)?/i;
export function injectIntoHead(html: string, markup: string): string {
    // A `<head>` inside a comment is text: the policy went into the comment and the page ran without it (exploration O019). Search a copy with the comments blanked.
    const head = _HEAD.exec(html.replace(/<!--[\s\S]*?-->/g, c => ' '.repeat(c.length)));
    if (head) return html.slice(0, head.index + head[0].length) + markup + html.slice(head.index + head[0].length);
    const prelude = html.match(_PRELUDE)?.[0] ?? '';
    return prelude + markup + html.slice(prelude.length);
}
