// codex R359: a profile named __proto__ was "saved" into the prototype slot and vanished.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

const W = window as any;
beforeAll(async () => { await import('../profiles.ts'); });
afterEach(() => { localStorage.clear(); document.body.innerHTML = ''; });

describe('profile names', () => {
    it('a profile named __proto__ is stored and listed like any other', () => {
        W.alert = () => {};
        document.body.innerHTML = '<input id="profile-name-input" value="__proto__">';
        W.profileSaveCurrent();
        const saved = W.getSavedProfiles();
        expect(Object.keys(saved)).toEqual(['__proto__']);
        expect(JSON.parse(localStorage.getItem('fg_profiles')!)).toHaveProperty('__proto__');
        expect(Object.keys(W.getSavedProfiles())).toEqual(['__proto__']);   // and it survives a reload
    });
});
