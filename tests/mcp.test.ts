// mcp.test.ts — MCP server registry (mcp.ts): discovery, tool naming and schemas, dispatch
// through executeToolAsync, and the Context7 adapter. fetch is a vitest mock (tests/setup.js)
// playing a Streamable HTTP MCP server.

const W: any = globalThis;

type Handler = (msg: any, headers: Record<string, string>) => any;

// Fake MCP server: answers JSON-RPC requests via `handle`, as SSE or JSON, with a session id.
function mockServer(handle: Handler, { sse = true, session = 'sess-1' } = {}) {
    const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
    W.fetch.mockImplementation(async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        const headers = init.headers || {};
        calls.push({ url, body, headers });
        if (body.id === undefined) return new Response(null, { status: 202 });
        const out = handle(body, headers);
        if (out instanceof Response) return out;
        const msg = { jsonrpc: '2.0', id: body.id, ...out };
        const rh: Record<string, string> = { 'Content-Type': sse ? 'text/event-stream' : 'application/json' };
        if (session) rh['Mcp-Session-Id'] = session;
        return new Response(sse ? `event: message\ndata: ${JSON.stringify(msg)}\n\n` : JSON.stringify(msg), { status: 200, headers: rh });
    });
    return calls;
}

const TOOLS = [
    { name: 'search_places', description: 'Find places.', annotations: { readOnlyHint: true },
      inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
                     properties: { query: { type: 'string' }, open: { type: ['boolean', 'null'] } }, required: ['query', 'missing'] } },
    { name: 'delete.everything', description: 'Deletes.', inputSchema: { type: 'object', properties: {} } },
];

function standardHandler(msg: any) {
    if (msg.method === 'initialize') return { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } };
    if (msg.method === 'tools/list') return { result: { tools: TOOLS } };
    if (msg.method === 'tools/call') {
        if (msg.params.name === 'search_places') return { result: { content: [{ type: 'text', text: `found: ${msg.params.arguments.query}` }, { type: 'image', mimeType: 'image/png', data: 'xx' }] } };
        return { result: { isError: true, content: [{ type: 'text', text: 'nope' }] } };
    }
    return { error: { code: -32601, message: 'unknown method' } };
}

beforeEach(() => {
    localStorage.removeItem('fg_mcp_servers');
    W.fetch.mockReset();
    W.mainAgentRole = null;
});

describe('mcpToolName', () => {
    it('namespaces and sanitizes', () => {
        expect(W.mcpToolName('maps', 'search.places')).toBe('mcp__maps__search_places');
    });
    it('clips to 64 chars and keeps clipped names distinct', () => {
        const a = W.mcpToolName('server', 'x'.repeat(80) + 'a');
        const b = W.mcpToolName('server', 'x'.repeat(80) + 'b');
        expect(a.length).toBe(64);
        expect(a).not.toBe(b);
        expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});

describe('sanitizeMcpSchema', () => {
    it('strips unsupported keys, flattens nullable types, drops unknown required', () => {
        const out = W.sanitizeMcpSchema(TOOLS[0].inputSchema);
        expect(out).toEqual({
            type: 'object',
            properties: { query: { type: 'string' }, open: { type: 'boolean', nullable: true } },
            required: ['query'],
        });
    });
    it('takes the first concrete anyOf branch and maps const to enum', () => {
        expect(W.sanitizeMcpSchema({ anyOf: [{ type: 'null' }, { type: 'string', const: 'a' }], description: 'd' }))
            .toEqual({ type: 'string', description: 'd', enum: ['a'] });
    });
});

describe('sanitizeMcpSchema: $ref (R09)', () => {
    it('resolves a referenced object and array instead of turning them into strings', () => {
        const out = W.sanitizeMcpSchema({
            type: 'object',
            properties: { filter: { $ref: '#/$defs/Filter' }, tags: { type: 'array', items: { $ref: '#/$defs/Tag' } } },
            required: ['filter'],
            $defs: {
                Filter: { type: 'object', properties: { field: { type: 'string' }, min: { type: 'integer' } }, required: ['field'] },
                Tag: { type: 'object', properties: { name: { type: 'string' } } },
            },
        });
        expect(out.properties.filter).toEqual({ type: 'object', properties: { field: { type: 'string' }, min: { type: 'integer' } }, required: ['field'] });
        expect(out.properties.tags.items).toEqual({ type: 'object', properties: { name: { type: 'string' } } });
    });
    it('stops on a recursive reference and says an unresolvable one is unresolved', () => {
        const tree = W.sanitizeMcpSchema({ type: 'object', properties: { node: { $ref: '#/$defs/Node' } },
            $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } } });
        expect(tree.properties.node.properties.child.description).toMatch(/recursive/);
        const bad = W.sanitizeMcpSchema({ type: 'object', properties: { x: { $ref: 'https://example.com/s.json' } } });
        expect(bad.properties.x.type).toBe('object');
        expect(bad.properties.x.description).toMatch(/could not be resolved/);
    });
});

