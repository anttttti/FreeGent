import { describe, it, expect, afterEach } from 'vitest';
import { runtime } from '../runtime.js';

const g: any = globalThis;
afterEach(() => { delete g.nativeExec; });

describe('runtime capabilities', () => {
    it('is a browser runtime until nativeExec is installed, and reads the global at call time', async () => {
        expect(runtime.hasNativeExec).toBe(false);
        expect(runtime.headless).toBe(false);
        expect(runtime.hasBrowserUi).toBe(true);
        g.nativeExec = async (lang: string, code: string) => ({ lang, code });
        expect(runtime.hasNativeExec).toBe(true);
        expect(runtime.headless).toBe(true);
        expect(runtime.hasBrowserUi).toBe(false);
        expect(await runtime.nativeExec('bash', 'echo hi')).toEqual({ lang: 'bash', code: 'echo hi' });
    });
});
