// Settings → Credentials lists saved keys of providers FreeGent no longer has, with a Remove (exploration G07).
let renderOrphanKeys: () => void;
beforeAll(async () => {
    (window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });   // settings-ui reads it at load
    ({ renderOrphanKeys } = await import('../settings-ui.ts'));
});

describe('renderOrphanKeys', () => {
    beforeEach(() => { localStorage.clear(); document.body.innerHTML = '<div id="orphan-keys" style="display:none"></div>'; });

    it('lists fg_<name>_key entries the registry does not know, not current keys or other tokens, and Remove deletes one', () => {
        localStorage.setItem('fg_cerebras_key', 'a'); localStorage.setItem('fg_mistral_key', 'b');
        localStorage.setItem('fg_openai_key', 'c'); localStorage.setItem('fg_server_token', 'd');
        renderOrphanKeys();
        const box = document.getElementById('orphan-keys')!;
        expect(box.style.display).toBe('');
        expect([...box.querySelectorAll('code')].map(c => c.textContent)).toEqual(['fg_cerebras_key', 'fg_mistral_key']);
        (box.querySelector('button') as HTMLButtonElement).click();
        expect(localStorage.getItem('fg_cerebras_key')).toBeNull();
        expect(localStorage.getItem('fg_mistral_key')).toBe('b');
        expect(localStorage.getItem('fg_openai_key')).toBe('c');
    });

    it('stays hidden when there is nothing to list', () => {
        localStorage.setItem('fg_openai_key', 'c');
        renderOrphanKeys();
        expect(document.getElementById('orphan-keys')!.style.display).toBe('none');
    });
});