describe('window bridge', () => {
    it('exposes saveMcpServers, which the headless runner calls to start a task with no saved servers', () => {
        W.saveMcpServers([{ id: 'x', name: 'x', url: 'https://x.example.com/mcp' }]);
        expect(W.getMcpServers()).toHaveLength(1);
        W.saveMcpServers([]);
        expect(W.getMcpServers()).toEqual([]);
    });
});

describe('server registry', () => {
    it('adds a server after initialize + tools/list; tools start disabled', async () => {
        const calls = mockServer(standardHandler);
        const s = await W.addMcpServer({ name: 'Google Maps', url: 'https://maps.example.com/mcp', headers: { 'X-Key': 'k' } });
        expect(s.id).toBe('google_maps');
        expect(s.tools.map((t: any) => t.name)).toEqual(['search_places', 'delete.everything']);
        expect(W.mcpToolSpecs()).toEqual([]);
        // Handshake order, auth header on every request, session + version after initialize.
        expect(calls.map(c => c.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
        expect(calls.every(c => c.headers['X-Key'] === 'k')).toBe(true);
        expect(calls[2].headers['Mcp-Session-Id']).toBe('sess-1');
        expect(calls[2].headers['MCP-Protocol-Version']).toBe('2025-06-18');
    });

    it('does not save a server whose handshake fails', async () => {
        W.fetch.mockImplementation(async () => new Response('bad key', { status: 401 }));
        await expect(W.addMcpServer({ name: 'x', url: 'https://bad.example.com/mcp' })).rejects.toThrow(/authentication failed/);
        expect(W.getMcpServers()).toEqual([]);
    });

    it('rejects duplicates and non-http URLs', async () => {
        mockServer(standardHandler);
        await W.addMcpServer({ name: 'a', url: 'https://dup.example.com/mcp' });
        await expect(W.addMcpServer({ name: 'b', url: 'https://dup.example.com/mcp' })).rejects.toThrow(/already/);
        await expect(W.addMcpServer({ name: 'c', url: 'file:///etc/passwd' })).rejects.toThrow(/http/);
    });

    it('offers enabled tools as sanitized specs; server switch hides them', async () => {
        mockServer(standardHandler);
        const s = await W.addMcpServer({ name: 'maps', url: 'https://m.example.com/mcp' });
        W.setMcpToolEnabled(s.id, 'search_places', true);
        const specs = W.mcpToolSpecs();
        expect(specs).toHaveLength(1);
        expect(specs[0].name).toBe('mcp__maps__search_places');
        expect(specs[0].description).toBe('maps: Find places.');
        expect(specs[0].parameters.$schema).toBeUndefined();
        expect(W.activeTools(false, null, true).some((t: any) => t.name === 'mcp__maps__search_places')).toBe(true);
        W.setMcpServerEnabled(s.id, false);
        expect(W.mcpToolSpecs()).toEqual([]);
    });

    it('classifies risk from annotations (unannotated = destructive)', async () => {
        mockServer(standardHandler);
        const s = await W.addMcpServer({ name: 'maps', url: 'https://r.example.com/mcp' });
        expect(W.mcpToolRisk(W.mcpToolName(s.id, 'search_places'))).toBe('read');
        expect(W.mcpToolRisk(W.mcpToolName(s.id, 'delete.everything'))).toBe('destructive');
    });

    it('follows tools/list pagination', async () => {
        mockServer(msg => {
            if (msg.method === 'initialize') return { result: { protocolVersion: '2025-06-18' } };
            if (!msg.params?.cursor) return { result: { tools: [{ name: 'a' }], nextCursor: 'p2' } };
            return { result: { tools: [{ name: 'b' }] } };
        }, { sse: false, session: '' });
        const s = await W.addMcpServer({ name: 'p', url: 'https://p.example.com/mcp' });
        expect(s.tools.map((t: any) => t.name)).toEqual(['a', 'b']);
    });
});

describe('dispatch through executeToolAsync', () => {
    it('calls the tool and flattens content; non-text parts are described', async () => {
        const calls = mockServer(standardHandler);
        const s = await W.addMcpServer({ name: 'maps', url: 'https://d.example.com/mcp' });
        W.setMcpToolEnabled(s.id, 'search_places', true);
        const r = await W.executeToolAsync('mcp__maps__search_places', { query: 'coffee' });
        expect(r).toEqual({ content: 'found: coffee\n[image (image/png) omitted]' });
        const call = calls.find(c => c.body.method === 'tools/call')!;
        expect(call.body.params).toEqual({ name: 'search_places', arguments: { query: 'coffee' } });
    });

    it('returns isError results and disabled tools as errors', async () => {
        mockServer(standardHandler);
        const s = await W.addMcpServer({ name: 'maps', url: 'https://e.example.com/mcp' });
        const name = W.mcpToolName(s.id, 'delete.everything');
        expect((await W.executeToolAsync(name, {})).error).toMatch(/disabled/);
        W.setMcpToolEnabled(s.id, 'delete.everything', true);
        expect((await W.executeToolAsync(name, {})).error).toBe('maps/delete.everything: nope');
    });

    it('re-initializes once when the session has expired', async () => {
        let expired = true;
        const calls = mockServer((msg) => {
            if (msg.method === 'tools/call' && expired) { expired = false; return new Response('', { status: 404 }); }
            return standardHandler(msg);
        });
        const s = await W.addMcpServer({ name: 'maps', url: 'https://x.example.com/mcp' });
        W.setMcpToolEnabled(s.id, 'search_places', true);
        const r = await W.executeToolAsync('mcp__maps__search_places', { query: 'q' });
        expect(r.content).toMatch(/found: q/);
        expect(calls.filter(c => c.body.method === 'initialize')).toHaveLength(2);
    });

    it('keeps a separate session per credential at one endpoint (R23)', async () => {
        const sessions: Record<string, string> = { 'Bearer A': 'sess-A', 'Bearer B': 'sess-B' };
        const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
        W.fetch.mockImplementation(async (url: string, init: any) => {
            const body = JSON.parse(init.body); const headers = init.headers || {};
            calls.push({ url, body, headers });
            if (body.id === undefined) return new Response(null, { status: 202 });
            const rh: Record<string, string> = { 'Content-Type': 'application/json' };
            let result: any;
            if (body.method === 'initialize') { rh['Mcp-Session-Id'] = sessions[headers.Authorization]; result = { protocolVersion: '2025-06-18', capabilities: {} }; }
            else result = { content: [{ type: 'text', text: headers['Mcp-Session-Id'] === sessions[headers.Authorization] ? 'ok' : 'session/credential mismatch' }] };
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: rh });
        });
        const url = 'https://shared.example.com/mcp';
        expect(await W.callMCPTool(url, 't', {}, { Authorization: 'Bearer A' })).toBe('ok');
        expect(await W.callMCPTool(url, 't', {}, { Authorization: 'Bearer B' })).toBe('ok');
        expect(await W.callMCPTool(url, 't', {}, { Authorization: 'Bearer A' })).toBe('ok');
        expect(calls.filter(c => c.body.method === 'initialize')).toHaveLength(2);
    });

    it('labels MCP calls by server and tool', () => {
        expect(W.toolLabel('mcp__maps__search_places', {})).toBe('maps:search_places');
    });
});

