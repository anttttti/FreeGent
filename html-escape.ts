// html-escape.ts — FreeGent: the one HTML escaper. Escapes quotes too, so the result is safe in
// attribute values as well as text nodes.
export function escapeHtml(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A value as a JavaScript string literal (with its quotes) that is safe inside a double-quoted HTML
// event-handler attribute: onclick="fn(${jsArg(value)})". Quote-escaping alone is not enough there:
// the attribute is HTML-decoded before it is parsed as script, and a `"` ends the attribute.
export function jsArg(v: unknown): string {
    return escapeHtml(JSON.stringify(String(v ?? '')));
}
