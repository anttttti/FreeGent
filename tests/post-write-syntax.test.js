// Post-write parse checks in the WebUI (no native toolchain) and search hits inside base64 data, from chat log 45cdc500
// (task 107): a replace_in_file whose old_string was the start of drawLoops and whose new_string was the whole function left
// render.js unparseable, the result said "No need to re-read the file to verify", and the game stopped loading. The same run's
// search for "loop" returned 30 KB of PNG base64.
import { runtime } from '../runtime.ts';
const W = globalThis;

let files, saved;
beforeEach(() => {
    files = new Map();
    W.mainAgentRole = null;
    saved = { r: W.agentReadFile, w: W.agentWriteFile, l: W.agentListFiles };
    W.agentReadFile = async p => { if (!files.has(p)) throw new Error(`File not found: ${p}`); return files.get(p); };
    W.agentWriteFile = async (p, c) => { files.set(p, c); };
    W.agentListFiles = async () => [...files.keys()].map(name => ({ name, size: files.get(name).length }));
});
afterEach(() => { W.agentReadFile = saved.r; W.agentWriteFile = saved.w; W.agentListFiles = saved.l; });

const RENDER = [
    'export class Renderer {',
    '  drawLoops(world) {',
    '    for (const L of world.loops) {',
    '      g.save();',
    '      // Outer lip: the lit top of the arch.',
    '      g.stroke();',
    '      g.restore();',
    '    }',
    '  }',
    '}',
    '',
].join('\n');

describe('an edit that leaves a file unparseable (WebUI: no native toolchain)', () => {
    it('runs without the native check here', () => { expect(runtime.hasNativeExec).toBeFalsy(); });

    it('replace_in_file of a function head with the whole function: syntax_error with the place, no "no need to re-read"', async () => {
        files.set('src/render.js', RENDER);
        const res = await W.executeToolAsync('replace_in_file', {
            path: 'src/render.js',
            old_string: '  drawLoops(world) {\n    for (const L of world.loops) {\n      g.save();\n      // Outer lip: the lit top of the arch.',
            new_string: '  drawLoops(world) {\n    for (const L of world.loops) {\n      g.save();\n      // Outer lip: the lit top of the arch.\n      g.stroke();\n      g.restore();\n    }\n  }',
        }, null);
        expect(res.success).toBe(true);
        expect(res.syntax_error).toMatch(/^src\/render\.js:\d+:\d+: SyntaxError: /);
        expect(res.syntax_hint).toMatch(/undo_write/);
        expect(JSON.stringify(res)).not.toMatch(/No need to re-read/);
    });

    it('a clean edit keeps its note and gets no syntax_error', async () => {
        files.set('src/render.js', RENDER);
        const res = await W.executeToolAsync('replace_in_file', { path: 'src/render.js', old_string: 'g.save();', new_string: 'g.save(); g.beginPath();' }, null);
        expect(res.syntax_error).toBeUndefined();
        expect(res.note).toMatch(/No need to re-read/);
    });

    it('write_file: broken JSON is reported with its line; a JSONC config and an empty file are not', async () => {
        const bad = await W.executeToolAsync('write_file', { path: 'data/levels.json', content: '{\n  "a": 1,\n}\n' }, null);
        expect(bad.syntax_error).toMatch(/^data\/levels\.json:3:1: SyntaxError: /);
        const jsonc = await W.executeToolAsync('write_file', { path: 'tsconfig.json', content: '{\n  // strict\n  "strict": true\n}\n' }, null);
        expect(jsonc.syntax_error).toBeUndefined();
        const empty = await W.executeToolAsync('write_file', { path: 'empty.json', content: '' }, null);
        expect(empty.syntax_error).toBeUndefined();
    });

    it('write_file: an HTML page whose inline script does not parse is reported at the line of the HTML file', async () => {
        const res = await W.executeToolAsync('write_file', { path: 'index.html', content: '<!doctype html>\n<html>\n<body>\n<script>\n  let a = 1;\n  function f( {\n  }\n</script>\n</body>\n</html>\n' }, null);
        expect(res.syntax_error).toMatch(/^index\.html:\d+:\d+: SyntaxError in the <script> at line 4: /);
        const line = +/^index\.html:(\d+)/.exec(res.syntax_error)[1];
        expect(line).toBeGreaterThanOrEqual(6);
        const ok = await W.executeToolAsync('write_file', { path: 'ok.html', content: '<script type="module">import a from "./a.js"; a();</script><script type="x-shader/x-fragment">void main() {</script>' }, null);
        expect(ok.syntax_error).toBeUndefined();
    });

    it('a JSX component in a .js file is not reported', async () => {
        const res = await W.executeToolAsync('write_file', { path: 'src/App.js', content: 'export default function App() {\n  return (<div className="app">hi</div>);\n}\n' }, null);
        expect(res.syntax_error).toBeUndefined();
    });

    it('a worker\'s staged edit is checked too (nothing on disk yet)', async () => {
        const staging = new Map();
        const ctx = { staging, binary: new Map(), snapshot: { get: async p => (p === 'src/render.js' ? RENDER : null), list: () => [] }, depth: 1 };
        const res = await W.executeToolAsync('replace_in_file', { path: 'src/render.js', old_string: '    }\n  }\n}', new_string: '    }\n  }\n}\n}' }, ctx);
        expect(res.success).toBe(true);
        expect(staging.get('src/render.js')).toMatch(/\}\n\}\n$/);
        expect(res.syntax_error).toMatch(/^src\/render\.js:\d+:\d+: SyntaxError/);
    });
});

describe('search_workspace and base64 data', () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAmgAAABLCAYAAADESHv4AABcDUlEQVR4nO39d7Tl113Y/b93' + 'loopAbC9'.repeat(40);
    it('does not search the contents of images; a name match still counts', async () => {
        files.set('assets/loop_sprite.png', b64);
        files.set('assets/explosion.png', b64);
        files.set('src/world.js', 'collectLoops() { const loop = 1; }');
        const res = await W.executeToolAsync('search_workspace', { pattern: 'loop' }, null);
        const text = res.matches.join('\n');
        expect(text).toMatch(/src\/world\.js:1/);
        expect(text).toMatch(/assets\/loop_sprite\.png {2}\(filename match\)/);
        expect(text).not.toMatch(/explosion|iVBOR/);
    });
    it('drops a hit inside a data: URL in code but keeps a real one on the same line', async () => {
        files.set('src/atlas_data.js', `export const ATLAS = "data:image/png;base64,${b64}";`);
        files.set('src/atlas2.js', `const loop = 1; export const ATLAS = "data:image/png;base64,${b64}";`);
        const res = await W.executeToolAsync('search_workspace', { pattern: 'loop' }, null);
        const text = res.matches.join('\n');
        expect(text).not.toMatch(/atlas_data\.js/);
        expect(text).toMatch(/atlas2\.js:1/);
    });
});

describe('brokenFileReport (the completion gate\'s check)', () => {
    it('reports only the changed files that do not parse; a missing file is skipped', async () => {
        const { brokenFileReport } = await import('../tools.ts');
        files.set('src/ok.js', 'export const a = 1;\n');
        files.set('src/bad.js', 'export const a = ;\n');
        files.set('data.json', '{"a": 1}');
        const r = await brokenFileReport(['src/ok.js', 'src/bad.js', 'data.json', 'gone.js', 'notes.md']);
        expect(r).toHaveLength(1);
        expect(r[0]).toMatch(/^src\/bad\.js:1:\d+: SyntaxError/);
    });
});
