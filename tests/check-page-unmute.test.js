// WebKit hides the message of errors from inline scripts in a sandboxed srcdoc frame ("Script error."), also through eval and
// new Function; a script loaded from a blob: URL the frame made itself reports in full. check_page on WebKit rewrites each
// inline classic script that way (probe AE09 under ENGINE=webkit; before, the agent saw only "Script error.").
const { _unmuteInlineScripts } = await import('../tabs.ts');

describe('_unmuteInlineScripts', () => {
    it('rewrites inline classic scripts to load from a frame-made blob: URL, in place', () => {
        const out = _unmuteInlineScripts('<head><script>var a = 1;</script></head><body><script type="text/javascript">f("</script")</script></body>');
        expect(out).not.toContain('var a = 1;</script>');
        const writes = [...out.matchAll(/document\.write\('<scr'\+'ipt src="'\+URL\.createObjectURL\(new Blob\(\[("(?:[^"\\]|\\.)*")\]/g)].map(m => m[1]);
        expect(writes).toHaveLength(2);
        expect(JSON.parse(writes[0].replace(/<\\\//g, '</'))).toBe('var a = 1;');
        expect(out.indexOf('var a = 1')).toBeLessThan(out.indexOf('<body>'));
    });
    it('leaves external, module, JSON, template and empty scripts alone', () => {
        const html = '<script src="x.js"></script><script type="module">import "./a.js"</script><script type="importmap">{}</script>'
            + '<script type="application/ld+json">{}</script><script type="text/template"><b></b></script><script> </script>';
        expect(_unmuteInlineScripts(html)).toBe(html);
    });
    it('the rewritten script text runs as the original did', () => {
        const out = _unmuteInlineScripts('<script>window.__x = "a</scr" + "ipt>" + 1;</script>');
        const lit = /new Blob\(\[("(?:[^"\\]|\\.)*")\]/.exec(out)[1];
        const code = new Function(`return ${lit}`)();
        expect(code).toBe('window.__x = "a</scr" + "ipt>" + 1;');
    });
});