describe('tool-name repair', () => {
    it('leaves MCP names alone even when they contain a built-in name', () => {
        const calls = [{ name: 'mcp__github__read_file', args: {} }];
        W._repairToolNames(calls);
        expect(calls[0].name).toBe('mcp__github__read_file');
    });
});

describe('context7_docs adapter', () => {
    it('resolves the library, then calls query-docs with the first ID', async () => {
        const calls = mockServer(msg => {
            if (msg.method === 'initialize') return { result: { protocolVersion: '2025-06-18' } };
            if (msg.params.name === 'resolve-library-id')
                return { result: { content: [{ type: 'text', text: 'Available Libraries:\n\n- Title: Next.js\n- Context7-compatible library ID: /vercel/next.js\n----------\n- Context7-compatible library ID: /websites/nextjs' }] } };
            return { result: { content: [{ type: 'text', text: `docs for ${msg.params.arguments.libraryId}: ${msg.params.arguments.query}` }] } };
        }, { session: '' });
        W.enabledTools.add('context7_docs');
        const r = await W.executeToolAsync('context7_docs', { library: 'Next.js', topic: 'middleware' });
        expect(r).toEqual({ content: 'docs for /vercel/next.js: middleware' });
        const resolve = calls.find(c => c.body.params?.name === 'resolve-library-id')!;
        expect(resolve.body.params.arguments).toEqual({ libraryName: 'Next.js', query: 'middleware' });
    });

    it('uses an /org/project ID directly', async () => {
        const calls = mockServer(msg => msg.method === 'initialize'
            ? { result: { protocolVersion: '2025-06-18' } }
            : { result: { content: [{ type: 'text', text: 'ok' }] } }, { session: '' });
        await W.executeToolAsync('context7_docs', { library: '/vercel/next.js' });
        expect(calls.some(c => c.body.params?.name === 'resolve-library-id')).toBe(false);
    });
});

