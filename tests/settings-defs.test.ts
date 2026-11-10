import { describe, it, expect } from 'vitest';
import { SETTINGS, rangeOf } from '../settings-defs.ts';
import { KEYS } from '../storage-keys.ts';
import { SETTINGS_DEF, keyedFields } from '../panel-defs.ts';
import { samplingRangeError } from '../config.ts';
import { readFileSync } from 'node:fs';

// A setting's label, section and range are written once (settings-defs.ts); the other places read them.
describe('settings table', () => {
    it('every setting is also in the storage-key registry', () => {
        const registered = new Set(Object.values(KEYS));
        expect(Object.keys(SETTINGS).filter(k => !registered.has(k))).toEqual([]);
    });
    it('the TUI panel takes its ranges from the table (fg_top_k used to have three)', () => {
        for (const f of keyedFields(SETTINGS_DEF)) {
            if (f.kind !== 'number' || !(f.key in SETTINGS)) continue;
            const r = rangeOf(f.key);
            if (r.min != null) expect(f.min, f.key).toBe(r.min);
            if (r.max != null) expect(f.max, f.key).toBe(r.max);
        }
        expect(rangeOf('fg_top_k')).toMatchObject({ min: -1, max: 1_000_000 });
    });
    it('config validates a sampling value against the same range', () => {
        expect(samplingRangeError('fg_top_k', '-1')).toBeNull();
        expect(samplingRangeError('fg_top_k', '2000000')).toMatch(/between -1 and 1000000/);
        expect(samplingRangeError('fg_temperature', '3')).toMatch(/between 0 and 2/);
        expect(samplingRangeError('fg_top_k', '1.5')).toMatch(/whole number/);
    });
    it('the WebUI sampling inputs declare no range of their own', () => {
        const html = readFileSync(`${process.cwd()}/index.html`, 'utf8');
        for (const id of ['smp-temperature', 'smp-top-p', 'smp-top-k', 'smp-min-p', 'smp-presence-penalty', 'smp-repetition-penalty'])
            expect(new RegExp(`id="${id}"[^>]*\\b(min|max)=`).test(html), id).toBe(false);
    });
});

describe('storage-key registry', () => {
    it('lists every fg_ key a source file names (a key used only as a raw string was a second list to keep in step)', async () => {
        const { execFileSync } = await import('node:child_process');
        const out = execFileSync('git', ['grep', '-h', '-o', '-E', `['"]fg_[a-z0-9_]+['"]`, '--', '*.ts', '*.tsx', 'index.html', ':!tests', ':!storage-keys.ts'], { cwd: process.cwd(), encoding: 'utf8' });
        const used = new Set(out.split('\n').map(l => l.replace(/['"]/g, '')).filter(Boolean));
        const registered = new Set(Object.values(KEYS));
        // Prefixes of keys built by a function, and keys that older versions wrote and the code only removes or moves.
        const allowed = new Set(['fg_chat_', 'fg_draft_', 'fg_pass', 'fg_zro_key', 'fg_apinex_key']);
        expect([...used].filter(k => !registered.has(k) && !allowed.has(k))).toEqual([]);
    });
});

describe('labels', () => {
    it('the TUI panel and the profile table word a setting the same way', () => {
        for (const f of keyedFields(SETTINGS_DEF)) if ('label' in f && f.key in SETTINGS) expect(f.label, f.key).toBe(SETTINGS[f.key].label);
    });
});
