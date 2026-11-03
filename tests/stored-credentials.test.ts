// stored-credentials.ts: the one list of saved credential values, and the provider/MCP error paths that
// redact with it (a provider that echoes the request's key must not put it on screen or in a log).
import { describe, it, expect, beforeEach } from 'vitest';
import { storedCredentialValues } from '../stored-credentials.ts';
import { _httpErrorFromResponse } from '../retry.ts';
import { streamOAICompat, nonStreamOAICompat } from '../stream-decode.ts';

const GROQ = 'gsk_' + 'A'.repeat(40);
const ODD = 'opaque-moonmath-value-123';   // no well-known shape: only the known-value list redacts it

beforeEach(() => localStorage.clear());

describe('credential list', () => {
    it('includes credential-named entries, MCP headers, custom-model keys and a proxy password; not a token budget', () => {
        localStorage.setItem('fg_moonmath_key', ODD);
        localStorage.setItem('fg_github_token', 'opaque-github-credential');
        localStorage.setItem('fg_mcp_servers', JSON.stringify([{ id: 'a', headers: { 'X-Api-Key': 'opaque-mcp-credential' } }]));
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'custom', model: 'm', key: 'opaque-custom-credential' }]));
        localStorage.setItem('fg_search_proxy', 'https://user:opaque-proxy-pass@proxy.example/');
        localStorage.setItem('fg_agent_compact_tokens', '10000000');
        localStorage.setItem('fg_groq_model', 'llama-3.3-70b-versatile');
        const vals = storedCredentialValues();
        for (const v of [ODD, 'opaque-github-credential', 'opaque-mcp-credential', 'opaque-custom-credential', 'opaque-proxy-pass']) expect(vals).toContain(v);
        expect(vals).not.toContain('10000000');
        expect(vals).not.toContain('llama-3.3-70b-versatile');
    });
});

describe('provider error text', () => {
    const echo = `Invalid API key: ${ODD} (also ${GROQ})`;
    beforeEach(() => localStorage.setItem('fg_moonmath_key', ODD));

    it('an HTTP error that echoes the key is redacted before it reaches the chat', async () => {
        const body = JSON.stringify({ error: { message: echo } });
        const e: any = await _httpErrorFromResponse(new Response(body, { status: 401 }), '[moonmath|m]');
        expect(e.message).toContain('Invalid API key');
        expect(e.message).not.toContain(ODD);
        expect(e.message).not.toContain(GROQ);
        expect(e.status).toBe(401);
    });

    it('a 200 JSON error envelope is redacted', async () => {
        const resp = { json: async () => ({ error: { message: echo } }) };
        const e: any = await nonStreamOAICompat(resp, () => {}).catch(x => x);
        expect(e.message).toContain('Invalid API key');
        expect(e.message).not.toContain(ODD);
    });

    it('an error event in a 200 stream is redacted', async () => {
        const enc = new TextEncoder();
        const lines = [`data: ${JSON.stringify({ error: { message: echo } })}\n`, 'data: [DONE]\n'];
        let i = 0;
        const resp = { body: { getReader: () => ({
            read: async () => i < lines.length ? { value: enc.encode(lines[i++]), done: false } : { value: undefined, done: true },
            cancel: async () => {}, releaseLock: () => {},
        }) } };
        const e: any = await streamOAICompat(resp, () => {}).catch(x => x);
        expect(e.message).toContain('Invalid API key');
        expect(e.message).not.toContain(ODD);
        expect(e.message).not.toContain(GROQ);
    });
});
