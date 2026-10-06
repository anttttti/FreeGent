import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../convo-log.ts';

describe('redactSecrets', () => {
    it('removes API keys, bearer tokens and stored key values but keeps the rest', () => {
        // Built from parts so the file holds no secret-shaped literal (deploy.sh scans for those).
        const sk = 'sk' + '-or-v1-' + 'abcdef0123456789abcd', bearer = 'abcdefghijklmnop' + '12345', aiza = 'AI' + 'zaSyA1234567890123456789012345678901';
        const t = `key ${sk} and Authorization: Bearer ${bearer} and ${aiza} and mine-secret-value ok`;
        const out = redactSecrets(t, ['mine-secret-value']);
        expect(out).not.toMatch(/abcdef0123456789abcd|abcdefghijklmnop12345|zaSyA|mine-secret/);
        expect(out).toContain('Bearer [redacted]');
        expect(out).toContain(' ok');
    });
});
