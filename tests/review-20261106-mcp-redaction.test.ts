import { describe, it, expect } from 'vitest';

const W = globalThis as any;

describe('review: callMCPTool credential redaction', () => {
    it('redacts auth headers and stored credentials from callMCPTool results and errors', async () => {
        const secretKey = 'secret-review-mcp-token-12345';
        const url = 'https://mcp.test.example/mcp';

        // Mock fetch to simulate an MCP server echoing the token in its response text
        const originalFetch = globalThis.fetch;
        try {
            globalThis.fetch = async (reqUrl: any, init: any) => {
                const body = JSON.parse(init?.body || '{}');
                if (body.method === 'initialize') {
                    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } }), {
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                if (body.method === 'tools/call') {
                    // Server echoes the secret in the result text
                    return new Response(JSON.stringify({
                        jsonrpc: '2.0',
                        id: body.id,
                        result: { content: [{ type: 'text', text: `Echoed secret: ${secretKey}` }] },
                    }), { headers: { 'Content-Type': 'application/json' } });
                }
                return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
            };

            const text = await W.callMCPTool(url, 'test-tool', {}, { Authorization: `Bearer ${secretKey}` });
            expect(text).not.toContain(secretKey);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('redacts auth headers and stored credentials from callMCPTool error responses', async () => {
        const secretKey = 'secret-review-mcp-token-error-67890';
        const url = 'https://mcp.test.example/mcp-err';

        const originalFetch = globalThis.fetch;
        try {
            globalThis.fetch = async (reqUrl: any, init: any) => {
                const body = JSON.parse(init?.body || '{}');
                if (body.method === 'initialize') {
                    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } }), {
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                if (body.method === 'tools/call') {
                    return new Response(JSON.stringify({
                        jsonrpc: '2.0',
                        id: body.id,
                        result: { isError: true, content: [{ type: 'text', text: `Authentication failed for token ${secretKey}` }] },
                    }), { headers: { 'Content-Type': 'application/json' } });
                }
                return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
            };

            await expect(W.callMCPTool(url, 'test-tool', {}, { Authorization: `Bearer ${secretKey}` }))
                .rejects.toThrow();

            try {
                await W.callMCPTool(url, 'test-tool', {}, { Authorization: `Bearer ${secretKey}` });
            } catch (err: any) {
                expect(err.message).not.toContain(secretKey);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
