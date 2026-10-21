// codex report 8, cases 372-373, 376-379, 381: Markdown rendering keeps code literal and links to workspace files work.
import { describe, it, expect, beforeAll } from 'vitest';
import { _workspacePathFromHref } from '../chat-render.ts';

const W: any = window;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
    await import('../chat-render.ts');
    // The jsdom renderer has no marked: use a tiny stand-in that keeps fences and inline code, so what the preprocessing does to
    // code is visible in the output.
    W.marked = { parse: (t: string) => t.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, l, c) => `<pre><code class="language-${l}">${c.replace(/</g, '&lt;')}</code></pre>`)
        .replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c.replace(/</g, '&lt;')}</code>`) };
    W.DOMPurify = { sanitize: (h: string) => h };
    W.katex = { renderToString: (e: string) => `<span class="katex">${e}</span>` };
});

describe('code stays literal (377/379/381)', () => {
    it('SVG source in a fence and in inline code is not turned into an image slot', () => {
        const html = W.renderMarkdown('Source:\n\n```svg\n<svg width="10"><circle r="4"/></svg>\n```\n\nInline `<svg><g/></svg>` too.');
        expect(html).not.toContain('md-img-slot');
        expect(html).toContain('&lt;svg width="10">');
        expect(html).toContain('&lt;svg>&lt;g/>&lt;/svg>');
    });
    it('SVG outside code is still an image slot', () => {
        expect(W.renderMarkdown('Look: <svg width="10"><circle r="4"/></svg>')).toContain('md-img-slot');
    });
    it('math syntax in code is kept as typed, outside code it is rendered', () => {
        const html = W.renderMarkdown('```tex\n$$x^2+y^2$$\n```\n\nInline `\\(a\\)` and real $$e^{i\\pi}$$.');
        expect(html).toContain('$$x^2+y^2$$');
        expect(html).toContain('\\(a\\)');
        expect(html.match(/class="katex"/g)).toHaveLength(1);
    });
    it('an unclosed fence protects the rest of the text', () => {
        const html = W.renderMarkdown('```html\n<svg><g/></svg>');
        expect(html).not.toContain('md-img-slot');
    });
    it('text around code keeps its line breaks', () => {
        const html = W.renderMarkdown('one\n\n```js\nlet a;\n```\ntwo');
        expect(html).toContain('one\n\n<pre>');
        expect(html).toContain('</pre>\ntwo');
    });
});

describe('workspace links (372/373)', () => {
    it.each([
        ['/workspace/guide.md', 'guide.md'], ['/workspace/my%20notes.md', 'my notes.md'], ['/workspace/caf%C3%A9.txt', 'café.txt'],
        ['/workspace/%70lan.md', 'plan.md'], ['docs/a%20b.md', 'docs/a b.md'], ['./x.csv', 'x.csv'],
    ])('%s opens %s', (href, path) => expect(_workspacePathFromHref(href)).toBe(path));
    it.each(['https://example.com/a.md', '//host/a.md', '#top', 'mailto:a@b.c', '../secret.md', '/etc/passwd.txt', '/workspace/dir//x.md', '/workspace/noext'])('%s is not a workspace link', href => {
        expect(_workspacePathFromHref(href)).toBeNull();
    });
});

describe('Run buttons use the full language names (376)', () => {
    it('javascript and typescript fences get a Run button like js and ts', () => {
        const el = document.createElement('div');
        for (const l of ['js', 'ts', 'javascript', 'typescript', 'python', 'rust']) el.innerHTML += `<pre><code class="language-${l}">x</code></pre>`;
        const r = W.buildResponseEl('x');   // exercises the builder; the buttons themselves come from _addCodeBlockButtons
        void r;
        const holder = W.buildResponseEl('```javascript\nlet a = 1;\n```\n\n```typescript\nlet b = 2;\n```\n\n```rust\nfn main() {}\n```');
        expect(holder.querySelectorAll('.artifact-run-btn')).toHaveLength(2);
    });
});

describe('copied text (375/380)', () => {
    it('keeps the line breaks of a user bubble and leaves its controls out', () => {
        document.body.innerHTML = '<div id="agent-messages"></div>';
        const div = W.appendMessage('user', '東京<br>Second line');
        const bubble = div.querySelector('.agent-msg-bubble')!;
        expect(W.plainTextOf(bubble)).toBe('東京\nSecond line');
    });
    it('leaves the Run label and the action row out of a copied reply', () => {
        const el = W.buildResponseEl('Here:\n\n```html\n<b>x</b>\n```\n\nDone.');
        const bubble = document.createElement('div'); bubble.appendChild(el); bubble.appendChild(W.buildResponseActionRow(el));
        const copied = W.plainTextOf(el, 'button, [data-action], .artifact-run-btn, .agent-turn-diff-row');
        expect(copied).not.toContain('▶ Run');
        expect(copied).not.toContain('⎘');
    });
});
