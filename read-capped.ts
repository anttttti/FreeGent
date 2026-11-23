// read-capped.ts — read a fetch Response's body as text, but no more than `max` bytes.
//
// resp.text() reads whatever the server sends before anything can cap it: an MCP reply or a browser-bridge observation of any size
// was held, decoded and parsed in full (codex R205, R210). Past the limit the read is cancelled and `tooLarge()` is thrown.
export async function readTextCapped(resp: Response, max: number, tooLarge: () => Error): Promise<string> {
    if (Number(resp.headers.get('content-length')) > max) { resp.body?.cancel().catch(() => {}); throw tooLarge(); }
    if (typeof resp.body?.getReader !== 'function') { const t = await resp.text(); if (t.length > max) throw tooLarge(); return t; }
    const reader = resp.body.getReader(), decoder = new TextDecoder();
    let text = '', size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (value) { size += value.byteLength; if (size > max) throw tooLarge(); text += decoder.decode(value, { stream: true }); }
            if (done) return text + decoder.decode();
        }
    } finally { reader.cancel().catch(() => {}); }
}

/** The body as bytes, no more than `max`: the read is cancelled past it and `tooLarge()` is thrown. Content-Length is only a hint (it can be missing or wrong), so the bytes
 *  that arrive are counted. */
export async function readBytesCapped(resp: Response, max: number, tooLarge: () => Error): Promise<Uint8Array> {
    if (Number(resp.headers.get('content-length')) > max) { resp.body?.cancel().catch(() => {}); throw tooLarge(); }
    if (typeof resp.body?.getReader !== 'function') { const b = new Uint8Array(await resp.arrayBuffer()); if (b.byteLength > max) throw tooLarge(); return b; }
    const reader = resp.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (value) { size += value.byteLength; if (size > max) throw tooLarge(); chunks.push(value); }
            if (done) break;
        }
    } finally { reader.cancel().catch(() => {}); }
    const out = new Uint8Array(size);
    let at = 0; for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
}
