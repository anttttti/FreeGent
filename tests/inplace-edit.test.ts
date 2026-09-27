// execute_code in-place edit verification (tools.ts): `sed -i` that matches nothing still
// rewrites the file, so it looked "written". SWE-bench v0.55 astropy-12907 and the Cowork game
// chat of 2026-09-27 both built on edits that never happened.
import { describe, it, expect, afterEach } from 'vitest';
import { _inPlaceTargets, _readInPlaceTargets, _annotateUnchangedInPlace } from '../tools.ts';
import { setWorkspaceAdapter } from '../workspace.ts';

describe('_inPlaceTargets', () => {
    it('finds the file operand of the astropy sed command', () => {
        const code = String.raw`sed -i 's/cright[-right.shape\[0\]:,-right.shape\[1\]:] = 1/cright[-right.shape[0]:, -right.shape[1]:] = right/' astropy/modeling/separable.py`;
        expect(_inPlaceTargets(code)).toEqual(['astropy/modeling/separable.py']);
    });
    it('handles perl -pi, -i.bak, /workspace paths and chained commands', () => {
        expect(_inPlaceTargets(`perl -pi -e 's/a/b/' src/x.js && echo ok`)).toEqual(['src/x.js']);
        expect(_inPlaceTargets(`sed -i.bak "s/foo/bar/g" /workspace/game.js; grep bar /workspace/game.js`)).toEqual(['/workspace/game.js']);
    });
    it('ignores commands that do not edit in place', () => {
        expect(_inPlaceTargets(`sed -n '1518p' game.js`)).toEqual([]);
        expect(_inPlaceTargets(`grep -i highScore game.js`)).toEqual([]);
    });
});

describe('_annotateUnchangedInPlace', () => {
    const files = new Map<string, string>();
    afterEach(() => { setWorkspaceAdapter(null); files.clear(); });
    const useFakeWorkspace = () => setWorkspaceAdapter({
        agentListFiles: async () => [...files.keys()].map(name => ({ name })),
        agentReadFile: async (p: string) => { if (!files.has(p)) throw new Error('not found'); return files.get(p)!; },
        agentWriteFile: async (p: string, c: string) => { files.set(p, c); },
        agentDeleteFile: async (p: string) => { files.delete(p); },
    });

    it('drops an unchanged file from files_written and says the fix is not applied', async () => {
        useFakeWorkspace();
        files.set('game.js', "getElementById('highScore')");
        const before = await _readInPlaceTargets(['/workspace/game.js']);   // WASM mount path → game.js
        // sed ran, matched nothing: content identical
        const out = await _annotateUnchangedInPlace({ stdout: '', stderr: '', exit_code: 0, files_written: ['game.js'] }, before);
        expect(out.files_written).toBeUndefined();
        expect(out.note).toMatch(/changed nothing: \/workspace\/game\.js/);
        expect(out.note).toMatch(/NOT applied/);
    });

    it('leaves a real edit alone', async () => {
        useFakeWorkspace();
        files.set('game.js', "getElementById('highScore')");
        const before = await _readInPlaceTargets(['game.js']);
        files.set('game.js', "getElementById('high-score')");
        const res = { stdout: '', stderr: '', exit_code: 0, files_written: ['game.js'] };
        expect(await _annotateUnchangedInPlace(res, before)).toBe(res);
    });
});
