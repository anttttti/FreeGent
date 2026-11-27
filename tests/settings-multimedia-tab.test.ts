// The Voice tab became Multimedia and holds the media model routing that used to sit in the Models tab.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const section = (tab: string) => {
    const start = html.search(new RegExp(`<div class="settings-tab-panel[^"]*" data-tab="${tab}">`));
    const rest = html.slice(start + 10);
    const next = rest.search(/<div class="settings-tab-panel|<p class="settings-hint settings-version">/);
    return html.slice(start, start + 10 + next);
};

describe('Multimedia settings tab', () => {
    it('is the old Voice tab, with speech input, speech output and media model routing in it and no routing left in Models', () => {
        expect(html).toMatch(/data-tab="voice"[^>]*>Multimedia<\/button>/);
        const mm = section('voice'), models = section('model');
        expect(mm).toContain('Speech Input (STT)');
        expect(mm).toContain('Speech Output (TTS)');
        expect(mm).toContain('id="media-model-selectors"');
        expect(models).toContain('Model Catalog');   // the right panel was found
        expect(models).not.toContain('Media Model Routing');
        expect(models).not.toContain('media-model-selectors');
    });
});

describe('media model selectors', () => {
    beforeAll(async () => {
        (window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        await import('../settings-ui.ts');
    });
    it('render as table rows with the same labels as the speech settings', () => {
        document.body.innerHTML = '<table><tbody id="media-model-selectors"></tbody></table>';
        (window as any).renderMediaModelSelectors();
        const rows = [...document.querySelectorAll('#media-model-selectors tr')];
        expect(rows.map(r => r.querySelector('td')!.textContent)).toEqual(['Image input', 'Audio input', 'Video input']);
        expect(rows[0].querySelector('td')!.className).toBe('settings-table-label');
        expect(rows[0].querySelector('select option')!.textContent).toBe('Auto');
    });
});
