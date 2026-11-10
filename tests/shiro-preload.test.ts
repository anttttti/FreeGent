import { describe, it, expect } from 'vitest';
import { preloadDir } from '../shiro/node-compat/preload';

// Uploaded logs 2026-11-09: `node -e "console.log('hi')"` in a project full of images ran 20-40 s and took the tab down,
// because every run read every file around it as text.
function fakeCtx(files: Record<string, string>, reads: string[]) {
    const dirs = new Set<string>(['/w']);
    for (const f of Object.keys(files)) { let d = f; while ((d = d.slice(0, d.lastIndexOf('/'))) ) dirs.add(d); }
    return {
        fs: {
            readdir: async (d: string) => [...new Set([...Object.keys(files), ...dirs].filter(p => p.startsWith(d + '/') && p.slice(d.length + 1).indexOf('/') < 0).map(p => p.slice(d.length + 1)))],
            stat: async (p: string) => ({ isDirectory: () => dirs.has(p), size: files[p]?.length ?? 0, mtime: new Date(0) }),
            readFile: async (p: string) => { reads.push(p); return files[p]; },
        },
    } as any;
}

describe('node preload', () => {
    it('does not read binary files as text, and reads each text file once', async () => {
        const reads: string[] = [];
        const ctx = fakeCtx({ '/w/a.js': 'x', '/w/sprite.png': '\u0089PNG', '/w/sub/b.mjs': 'y', '/w/sheet.JPEG': 'z' }, reads);
        const cache = new Map<string, string>(), mt = new Map<string, number>();
        await preloadDir(ctx, cache, mt, '/w', 0, 5);
        await preloadDir(ctx, cache, mt, '/w', 0, 10);   // the project-root walk after the working-directory walk
        expect(reads.sort()).toEqual(['/w/a.js', '/w/sub/b.mjs']);
        expect(cache.has('/w/sprite.png')).toBe(false);
        expect(mt.has('/w/sprite.png')).toBe(true);   // existsSync still sees it
    });

    it('stops reading once the budget for one run is used', async () => {
        const reads: string[] = [];
        const big = 'a'.repeat(15_000_000);
        const files: Record<string, string> = {};
        for (let i = 0; i < 6; i++) files[`/w/f${i}.txt`] = big;
        const ctx = fakeCtx(files, reads);
        await preloadDir(ctx, new Map(), new Map(), '/w', 0, 5);
        expect(reads.length).toBe(3);   // 48M characters
    });
});

// Day exploration D002: a file the preload listed without reading was found by existsSync but not by statSync, lstatSync or readdirSync.
describe('files listed without being read', () => {
    it('are seen by existsSync, statSync, lstatSync and readdirSync, with their size, and give way to a write', async () => {
        const { createFileCache } = await import('../shiro/node-compat/file-cache');
        const { createFsModule } = await import('../shiro/node-compat/modules/fs');
        const { createFakeBuffer } = await import('../shiro/node-compat/buffer');
        const reads: string[] = [];
        const ctx = fakeCtx({ '/w/a.txt': 'hello', '/w/icon.png': 'x'.repeat(40) }, reads);
        Object.assign(ctx.fs, { resolvePath: (p: string) => p, readCached: () => undefined, readdirCached: () => undefined, mkdir: async () => {}, writeFile: async () => {} });
        ctx.cwd = '/w';
        const { fileCache, fileMtimes } = createFileCache();
        await preloadDir(ctx as any, fileCache, fileMtimes, '/w', 0, 3);
        const fsm: any = createFsModule({ ctx, fileCache, fileMtimes, pendingPromises: [], tickSyncOps() {}, FakeBuffer: createFakeBuffer(), getBuiltinModule: () => ({}), homeDir: '/home' } as any);
        expect(reads).not.toContain('/w/icon.png');
        expect(fsm.existsSync('/w/icon.png')).toBe(true);
        expect(fsm.statSync('/w/icon.png')).toMatchObject({ size: 40 });
        expect(fsm.statSync('/w/icon.png').isFile()).toBe(true);
        expect(fsm.lstatSync('/w/icon.png').size).toBe(40);
        expect(fsm.readdirSync('/w')).toEqual(['a.txt', 'icon.png']);
        expect(fsm.readdirSync('/w', { recursive: true })).toEqual(['a.txt', 'icon.png']);
        fsm.writeFileSync('/w/icon.png', 'abc');
        expect(fsm.statSync('/w/icon.png').size).toBe(3);
    });
});
