// SessionPersistence clips a long string field and keeps the rest of the event: an unrelated key named __proto__ must stay too (explorations W012:
// the clipped copy was built with `out[k] = …`, which set the prototype for that key and dropped it from the file).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPersistence } from '../session-persistence.ts';

describe('SessionPersistence clipping', () => {
    it('keeps a __proto__ key of the event when another field is clipped', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'sp-'));
        const sp = new SessionPersistence(dir, 10, { maxFieldChars: 20 });
        const data = JSON.parse('{"text": "' + 'x'.repeat(100) + '", "__proto__": {"keep": "me"}, "n": 1}');   // JSON.parse makes it an own property
        sp.enqueue('s1', { type: 'tool/result', seq: 1, time: 1, data } as any);
        await sp.flush();
        const file = readdirSync(dir).find(f => f.includes('s1')) ?? readdirSync(dir)[0];
        const line = JSON.parse(readFileSync(join(dir, file), 'utf8').trim().split('\n')[0]);
        expect(line.truncated).toBe(true);
        expect(line.data.text).toMatch(/more chars not logged/);
        expect(Object.prototype.hasOwnProperty.call(line.data, '__proto__')).toBe(true);
        expect(JSON.parse(JSON.stringify(line.data)).n).toBe(1);
    });
});