describe('CORS fallbacks', () => {
    it('drops MCP-Protocol-Version when the preflight rejects it, and remembers', async () => {
        const seen: any[] = [];
        W.fetch.mockImplementation(async (_url: string, init: any) => {
            const body = JSON.parse(init.body);
            seen.push({ method: body.method, version: init.headers['MCP-Protocol-Version'] });
            if (init.headers['MCP-Protocol-Version']) throw new TypeError('Failed to fetch');
            if (body.id === undefined) return new Response(null, { status: 202 });
            const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [{ name: 't' }] };
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'Content-Type': 'application/json' } });
        });
        const s = await W.addMcpServer({ name: 'g', url: 'https://cors.example.com/mcp' });
        expect(s.tools.map((t: any) => t.name)).toEqual(['t']);
        // One failed attempt with the header, then never again for this server.
        expect(seen.filter(x => x.version).length).toBe(1);
        expect(seen.at(-1)).toEqual({ method: 'tools/list', version: undefined });
    });
});

describe('standard library', () => {
    // The shipped library may be empty; exercise the mechanism with a test entry.
    const LIB = { id: 'test_lib', name: 'Test Lib', url: 'https://lib.example.com/mcp', description: 'd',
                  auth: { header: 'X-Api-Key', label: 'Test key', keyUrl: 'https://lib.example.com/keys' },
                  defaultTools: ['a', 'b'], toolNote: 'Credit Test Lib as the source.' };
    beforeEach(() => { W.getMcpLibrary().push(LIB); });
    afterEach(() => { const l = W.getMcpLibrary(); l.splice(l.indexOf(LIB), 1); });

    it('requires the key', async () => {
        await expect(W.addMcpLibraryServer('test_lib', '')).rejects.toThrow(/Test key/);
        expect(W.getMcpServers()).toEqual([]);
    });

    it('adds with the key header, enables default tools, and keeps descriptions whole plus the note', async () => {
        const calls = mockServer(msg => {
            if (msg.method === 'initialize') return { result: { protocolVersion: '2025-06-18' } };
            return { result: { tools: ['a', 'b', 'c'].map(name => ({ name, description: 'x'.repeat(3000), annotations: { readOnlyHint: true } })) } };
        }, { sse: false, session: '' });
        const s = await W.addMcpLibraryServer('test_lib', ' KEY ');
        expect(s.id).toBe('test_lib');
        expect(s.libraryId).toBe('test_lib');
        expect(calls.every(c => c.headers['X-Api-Key'] === 'KEY')).toBe(true);
        expect(s.enabledTools).toEqual(['a', 'b']);
        const specs = W.mcpToolSpecs();
        expect(specs.map((x: any) => x.name)).toEqual(['mcp__test_lib__a', 'mcp__test_lib__b']);
        for (const spec of specs) {
            expect(spec.description).toBe(`Test Lib: ${'x'.repeat(3000)}\nCredit Test Lib as the source.`);
        }
    });
});

