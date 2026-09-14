// mcp.js — FreeGent: Model Context Protocol client (Streamable HTTP transport)
// Currently wires up Context7 for live library documentation.

const MCP_CONTEXT7_URL = 'https://mcp.context7.com/mcp';

// Session cache: serverUrl → { sessionId }
const _mcpSessions = new Map();

async function _mcpPost(serverUrl, payload, sessionId = null) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const resp = await fetch(serverUrl, {
        method: 'POST', headers,
        body:   JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000)
    });
    if (!resp.ok) throw new Error(`MCP HTTP ${resp.status}`);

    const newSession = resp.headers.get('Mcp-Session-Id') || sessionId || null;
    const ct = resp.headers.get('content-type') || '';

    if (ct.includes('text/event-stream')) {
        const text = await resp.text();
        // Find the response matching our request id
        for (const line of text.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
                const msg = JSON.parse(line.slice(6));
                if (payload.id !== undefined && msg.id !== payload.id) continue;
                return { data: msg, sessionId: newSession };
            } catch {}
        }
        throw new Error('MCP: no matching response in SSE stream');
    }

    return { data: await resp.json(), sessionId: newSession };
}

async function _getMCPSession(serverUrl) {
    if (_mcpSessions.has(serverUrl)) return _mcpSessions.get(serverUrl);

    const { data, sessionId } = await _mcpPost(serverUrl, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {},
                  clientInfo: { name: 'FreeGent', version: '1.0' } }
    });
    if (data.error) throw new Error(`MCP init: ${data.error.message || JSON.stringify(data.error)}`);

    // Send initialized notification (fire-and-forget)
    _mcpPost(serverUrl, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId).catch(() => {});

    const session = { sessionId };
    _mcpSessions.set(serverUrl, session);
    return session;
}

async function callMCPTool(serverUrl, toolName, args) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const session = await _getMCPSession(serverUrl);
            const { data } = await _mcpPost(serverUrl, {
                jsonrpc: '2.0', id: Date.now(),
                method: 'tools/call',
                params: { name: toolName, arguments: args }
            }, session.sessionId);

            if (data.error) {
                // Session may have expired — retry once with fresh session
                if (attempt === 0 && /session|expired/i.test(data.error.message || '')) {
                    _mcpSessions.delete(serverUrl);
                    continue;
                }
                throw new Error(data.error.message || JSON.stringify(data.error));
            }

            const result = data.result;
            if (!result) throw new Error('MCP: empty result');
            const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
            return text || JSON.stringify(result);
        } catch (e) {
            if (attempt === 0 && /session|expired/i.test(e.message)) {
                _mcpSessions.delete(serverUrl); continue;
            }
            throw e;
        }
    }
}

window.callMCPTool      = callMCPTool;
window.MCP_CONTEXT7_URL = MCP_CONTEXT7_URL;

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { MCP_CONTEXT7_URL, callMCPTool });
