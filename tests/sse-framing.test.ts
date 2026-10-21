// codex report 8, cases 400, 402, 415: SSE framing and Content-Type handling.
import { describe, it, expect } from 'vitest';
import { readSSE, SSEPayloads, decodeOAIResponse } from '../stream-decode.ts';

const resp = (chunks: string[], contentType = 'text/event-stream') => {
    const enc = new TextEncoder(); let i = 0;
    return { headers: { get: () => contentType }, body: { getReader: () => ({
        read: async () => i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { value: undefined, done: true },
        cancel: async () => {}, releaseLock: () => {} }) } };
};
const collect = async (chunks: string[]) => { const out: any[] = []; for await (const v of readSSE(resp(chunks))) out.push(v); return out; };
const ev = (o: any) => JSON.stringify(o);

describe('readSSE framing', () => {
    it('LF, CRLF and CR-only streams give the same events (415)', async () => {
        const body = (nl: string) => `data: ${ev({ a: 1 })}${nl}${nl}data: ${ev({ a: 2 })}${nl}${nl}data: [DONE]${nl}${nl}`;
        for (const nl of ['\n', '\r\n', '\r']) expect(await collect([body(nl)]), JSON.stringify(nl)).toEqual([{ a: 1 }, { a: 2 }]);
    });
    it('a CRLF split between two chunks is one break, not a break and an empty line', async () => {
        const out = await collect([`data: ${ev({ a: 1 })}\r`, `\n\r`, `\ndata: ${ev({ a: 2 })}\r\n\r\n`]);
        expect(out).toEqual([{ a: 1 }, { a: 2 }]);
    });
    it('several data lines of one event are joined (402)', async () => {
        const pretty = JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }, null, 1).split('\n');
        const out = await collect([pretty.map(l => `data: ${l}`).join('\n') + '\n\n', 'data: [DONE]\n\n']);
        expect(out).toEqual([{ choices: [{ delta: { content: 'hi' } }] }]);
    });
    it('events without blank lines between them still stream, and comments and other fields are ignored', async () => {
        const out = await collect([`: keep-alive\nevent: message\nid: 7\ndata: ${ev({ a: 1 })}\ndata: ${ev({ a: 2 })}\n`, 'data: [DONE]\n']);
        expect(out).toEqual([{ a: 1 }, { a: 2 }]);
    });
    it('a last event without its break is delivered', async () => {
        expect(await collect([`data: ${ev({ a: 1 })}`])).toEqual([{ a: 1 }]);
    });
    it('the keep-alive data line and garbage do not stop the stream', async () => {
        expect(await collect([`data:\n\ndata: not json\n\ndata: ${ev({ a: 1 })}\n\n`])).toEqual([{ a: 1 }]);
    });
});

describe('SSEPayloads', () => {
    it('is usable line by line', () => {
        const p = new SSEPayloads();
        expect(p.line('data: {"a":')).toEqual([]);
        expect(p.line('data: 1}')).toEqual([{ a: 1 }]);
        expect(p.line('')).toEqual([]);
    });
});

describe('Content-Type', () => {
    it('is matched case-insensitively (400)', async () => {
        const r: any = resp([`data: ${ev({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`], 'Text/Event-Stream; charset=utf-8');
        const msg = await decodeOAIResponse(r, () => {});
        expect(msg.content).toBe('ok');
    });
});