describe('shipped library', () => {
    it('has DeepWiki, Microsoft Learn and Hugging Face, keyless, with no tools enabled by default', () => {
        const lib = W.getMcpLibrary();
        expect(lib.map((l: any) => l.id)).toEqual(['deepwiki', 'ms_learn', 'hugging_face']);
        for (const l of lib) {
            expect(l.auth).toBeUndefined();
            expect(l.defaultTools ?? []).toEqual([]);
        }
    });

    it('adds a keyless entry with all tools off; readOnly marks unannotated tools read-only', async () => {
        mockServer(msg => msg.method === 'initialize'
            ? { result: { protocolVersion: '2025-06-18' } }
            : { result: { tools: [{ name: 'ask_wiki_question' }, { name: 'read_wiki_structure' }] } }, { session: '' });
        const s = await W.addMcpLibraryServer('deepwiki');
        expect(s.enabledTools).toEqual([]);
        expect(W.mcpToolSpecs()).toEqual([]);
        expect(W.mcpToolRisk('mcp__deepwiki__ask_wiki_question')).toBe('read');
    });
});

describe('HTTP errors carrying a JSON-RPC reply', () => {
    it('surfaces the tool error text instead of the raw HTTP body', async () => {
        mockServer(msg => {
            if (msg.method === 'initialize') return { result: { protocolVersion: '2025-06-18' } };
            if (msg.method === 'tools/list') return { result: { tools: [{ name: 'search_places', annotations: { readOnlyHint: true } }] } };
            return new Response(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result: { isError: true, content: [{ type: 'text', text: 'API key not valid.' }] } }),
                { status: 400, headers: { 'Content-Type': 'application/json' } });
        }, { sse: false, session: '' });
        const s = await W.addMcpServer({ name: 'maps', url: 'https://k.example.com/mcp' });
        W.setMcpToolEnabled(s.id, 'search_places', true);
        expect(await W.executeToolAsync('mcp__maps__search_places', {})).toEqual({ error: 'maps/search_places: API key not valid.' });
    });
});

describe('secret redaction', () => {
    it('redacts raw, bare-bearer and URL-encoded header values; skips short values', () => {
        const h = { Authorization: 'Bearer tok_123456789', 'X-Goog-Api-Key': 'AIza+key/value=', 'X-Short': 'abc' };
        expect(W.redactMcpSecrets('auth=Bearer tok_123456789 raw=tok_123456789', h)).toBe('auth=[redacted] raw=[redacted]');
        expect(W.redactMcpSecrets('url?key=AIza%2Bkey%2Fvalue%3D and AIza+key/value=', h)).toBe('url?key=[redacted] and [redacted]');
        expect(W.redactMcpSecrets('abc stays', h)).toBe('abc stays');
    });

    it('keeps the key out of tool results, tool errors and transport errors', async () => {
        const KEY = 'AIzaSECRETKEY12345';
        let mode = 'result';
        mockServer(msg => {
            if (msg.method === 'initialize') return { result: { protocolVersion: '2025-06-18' } };
            if (msg.method === 'tools/list') return { result: { tools: [{ name: 't', annotations: { readOnlyHint: true } }] } };
            if (mode === 'result') return { result: { content: [{ type: 'text', text: `echo: key=${KEY}` }] } };
            if (mode === 'isError') return { result: { isError: true, content: [{ type: 'text', text: `bad key ${KEY}` }] } };
            return new Response(`upstream rejected X-Goog-Api-Key: ${KEY}`, { status: 500 });
        }, { sse: false, session: '' });
        const s = await W.addMcpServer({ name: 'm', url: 'https://red.example.com/mcp', headers: { 'X-Goog-Api-Key': KEY } });
        W.setMcpToolEnabled(s.id, 't', true);
        for (mode of ['result', 'isError', 'http']) {
            const r = await W.executeToolAsync('mcp__m__t', {});
            expect(JSON.stringify(r)).not.toContain(KEY);
            expect(JSON.stringify(r)).toContain('[redacted]');
        }
    });
});

