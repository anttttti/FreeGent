// html-escape.ts — FreeGent: the one HTML escaper. Escapes quotes too, so the result is safe in
// attribute values as well as text nodes.
export function escapeHtml(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
