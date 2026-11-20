// util.promisify / callbackify keep the receiver the caller gives them (explorations U002), as Node's do.
import { describe, it, expect } from 'vitest';
import nodeUtil from 'node:util';
import { createUtilModule } from '../shiro/node-compat/modules/util';

const shim = createUtilModule();
describe('promisify and callbackify forward the receiver', () => {
    for (const [name, u] of [['shim', shim], ['node', nodeUtil]] as const) it(`${name}: a method promisified keeps its object, with .call and as a property`, async () => {
        const obj: any = { tag: 'T', read(this: any, cb: Function) { cb(null, this.tag); } };
        obj.readAsync = u.promisify(obj.read);
        expect(await obj.readAsync()).toBe('T');
        expect(await u.promisify(obj.read).call({ tag: 'other' })).toBe('other');
        const cbObj: any = { tag: 'C', async load(this: any) { return this.tag; } };
        cbObj.loadCb = u.callbackify(cbObj.load);
        expect(await new Promise(r => cbObj.loadCb((_e: any, v: any) => r(v)))).toBe('C');
    });
});
