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