describe('server instructions', () => {
    function instrServer(instructions: string) {
        return mockServer(msg => msg.method === 'initialize'
            ? { result: { protocolVersion: '2025-06-18', instructions } }
            : { result: { tools: [{ name: 'lookup', annotations: { readOnlyHint: true } }] } }, { session: '' });
    }

    it('saves initialize instructions and injects them only while a tool is enabled', async () => {
        instrServer('Prefer this over web search for library docs.');
        const s = await W.addMcpServer({ name: 'Docs', url: 'https://i.example.com/mcp' });
        expect(s.instructions).toBe('Prefer this over web search for library docs.');
        expect(W.mcpServerInstructionsBlock()).toBe('');
        W.setMcpToolEnabled(s.id, 'lookup', true);
        const block = W.mcpServerInstructionsBlock();
        expect(block).toContain('## MCP servers');
        expect(block).toContain('### Docs (tools: mcp__docs__*)\nPrefer this over web search for library docs.');
        expect(block).toMatch(/do not override your other instructions/);
        // Role ceiling: nothing when the role can't call the server's tools.
        expect(W.mcpServerInstructionsBlock(() => false)).toBe('');
    });

    it('includes long instructions in full', async () => {
        const text = 'start ' + 'y'.repeat(5000) + ' end';
        instrServer(text);
        const s = await W.addMcpServer({ name: 'Long', url: 'https://l.example.com/mcp' });
        W.setMcpToolEnabled(s.id, 'lookup', true);
        const body = W.mcpServerInstructionsBlock().split('### Long (tools: mcp__long__*)\n')[1];
        expect(body.trim()).toBe(text);
    });

    it('appears in the system prompt for the director', async () => {
        instrServer('Use lookup for docs.');
        const s = await W.addMcpServer({ name: 'Docs', url: 'https://sp.example.com/mcp' });
        W.setMcpToolEnabled(s.id, 'lookup', true);
        W.setMainAgentRole('director');
        expect(W.buildSystemPrompt()).toContain('### Docs (tools: mcp__docs__*)\nUse lookup for docs.');
        W.mainAgentRole = null;
    });
});

describe('text-format tool calls with MCP names', () => {
    beforeEach(async () => {
        mockServer(msg => msg.method === 'initialize'
            ? { result: { protocolVersion: '2025-06-18' } }
            : { result: { tools: [{ name: 'search' }, { name: 'resolve-library-id' }] } }, { session: '' });
        const s = await W.addMcpServer({ name: 'docs', url: 'https://t.example.com/mcp' });
        W.setMcpToolEnabled(s.id, 'search', true);
        W.setMcpToolEnabled(s.id, 'resolve-library-id', true);
    });
    const names = (text: string) => W.parseFnTagCalls(text).tool_calls.map((c: any) => [c.function.name, JSON.parse(c.function.arguments)]);

    it('Format D (tag per tool)', () => {
        expect(names('<mcp__docs__search><query>react hooks</query></mcp__docs__search>'))
            .toEqual([['mcp__docs__search', { query: 'react hooks' }]]);
    });
    it('Format F (attributes), including hyphenated names', () => {
        expect(names('<mcp__docs__resolve-library-id libraryName="react"/>'))
            .toEqual([['mcp__docs__resolve-library-id', { libraryName: 'react' }]]);
    });
    it('Format H (python-style)', () => {
        expect(names('mcp__docs__search(query="hooks")')).toEqual([['mcp__docs__search', { query: 'hooks' }]]);
    });
    it('still ignores unknown tags', () => {
        expect(names('<mcp__docs__nope><q>x</q></mcp__docs__nope>')).toEqual([]);
    });
});

