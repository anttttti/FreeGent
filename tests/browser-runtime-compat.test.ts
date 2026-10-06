import { verifyArtifact } from '../shiro/wasi-packages';
import { createUtilModule } from '../shiro/node-compat/modules/util';
import { sha256sum } from '../shiro/commands/hashsum';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const W:any=window;
afterEach(()=>vi.unstubAllGlobals());

describe('browser runtime capabilities',()=>{
    it('does not advertise bash when BigInt or Workers are missing',()=>{
        localStorage.setItem('fg_sandbox_provider','wasm');
        vi.stubGlobal('BigInt',undefined);
        expect(W.browserBashAvailable()).toBe(false);
        const spec=W.activeTools(true,new Set(['execute_code'])).find((s:any)=>s.name==='execute_code');
        expect(spec.parameters.properties.language.enum).not.toContain('bash');
        expect(spec.parameters.properties.language.enum).toContain('javascript');
        expect(W._buildLangsDesc()).not.toContain('**bash**');
    });
    it('handles ordinary ArrayBuffers without SharedArrayBuffer',()=>{
        vi.stubGlobal('SharedArrayBuffer',undefined);
        const types=createUtilModule().types;
        expect(types.isAnyArrayBuffer(new ArrayBuffer(4))).toBe(true);
        expect(types.isAnyArrayBuffer({})).toBe(false);
    });
    it('checks artifact integrity without Web Crypto on HTTP LAN/opaque origins',async()=>{
        vi.stubGlobal('crypto',{});
        const raw=Uint8Array.from([97,98,99]).buffer;
        const pin={length:3,sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'};
        await expect(verifyArtifact(raw,pin)).resolves.toBeUndefined();
        await expect(verifyArtifact(Uint8Array.from([97,98,100]).buffer,pin)).rejects.toThrow(/hash|SHA-256|digest/i);
    });
    it('computes sha256sum without Web Crypto',async()=>{
        vi.stubGlobal('crypto',{});
        const ctx:any={args:[],stdin:'abc',stdout:'',stderr:'',fs:{},cwd:'/'};
        expect(await sha256sum.exec(ctx)).toBe(0);
        expect(ctx.stdout).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n');
    });
});
describe('chat scroll layout',()=>{
    it('keeps message/checkpoint heights while the list scrolls',()=>{
        const style=document.createElement('style');style.textContent=readFileSync(resolve(__dirname,'../styles.css'),'utf8');document.head.appendChild(style);
        document.body.innerHTML='<div id="agent-messages"><div class="agent-msg agent-msg-user"><div class="agent-msg-bubble">A long message</div></div><div class="checkpoint-row">checkpoint</div></div>';
        try {
            const list=document.getElementById('agent-messages')!;
            expect(getComputedStyle(list).minHeight).toBe('0');
            expect(getComputedStyle(list).overflowY).toBe('auto');
            for(const row of Array.from(list.children))expect(getComputedStyle(row).flexShrink).toBe('0');
        } finally {style.remove();}
    });
});

describe('clipboard compatibility',()=>{
    let saved:any;
    beforeEach(()=>{saved=document.execCommand;Object.defineProperty(document,'execCommand',{configurable:true,value:vi.fn(()=>true),writable:true});});
    afterEach(()=>{if(saved)document.execCommand=saved;else delete (document as any).execCommand;});
    it('copies synchronously when Clipboard API is missing and restores focus',async()=>{
        vi.stubGlobal('navigator',{});
        document.body.innerHTML='<button id="focus">Copy</button>';const button=document.getElementById('focus')!;button.focus();
        const copied=W.copyChatText('copy this');
        expect(document.execCommand).toHaveBeenCalledWith('copy');await copied;
        expect(document.activeElement).toBe(button);
        expect(document.querySelector('textarea')).toBeNull();
    });
    it('falls back when the native clipboard write is denied',async()=>{
        vi.stubGlobal('navigator',{clipboard:{writeText:vi.fn(async()=>{throw new Error('NotAllowedError');})}});
        await W.copyChatText('copy this');expect(document.execCommand).toHaveBeenCalledWith('copy');
    });
    it('reports refusal rather than claiming a successful copy',async()=>{
        vi.stubGlobal('navigator',{});(document.execCommand as any).mockReturnValue(false);
        await expect(W.copyChatText('copy this')).rejects.toThrow('refused');
        expect(document.querySelector('textarea')).toBeNull();
    });
});
