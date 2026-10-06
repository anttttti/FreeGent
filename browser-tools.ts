// Text-only browser tools. The configured bridge owns Playwright and session state;
// page modules never execute agent-supplied JavaScript or attach to arbitrary CDP servers.
let _browserUrl = '';

export const BROWSER_TOOL_NAMES = [
    'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_select', 'browser_scroll', 'browser_back', 'browser_tabs', 'browser_done',
];

const spec = (name: string, description: string, properties = {}, required: string[] = []) =>
    ({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
const ref = { type: 'string', description: 'Element ref returned by the latest browser observation.' };
export const BROWSER_TOOLS_SPEC = [
    spec('browser_navigate', 'Open a URL on a configured local site; returns a text observation.',
        { url: { type: 'string' } }, ['url']),
    spec('browser_snapshot', 'Observe the current page: accessibility tree, page text, and actionable element refs.'),
    spec('browser_click', 'Click an observed element and return the resulting page.', { ref }, ['ref']),
    spec('browser_type', 'Fill an observed editable element. Set submit to press Enter afterwards.',
        { ref, text: { type: 'string' }, submit: { type: 'boolean' } }, ['ref', 'text']),
    spec('browser_select', 'Choose option values in an observed select element.',
        { ref, values: { type: 'array', items: { type: 'string' } } }, ['ref', 'values']),
    spec('browser_scroll', 'Scroll the page vertically by pixels and observe it.',
        { pixels: { type: 'integer', minimum: -10000, maximum: 10000 } }, ['pixels']),
    spec('browser_back', 'Go back in the current tab and observe the resulting page.'),
    spec('browser_tabs', 'List tabs, or select an existing tab by its index.',
        { index: { type: 'integer', minimum: 0 } }),
    spec('browser_done', 'Submit the final structured response and end the browser task.', {
        response: { type: 'object', properties: {
            task_type: { type: 'string', enum: ['RETRIEVE', 'MUTATE', 'NAVIGATE'] },
            status: { type: 'string', enum: ['SUCCESS', 'ACTION_NOT_ALLOWED_ERROR', 'PERMISSION_DENIED_ERROR', 'NOT_FOUND_ERROR', 'DATA_VALIDATION_ERROR', 'UNKNOWN_ERROR'] },
            retrieved_data: { type: ['array', 'null'], items: {} }, error_details: { type: ['string', 'null'] },
        }, required: ['task_type', 'status', 'retrieved_data', 'error_details'], additionalProperties: false },
    }, ['response']),
];

export function setBrowserBridge(url: string): void {
    if (!url) { _browserUrl = ''; return; }
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
        throw new Error('Browser bridge must be an HTTP(S) URL without credentials, query, or fragment.');
    _browserUrl = u.href.replace(/\/$/, '');
}
export function browserBridgeAvailable(): boolean { return !!_browserUrl; }
export async function executeBrowserTool(name: string, args: any = {}): Promise<any> {
    if (!_browserUrl) return { error: 'No browser bridge configured.' };
    if (!BROWSER_TOOL_NAMES.includes(name)) return { error: 'Unknown browser tool.' };
    try {
        const res = await fetch(`${_browserUrl}/browser/${name.slice(8)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args), signal: AbortSignal.timeout(60_000),
        });
        const value = await res.json();
        if (!res.ok) return { error: typeof value.error === 'string' ? value.error.slice(0, 300) : `Browser operation failed (HTTP ${res.status}).` };
        return value;
    } catch (e) { return { error: `Browser operation failed: ${e.message}` }; }
}

export function browserPromptGuidance(allows: (name: string) => boolean): string {
    if (!_browserUrl || !BROWSER_TOOL_NAMES.some(n => isToolActive(n) && allows(n))) return '';
    return '\n## Browser\nUse browser_snapshot to observe the accessibility tree and element refs. Use those refs in browser_click, browser_type, and browser_select; refresh the observation after navigation. Only configured local sites are reachable. Submit the requested structured response with browser_done when finished. No screenshots or arbitrary page scripts are available.\n';
}
Object.assign(window, { BROWSER_TOOL_NAMES, BROWSER_TOOLS_SPEC, setBrowserBridge,
    browserBridgeAvailable, executeBrowserTool, browserPromptGuidance });
