// cline report 2026-10-19: D1 (rail hidden at <=700px until init adds .mobile-open), D2 (failed mic
// attempt gave no visible feedback), U3 (title-only composer buttons), U4 (identical if/else branches).
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const src = (f: string) => readFileSync(`${process.cwd()}/${f}`, 'utf8');

describe('D1 rail is in its final mobile state in the static HTML', () => {
    it('the rail ships with mobile-open, so the <=700px display:none rule never shows an empty page', () => {
        expect(src('index.html')).toMatch(/<nav class="left-rail mobile-open" id="left-rail">/);
        // the class only has effect inside the mobile media query
        const css = src('styles.css');
        const first = css.indexOf('.left-rail.mobile-open');
        expect(css.lastIndexOf('@media (max-width: 700px)', first)).toBeGreaterThan(-1);
    });
    it('toggleRailExpanded has a single branch', () => {
        const s = src('tabs.ts');
        const body = s.slice(s.indexOf('function toggleRailExpanded'), s.indexOf('function closeMobileRail'));
        expect(body.match(/classList\.toggle\('expanded'\)/g)?.length).toBe(1);
    });
});

describe('U3 composer buttons have accessible names', () => {
    it('attach and mic have aria-label; the model button gets one from updateInputModelBtn', () => {
        const html = src('index.html');
        expect(html).toMatch(/id="attach-menu-btn"[^>]*aria-label="Attach"/);
        expect(html).toMatch(/id="agent-mic-btn"[^>]*aria-label="Voice input"/);
        expect(src('settings-ui.ts')).toContain("btn.setAttribute('aria-label'");
    });
});

describe('D2 failed voice attempts are visible', () => {
    beforeAll(async () => { await import('../voice.ts'); });
    afterEach(() => { document.body.innerHTML = ''; localStorage.clear(); vi.restoreAllMocks(); });
    const flush = () => new Promise(r => setTimeout(r, 0));

    it('a missing microphone shows a status notice', async () => {
        localStorage.setItem('fg_voice_stt_list', JSON.stringify(['groq|whisper-large-v3-turbo']));
        localStorage.setItem('fg_groq_key', 'k');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        (navigator as any).mediaDevices = { getUserMedia: vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'NotFoundError' }); }) };
        await (window as any).toggleVoiceInput();
        const n = document.getElementById('mic-notice');
        expect(n?.getAttribute('role')).toBe('status');
        expect(n?.textContent).toMatch(/No microphone found/);
    });
    it('a denied permission says so', async () => {
        localStorage.setItem('fg_voice_stt_list', JSON.stringify(['groq|whisper-large-v3-turbo']));
        localStorage.setItem('fg_groq_key', 'k');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        (navigator as any).mediaDevices = { getUserMedia: vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); }) };
        await (window as any).toggleVoiceInput();
        expect(document.getElementById('mic-notice')?.textContent).toMatch(/denied/);
    });
    it('no Web Speech and no key: a notice, not a blocking alert', async () => {
        const alertSpy = vi.fn(); (window as any).alert = alertSpy;
        delete (window as any).SpeechRecognition; delete (window as any).webkitSpeechRecognition;
        await (window as any).toggleVoiceInput();
        await flush();
        expect(alertSpy).not.toHaveBeenCalled();
        expect(document.getElementById('mic-notice')?.textContent).toMatch(/Web Speech needs Chrome or Edge|No speech-to-text/);
    });
});

describe('Settings form follows another tab (codex 243/244/248/253)', () => {
    const fire = async (key: string) => {
        window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
        await new Promise(r => setTimeout(r, 300));
    };
    beforeAll(async () => { (window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} }); await import('../settings-ui.ts'); for (const n of ['renderSkillsChecklist', 'renderToolsChecklist', 'renderMediaModelSelectors', 'renderWorkerModelSelector', 'renderUtilityModelSelector']) (window as any)[n] ??= () => {}; });
    afterEach(() => { document.body.innerHTML = ''; localStorage.clear(); });

    it('re-populates a visible form when another tab changed a setting', async () => {
        document.body.innerHTML = '<div id="tab-content"><div data-panel="settings" class="tab-panel active"><input id="rate-limit-cooldown-min" type="number"></div></div>';
        localStorage.setItem('fg_rate_limit_cooldown_min', '7');
        await fire('fg_rate_limit_cooldown_min');
        expect((document.getElementById('rate-limit-cooldown-min') as HTMLInputElement).value).toBe('7');
    });
    it('leaves a text field alone while it has focus, and ignores a hidden form', async () => {
        document.body.innerHTML = '<div id="tab-content"><div data-panel="settings" class="tab-panel active"><input id="rate-limit-cooldown-min" type="number"></div></div>';
        const el = document.getElementById('rate-limit-cooldown-min') as HTMLInputElement;
        el.value = '3'; el.focus();
        localStorage.setItem('fg_rate_limit_cooldown_min', '7');
        await fire('fg_rate_limit_cooldown_min');
        expect(el.value).toBe('3');
        el.blur();
        document.querySelector('[data-panel="settings"]')!.classList.remove('active');
        await fire('fg_rate_limit_cooldown_min');
        expect(el.value).toBe('3');
    });
});

describe('mobile rail leaves its overlay on navigation (opencode §51)', () => {
    it('activateTab collapses the expanded rail at phone width only', async () => {
        const W: any = window;
        await import('../tabs.ts');
        document.body.innerHTML = '<nav id="left-rail" class="left-rail mobile-open expanded"></nav><div id="tab-content"><div class="tab-panel" data-panel="chats"></div></div>';
        W.renderChatsDropdown = () => {};
        const orig = window.innerWidth;
        Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
        W.activateTab('chats');
        expect(document.getElementById('left-rail')!.classList.contains('expanded')).toBe(false);
        document.getElementById('left-rail')!.classList.add('expanded');
        Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
        W.activateTab('chats');
        expect(document.getElementById('left-rail')!.classList.contains('expanded')).toBe(true);
        Object.defineProperty(window, 'innerWidth', { value: orig, configurable: true });
    });
});