describe('MCP session handling', () => {
    beforeEach(() => { localStorage.clear(); });

    it('does not re-send a tools/call after a network error (R08)', async () => {
        let ran = 0;
        const reqs: any[] = [];
        W.fetch.mockImplementation(async (_url: string, init: any) => {
            const body = JSON.parse(init.body);
            reqs.push(body.method);
            if (body.method === 'tools/call') { ran++; throw new TypeError('Failed to fetch'); }   // ran on the server, reply lost
            if (body.id === undefined) return new Response(null, { status: 202 });
            const msg = standardHandler(body);
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...msg }), { headers: { 'Content-Type': 'application/json' } });
        });
        const s = await W.addMcpServer({ name: 'maps', url: 'https://x.example.com/mcp' });
        W.setMcpToolEnabled(s.id, 'search_places', true);
        const r = await W.executeToolAsync('mcp__maps__search_places', { query: 'q' });
        expect(r.error).toMatch(/unknown whether the tool ran/);
        expect(ran).toBe(1);
    });

    it('does not replay a tools/call whose error merely mentions a session', async () => {
        let calls = 0;
        const reqs = mockServer((msg) => {
            if (msg.method === 'tools/call') { calls++; return { error: { code: -32000, message: 'no active session for user 7' } }; }
            return standardHandler(msg);
        });
        const s = await W.addMcpServer({ name: 'maps', url: 'https://x.example.com/mcp' });
        W.setMcpToolEnabled(s.id, 'search_places', true);
        const r = await W.executeToolAsync('mcp__maps__search_places', { query: 'q' });
        expect(r.error).toMatch(/no active session/);
        expect(calls).toBe(1);
        expect(reqs.filter(c => c.body.method === 'initialize')).toHaveLength(1);
    });

    it('sends one initialize for concurrent first calls', async () => {
        const reqs = mockServer(standardHandler);
        // Registered without a handshake, so the three calls below race to open the session.
        localStorage.setItem('fg_mcp_servers', JSON.stringify([{ id: 'racy', name: 'racy', url: 'https://racy.example.com/mcp',
            enabled: true, enabledTools: ['search_places'], tools: [{ name: 'search_places' }] }]));
        const rs = await Promise.all([1, 2, 3].map(i => W.executeToolAsync('mcp__racy__search_places', { query: `q${i}` })));
        expect(rs.map(r => r.content)).toEqual([expect.stringMatching(/q1/), expect.stringMatching(/q2/), expect.stringMatching(/q3/)]);
        expect(reqs.filter(c => c.body.method === 'initialize')).toHaveLength(1);
    });

    it('caps server instructions in aggregate, keeping short notes whole', () => {
        const mk = (id: string, text: string) => ({ id, name: id, url: `https://${id}.example.com`, enabled: true, enabledTools: ['t'],
            tools: [{ name: 't' }], instructions: text });
        localStorage.setItem('fg_mcp_servers', JSON.stringify([mk('a', 'short note'), mk('b', 'x'.repeat(20_000)), mk('c', 'y'.repeat(20_000))]));
        const block = W.mcpServerInstructionsBlock();
        expect(block).toContain('short note');
        expect(block.length).toBeLessThan(13_500);
        expect(block).toContain('…');
    });
});

describe('MCP approval for workers', () => {
    afterEach(() => { document.getElementById('tool-approval-toast')?.remove(); localStorage.removeItem('fg_tool_approval'); });

    it('asks before a worker runs a destructive MCP tool', async () => {
        const reqs = mockServer(standardHandler);
        const s = await W.addMcpServer({ name: 'maps', url: 'https://x.example.com/mcp' });
        W.setMcpToolEnabled(s.id, 'delete.everything', true);
        localStorage.setItem('fg_tool_approval', 'high');
        const toast = document.createElement('div');
        toast.id = 'tool-approval-toast';
        toast.innerHTML = '<span id="tool-approval-label"></span><span id="tool-approval-detail"></span><input type="checkbox" id="tool-approval-session"><span id="tool-approval-session-name"></span>';
        document.body.appendChild(toast);
        const before = reqs.filter(c => c.body.method === 'tools/call').length;
        const p = W.executeToolAsync('mcp__maps__delete_everything', {}, { snapshot: new Map(), staging: new Map() });
        await vi.waitFor(() => expect(toast.style.display).not.toBe('none'));
        W.resolveToolApproval(false);
        expect((await p).error).toMatch(/denied/i);
        expect(reqs.filter(c => c.body.method === 'tools/call').length).toBe(before);
    });
});
