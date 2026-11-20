// The browser shell's npm/npx version ranges follow node-semver (explorations Y002): comparison sets, ||, hyphen and partial versions, and the prerelease rule.
// The expected answers are node-semver 7.3.5's own for each (range, version).
import { describe, it, expect } from 'vitest';
import { satisfiesRange, maxSatisfying } from '../shiro/utils/semver-utils';

const table: [string, Record<string, boolean>][] = [
    ['>=1.2.3 <2.0.0', { '1.2.3': true, '1.9.9': true, '2.0.0': false, '1.2.2': false }],
    ['>= 1.2.3 < 2.0.0', { '1.9.9': true, '2.0.0': false }],
    ['1.2', { '1.2.4': true, '1.9.9': false, '1.3.0': false }],
    ['^1.2.3', { '1.2.3': true, '1.3.0-beta.1': false, '1.3.0': true, '2.0.0-rc.1': false }],
    ['>=1.2.3-alpha.2', { '1.2.3-alpha.2': true, '1.2.3-alpha.10': true, '1.2.3-alpha.beta': true, '1.2.3': true, '1.2.4-beta.1': false }],
    ['>=1.2.3 <2.0.0 || >=3.0.0', { '1.5.0': true, '2.5.0': false, '3.0.0': true }],
    ['1.2.3 - 2.3', { '1.2.3': true, '2.3.9': true, '2.4.0': false }],
    ['^0.2.3', { '0.2.9': true, '0.3.0': false }],
    ['^0.0.3', { '0.0.3': true, '0.0.4': false }],
    ['~1.2', { '1.2.9': true, '1.3.0': false }],
    ['1.x || 3.x', { '1.9.9': true, '2.0.0': false, '3.1.0': true }],
    ['*', { '0.0.1': true, '1.0.0-beta': false }],
];

describe('satisfiesRange', () => {
    it('answers as node-semver does', () => {
        for (const [range, versions] of table) for (const [version, want] of Object.entries(versions)) expect(satisfiesRange(version, range), `${version} in ${range}`).toBe(want);
    });
    it('maxSatisfying picks the highest, ordering prerelease identifiers as semver does', () => {
        const list = ['1.2.3', '1.2.4-beta.1', '1.2.4-alpha.10', '1.2.4-alpha.2', '1.9.9', '2.0.0'];
        expect(maxSatisfying(list, '>=1.2.3 <2.0.0')).toBe('1.9.9');
        expect(maxSatisfying(['1.2.4-alpha.10', '1.2.4-alpha.2'], '>=1.2.4-alpha.1')).toBe('1.2.4-alpha.10');
        expect(maxSatisfying(list, '<1.2.0')).toBeNull();
    });
});
