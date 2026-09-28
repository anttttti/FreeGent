// Absolute paths in a Docker task container (v0.57 fixes review §2). _normToolPath stripped the
// leading "/", so `docker exec cat app/x` resolved against the image WORKDIR (/app/app/x):
// every absolute-path read_file in TerminalBench v0.55–v0.57 failed ("File not found in container: app/…").
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { _normToolPath } from '../tools.ts';
import { setWorkspaceAdapter } from '../workspace.ts';
import { DockerFsAdapter } from '../node-fs-adapter.ts';

let T: any;
beforeAll(async () => { T = await import('../tools.ts'); });
afterEach(() => setWorkspaceAdapter(null));

const fake = (absolutePaths: boolean, seen: string[]) => ({
    absolutePaths,
    agentListFiles: async () => [{ name: '/app/compute_seq.py' }],
    agentReadFile: async (p: string) => { seen.push(p); return 'print(1)\n'; },
    agentWriteFile: async (p: string) => { seen.push(p); },
    agentDeleteFile: async () => {},
});

describe('_normToolPath', () => {
    it('workspace adapters: "/" and /workspace/ mean the workspace root', () => {
        setWorkspaceAdapter(fake(false, []) as any);
        expect(_normToolPath('/app/x.py')).toBe('app/x.py');
        expect(_normToolPath('/workspace/src/a.py')).toBe('src/a.py');
    });
    it('an absolute-path adapter gets every path unchanged', () => {
        setWorkspaceAdapter(fake(true, []) as any);
        expect(_normToolPath('/app/x.py')).toBe('/app/x.py');
        expect(_normToolPath('/workspace/a.py')).toBe('/workspace/a.py');
        expect(_normToolPath('rel/a.py')).toBe('rel/a.py');
    });
    it('DockerFsAdapter declares absolute paths', () => {
        expect(new DockerFsAdapter('ctr').absolutePaths).toBe(true);
    });
});

describe('read_file / write_file reach the container with the absolute path', () => {
    it('passes /app/compute_seq.py through', async () => {
        const seen: string[] = [];
        setWorkspaceAdapter(fake(true, seen) as any);
        const r = await T.executeToolAsync('read_file', { path: '/app/compute_seq.py' }, null);
        expect(r.error).toBeUndefined();
        await T.executeToolAsync('write_file', { path: '/app/out.txt', content: 'x' }, null);
        expect(seen).toContain('/app/compute_seq.py');
        expect(seen).toContain('/app/out.txt');
    });
});
