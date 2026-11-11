// The settings a profile file may hold (profile-keys.ts credentialFreeSettings): shared by the WebUI profiles and the headless/TUI saveProfile (codex R1066, R1072-R1075).
import { credentialFreeSettings } from '../profile-keys.ts';

describe('credentialFreeSettings', () => {
    it('drops credential keys, MCP auth headers, custom-model keys and URLs with a password in them', () => {
        const out = credentialFreeSettings({
            fg_openai_key: 'sk-secret', fg_agent_compact_tokens: '50000', fg_temperature: '0.3',
            fg_mcp_servers: JSON.stringify([{ url: 'https://m.example/mcp', headers: { Authorization: 'Bearer S' } }]),
            fg_custom_models: JSON.stringify([{ model: 'a', key: 'S1' }, { model: 'b', apiKey: 'S2', url: 'u' }]),
            fg_search_proxy: 'https://user:pw@proxy.example/search', fg_api_url: 'https://api.example/v1',
        });
        expect(Object.keys(out).sort()).toEqual(['fg_agent_compact_tokens', 'fg_api_url', 'fg_custom_models', 'fg_temperature']);
        expect(JSON.parse(out.fg_custom_models)).toEqual([{ model: 'a' }, { model: 'b', url: 'u' }]);
        expect(JSON.stringify(out)).not.toMatch(/S1|S2|Bearer|pw@|sk-secret/);
    });
    it('a custom-models value that is not a list is dropped, not passed on', () => {
        expect('fg_custom_models' in credentialFreeSettings({ fg_custom_models: '{"key":"S"' })).toBe(false);
    });
});
