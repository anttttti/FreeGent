// From the third refused call in a row with empty arguments the refusal says the arguments are being lost (chat log e846bbac: read_file {} x8, check_page {} x6).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
const W: any = window;
beforeAll(async () => { await import('../tools.ts'); });
beforeEach(() => {
    W.mainAgentRole = null;
    W.agentReadFile = async (p: string) => 'content of ' + p;
    W.agentListFiles = async () => [];
});
const run = (name: string, args: any) => W.executeToolAsync(name, args, null);

describe('empty-argument streak', () => {
    it('the first two refusals are the plain text, the third and later say the arguments are being lost and name execute_code', async () => {
        const e = [(await run('read_file', {})).error, (await run('read_file', {})).error, (await run('read_file', {})).error, (await run('read_file', {})).error];
        expect(e[0]).toMatch(/missing required argument "path"/);
        expect(e[0]).not.toContain('EMPTY');
        expect(e[1]).not.toContain('EMPTY');
        expect(e[2]).toMatch(/call 3 in a row to read_file that arrived with EMPTY arguments/);
        expect(e[2]).toContain('execute_code');
        expect(e[3]).toMatch(/call 4 in a row/);
    });
    it('a call with arguments resets the streak, and so does a refusal that is not about missing arguments', async () => {
        await run('read_file', {}); await run('read_file', {});
        const ok = await run('read_file', { path: 'a.txt' });
        expect(ok.error).toBeUndefined();
        const again = await run('read_file', {});
        expect(again.error).not.toContain('EMPTY');                       // streak restarted at 1
        // other tools keep their own count
        const other = await run('search_workspace', {});
        expect(other.error).not.toContain('EMPTY');
    });
});
