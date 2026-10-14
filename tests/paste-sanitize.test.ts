import { describe, it, expect } from 'vitest';
import { sanitizePastedHtml } from '../paste-sanitize.js';

describe('sanitizePastedHtml', () => {
    it('removes unquoted handlers and active tags', () => {
        const out = sanitizePastedHtml('<p>a</p><img src=x onerror=alert(1)><script>alert(2)</script><iframe src="//e"></iframe>');
        expect(out).toBe('<p>a</p>');
    });
    it('unwraps unknown tags, keeps their text, drops every attribute', () => {
        const out = sanitizePastedHtml('<span style="color:red" class="x" onclick=y()>hello <b id=1>world</b></span>');
        expect(out).toBe('hello <b>world</b>');
    });
    it('keeps only http(s) link targets', () => {
        expect(sanitizePastedHtml('<a href="https://x.example/p?q=1" onclick=z()>x</a>'))
            .toBe('<a href="https://x.example/p?q=1" rel="noopener noreferrer">x</a>');
        expect(sanitizePastedHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    });
    it('does not execute or keep SVG/MathML payloads', () => {
        expect(sanitizePastedHtml('<svg><script>1</script><a xlink:href="javascript:1">t</a></svg>ok')).toBe('ok');
    });
});

import { plainHttpAllowed } from '../mcp.js';
describe('plainHttpAllowed', () => {
    it('allows loopback and private networks only', () => {
        for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '[::1]', 'mcpbox', 'nas.local'])
            expect(plainHttpAllowed(h), h).toBe(true);
        for (const h of ['example.com', '8.8.8.8', '172.32.0.1', 'api.mcp.dev', ''])
            expect(plainHttpAllowed(h), h).toBe(false);
    });
});
