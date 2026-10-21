import { describe, it, expect } from 'vitest';
import { syncGuidanceMemory } from '../skill-guidance.js';
import { _reactiveFired } from '../state.js';

// Campaign 8 cases 190-200: guidance already given is remembered per chat and per history, not page-wide.
describe('guidance memory', () => {
    it('keeps what a chat was given, and gives another chat its own set', () => {
        syncGuidanceMemory('A', 0);
        _reactiveFired.add('documents');
        syncGuidanceMemory('A', 2);
        expect(_reactiveFired.has('documents')).toBe(true);
        syncGuidanceMemory('B', 2);                 // B never received it
        expect(_reactiveFired.has('documents')).toBe(false);
        syncGuidanceMemory('A', 2);
        expect(_reactiveFired.has('documents')).toBe(true);
    });
    it('forgets guidance whose turn a rewind removed, keeps earlier guidance', () => {
        syncGuidanceMemory('C', 0);
        _reactiveFired.add('early');
        syncGuidanceMemory('C', 2);                 // turn 2 starts: "early" was given at history length 0
        _reactiveFired.add('late');
        syncGuidanceMemory('C', 4);                 // "late" was given at length 2
        syncGuidanceMemory('C', 2);                 // rewound to before the second turn
        expect(_reactiveFired.has('late')).toBe(false);
        expect(_reactiveFired.has('early')).toBe(true);
        syncGuidanceMemory('C', 0);                 // everything removed
        expect(_reactiveFired.has('early')).toBe(false);
    });
    it('forgets guidance when the chat history is replaced by another of equal length (cases 229/234)', () => {
        const h1 = [{ role: 'user', content: 'first conversation' }, { role: 'assistant', content: 'reply one' }];
        syncGuidanceMemory('D', 0, []);
        _reactiveFired.add('documents');
        syncGuidanceMemory('D', 2, h1);
        h1.push({ role: 'user', content: 'next' }, { role: 'assistant', content: 'ok' });
        syncGuidanceMemory('D', 4, h1);              // an ordinary longer history keeps what it was given
        expect(_reactiveFired.has('documents')).toBe(true);
        const other = [{ role: 'user', content: 'a different conversation' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }, { role: 'assistant', content: 'z' }];
        syncGuidanceMemory('D', 4, other);           // same chat id, same length, other messages
        expect(_reactiveFired.has('documents')).toBe(false);
    });
});
