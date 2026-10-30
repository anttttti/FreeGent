// codex R274/R275/R277/R278: npm install said "installed successfully" after failures and wrote package.json first, extracted two versions of
// one package into one directory, and left no command (FWFileSystem has no symlinks); npx ran the guessed name, not the package's bin.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));
// jsdom cannot gunzip: the tarball's members are written as they would be.
const tarballs = vi.hoisted(() => new Map<string, Record<string, string>>());
vi.mock('../shiro/utils/tar-utils', () => ({
    extractTarGzToFS: async (data: Uint8Array, baseDir: string, fs: any) => {
        for (const [p, c] of Object.entries(tarballs.get(new TextDecoder().decode(data)) ?? {})) await fs.writeFile(`${baseDir}/${p}`, new TextEncoder().encode(c));
    },
}));
import { getShell } from '../shiro/shell-singleton';

const W = globalThis as any;
const registry: Record<string, any> = {};
const pkgMeta = (name: string, versions: Record<string, { deps?: Record<string, string>; bin?: any; script?: string }>) => {
    registry[name] = { name, 'dist-tags': { latest: Object.keys(versions).at(-1) }, versions: Object.fromEntries(Object.entries(versions).map(([v, o]) => {
        const url = `https://registry.test/${name}-${v}.tgz`;
        tarballs.set(url, { 'package.json': JSON.stringify({ name, version: v, bin: o.bin }), ...(o.script ? { 'cli.js': o.script } : {}) });
        return [v, { name, version: v, dependencies: o.deps ?? {}, dist: { tarball: url } }];
    })) };
};
let sh: any;
const run = async (cmd: string) => { const r = await sh.exec(cmd); return { out: r.stdout.replace(/\r\n/g, '\n'), err: r.stderr.replace(/\r\n/g, '\n'), code: r.exitCode ?? 0 }; };
beforeAll(async () => {
    sh = await getShell();
    W.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith('.tgz')) return new Response(u, { status: 200 });
        const name = decodeURIComponent(u.replace(/^.*registry\.npmjs\.org\//, ''));
        return registry[name] ? new Response(JSON.stringify(registry[name]), { status: 200 }) : new Response('not found', { status: 404, statusText: 'Not Found' });
    });
});
beforeEach(() => { for (const k of [...files.keys()]) if (k.startsWith('node_modules') || k === 'package.json') files.delete(k); files.set('package.json', { content: '{"name":"t","version":"1.0.0"}', encoding: null }); });

describe('npm install', () => {
    it('a package that cannot be found fails the install and stays out of package.json (R274)', async () => {
        const r = await run('npm install no-such-pkg-r274');
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/install is incomplete/);
        expect(files.get('package.json')!.content).not.toContain('no-such-pkg-r274');
    });
    it('two versions of one package are refused, nothing installed (R275)', async () => {
        pkgMeta('c-r275', { '1.0.0': {}, '2.0.0': {} });
        pkgMeta('a-r275', { '1.0.0': { deps: { 'c-r275': '1.0.0' } } });
        pkgMeta('b-r275', { '1.0.0': { deps: { 'c-r275': '2.0.0' } } });
        const r = await run('npm install a-r275 b-r275');
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/more than one version of c-r275 \(1\.0\.0, 2\.0\.0\)/);
        expect([...files.keys()].some(k => k.startsWith('node_modules/c-r275'))).toBe(false);
    });
    it('a package\'s bin becomes a runnable command, and npx runs the declared name (R277/R278)', async () => {
        pkgMeta('foo-cli-r277', { '1.0.0': { bin: { foo: './cli.js' }, script: "console.log('foo ran', process.argv.slice(2).join(' '))" } });
        const r = await run('npm install foo-cli-r277');
        expect(r.code).toBe(0);
        expect(files.get('node_modules/.bin/foo')?.content).toMatch(/node_modules\/foo-cli-r277\/cli\.js$/);
        expect(files.get('package.json')!.content).toContain('foo-cli-r277');
        const x = await run('npx foo-cli-r277 hello');
        expect(x.out).toContain('foo ran hello');
    });
    it('npx with an explicit version does not run another installed version (R276)', async () => {
        pkgMeta('ver-r276', { '1.0.0': { bin: { ver: './cli.js' }, script: "console.log('v1')" }, '2.0.0': { bin: { ver: './cli.js' }, script: "console.log('v2')" } });
        await run('npm install ver-r276@1.0.0');
        expect((await run('npx ver-r276')).out).toContain('v1');
        expect((await run('npx ver-r276@2.0.0')).out).toContain('v2');
    });
});
