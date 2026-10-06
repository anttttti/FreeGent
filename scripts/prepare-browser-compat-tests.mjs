// Prebuild the trusted sandbox fixtures outside JSDOM (esbuild needs one JS realm).
// This also lets restricted test processes use freshly built code without spawning.
import { buildExecSandbox } from '../dev-api.ts';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const directory=resolve(process.argv[2] || 'tmp/browser-compat-tests');
mkdirSync(directory,{recursive:true});
const sandbox=resolve(directory,'sandbox.js'), worker=resolve(directory,'wasi-worker.js');
writeFileSync(sandbox,await buildExecSandbox(process.cwd()));
const built=await build({entryPoints:['shiro/wasi-worker.ts'],bundle:true,format:'iife',platform:'browser',target:'es2019',supported:{bigint:true,'regexp-lookbehind-assertions':false},write:false});
writeFileSync(worker,built.outputFiles[0].text);
console.log(JSON.stringify({sandboxBundle:sandbox,wasiWorkerBundle:worker}));
