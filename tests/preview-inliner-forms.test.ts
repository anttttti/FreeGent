// codex R465, R467, R468, R471, R472: the workspace inliner meets valid HTML written another way.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const W = window as any;
let n = 0;
const files: Record<string, string> = { 'style.css': 'body{color:red}', 'app.js': 'window.__ran=1;', 'print.css': 'p{color:blue}' };
const prev = { agentReadFile: W.agentReadFile };
beforeAll(async () => {
    await import('../tabs.ts');
    W.agentReadFile = async (p: string) => { if (p in files) return files[p]; throw new Error(`File not found: ${p}`); };
});
afterAll(() => { W.agentReadFile = prev.agentReadFile; });

async function srcdocOf(html: string): Promise<string> {
    W.getEffectiveProxy = () => 'https://px.test';
    document.body.innerHTML = '<div id="tab-bar"></div><div id="tab-content"></div>';
    await W.openArtifactTab(`inl${++n}.html`, html);
    return (document.querySelector('iframe.artifact-iframe') as HTMLIFrameElement).srcdoc;
}

describe('workspace reference inlining', () => {
    it('inlines a stylesheet whose href comes before rel, and keeps its media query', async () => {
        const doc = await srcdocOf('<html><head><link href="style.css" rel="stylesheet"><link rel = stylesheet href = print.css media=print></head><body></body></html>');
        expect(doc).toContain('body{color:red}');
        expect(doc).toMatch(/<style media="print">\s*p\{color:blue\}/);
        expect(doc).not.toContain('href="style.css"');
    });
    it('inlines a script written with an unquoted src', async () => {
        const doc = await srcdocOf('<html><head></head><body><script src=app.js></script></body></html>');
        expect(doc).toContain('window.__ran=1;');
        expect(doc).not.toContain('src=app.js');
    });
    it('does not turn a top-level `const location` into a navigation', async () => {
        const doc = await srcdocOf('<html><head></head><body><script>\nconst location = { x: 4 };\nconst score = 1;\n</script></body></html>');
        expect(doc).toContain('const location = { x: 4 };');
        expect(doc).toContain('window.score = 1;');
    });
});
