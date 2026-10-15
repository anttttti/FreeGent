// Findings from touring the WebUI in a browser (2026-10-15): the runner zone collapsed itself when
// the loop started, a Developer key pasted in the key box was left in plain text with no pointer,
// and utility calls went to a hosted default although the user's main model is a local endpoint.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const W = window as any;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
    await import('../runner.ts');
});

describe('runner zone', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="runner-zone" class="collapsed"></div><button id="runner-zone-toggle"></button>';
    });
    it('toggleRunnerZone(true) opens it, (false) closes it, no argument flips it', () => {
        const zone = () => document.getElementById('runner-zone')!;
        W.toggleRunnerZone(true);
        expect(zone().classList.contains('collapsed')).toBe(false);
        W.toggleRunnerZone(true);                                  // already open: stays open
        expect(zone().classList.contains('collapsed')).toBe(false);
        W.toggleRunnerZone(false);
        expect(zone().classList.contains('collapsed')).toBe(true);
        W.toggleRunnerZone();
        expect(zone().classList.contains('collapsed')).toBe(false);
    });
});

describe('key paste box', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '<textarea id="key-paste"></textarea><span id="key-paste-status"></span><input id="dev-key">';
    });
    it('a short non-key line is cleared and pointed at the Developer key field', () => {
        const box = document.getElementById('key-paste') as HTMLTextAreaElement;
        box.value = 'some-shared-passphrase-1';
        W.fillKeysFromBox(box);
        expect(box.value).toBe('');
        expect(document.getElementById('key-paste-status')!.textContent).toMatch(/Developer key/);
        expect(localStorage.getItem('fg_dev_key')).toBeNull();     // never saved from this box
    });
});

describe('utility model default', () => {
    beforeEach(() => localStorage.clear());
    it('stays on a custom main endpoint when the user has not chosen one', () => {
        const M = 'my-local-model';
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'custom', model: M, name: 'Local', contextK: 32 }]));
        localStorage.setItem('fg_main_models', JSON.stringify([`custom|${M}`]));
        localStorage.setItem('fg_openai_key', 'x');
        expect(W.getActiveMainModelList()).toEqual([`custom|${M}`]);
        expect(W.getUtilityModel()).toBe(`custom|${M}`);
    });
    it('keeps the hosted default for a hosted main model', () => {
        localStorage.setItem('fg_main_models', JSON.stringify(['google|gemini-3.5-flash-lite']));
        expect(W.getUtilityModel()).toBe('google|gemma-4-26b-a4b-it');
    });
    it('keeps an explicit choice', () => {
        localStorage.setItem('fg_utility_model', 'none');
        expect(W.getUtilityModel()).toBe('none');
    });
});
