import { describe, it, expect } from 'vitest';
import { redactText, secretForms, REDACTED } from '../secrets.js';
import { redactSecrets } from '../convo-log.js';

const W: any = globalThis;
// Built from parts so the file holds no secret-shaped literal (deploy.sh scans for those).
const p = (...a: string[]) => a.join('');
const SHAPES: Record<string, string> = {
    openai:     p('sk', '-', 'proj-', 'abcdefghijklmnopqrstuvwx'),
    anthropic:  p('sk', '-', 'ant-api03-', 'abcdefghijklmnopqrstuvwx'),
    openrouter: p('sk', '-or-v1-', 'abcdef0123456789abcd'),
    groq:       p('gsk', '_', 'abcdefghijklmnopqrstuvwx'),
    nvidia:     p('nvapi', '-', 'abcdefghijklmnopqrstuvwx'),
    hf:         p('hf', '_', 'abcdefghijklmnopqrstuvwx'),
    tavily:     p('tvly', '-', 'abcdefghijklmnopqrstuvwx'),
    cloudflare: p('cfut', '_', 'abcdefghijklmnopqrstuvwx'),
    google:     p('AI', 'zaSyA1234567890123456789012345678901'),
    github:     p('gh', 'p_', 'a'.repeat(36)),
    githubPat:  p('github', '_pat_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'),
    slack:      p('xox', 'b-', '1234567890-abcdefghij'),
    aws:        p('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
    brave:      p('BS', 'A', 'abcdefghijklmnopqrstuvwxyz'),
    jwt:        p('ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0.', 'abcdefghijklmnopqrstu'),
};

describe('redactText: credential shapes', () => {
    for (const [name, v] of Object.entries(SHAPES)) {
        it(`redacts a ${name} key`, () => {
            const out = redactText(`before ${v} after`);
            expect(out).toBe(`before ${REDACTED} after`);
        });
    }
    it('keeps the Bearer word and redacts its token', () => {
        expect(redactText('Authorization: Bearer abcdefghijklmnop12345')).toBe(`Authorization: Bearer ${REDACTED}`);
    });
    it('leaves ordinary text alone', () => {
        const t = 'Use the sk prefix, a short-token, and https://example.com/path?x=1';
        expect(redactText(t)).toBe(t);
    });
});

describe('redactText: known values', () => {
    it('redacts raw, bare-bearer and URL-encoded forms, longest first, skipping short values', () => {
        const vals = ['Bearer tok_123456789', 'AIza+key/value=', 'abc'];
        expect(redactText('auth=Bearer tok_123456789 raw=tok_123456789', vals)).toBe('auth=[redacted] raw=[redacted]');
        expect(redactText('url?key=AIza%2Bkey%2Fvalue%3D and AIza+key/value=', vals)).toBe('url?key=[redacted] and [redacted]');
        expect(redactText('abc stays', vals)).toBe('abc stays');
        expect(secretForms('abc')).toEqual([]);
    });
    it('catches a pasted key the known values do not cover', () => {
        const out = redactText(`mine-secret-value and ${SHAPES.openai}`, ['mine-secret-value']);
        expect(out).toBe(`${REDACTED} and ${REDACTED}`);
    });
});

describe('channel wrappers share the core (gap matrix)', () => {
    const header = { Authorization: 'Bearer mcp_secret_token_value' };
    it('redactSecrets (log upload) now also catches MCP-shaped and header values it is given', () => {
        expect(redactSecrets(`x ${SHAPES.anthropic} y ${SHAPES.jwt}`)).toBe(`x ${REDACTED} y ${REDACTED}`);
        expect(redactSecrets('tok mcp_secret_token_value', Object.values(header))).toBe(`tok ${REDACTED}`);
    });
    it('redactMcpSecrets (MCP results) also catches credential shapes that are not header values', () => {
        expect(W.redactMcpSecrets(`echo ${SHAPES.openai} and mcp_secret_token_value`, header)).toBe(`echo ${REDACTED} and ${REDACTED}`);
        expect(W.redactMcpSecrets(`echo ${SHAPES.groq}`)).toBe(`echo ${REDACTED}`);
    });
    it('never redacts less than before: every previously covered form is still covered', () => {
        const old = [p('sk', '-or-v1-', 'abcdef0123456789abcd'), p('AI', 'zaSyA1234567890123456789012345678901'), p('gh', 'p_', 'b'.repeat(36))];
        for (const v of old) expect(redactText(v)).toBe(REDACTED);
    });
});
