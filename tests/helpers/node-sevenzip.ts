// Node cannot import an HTTPS ESM URL. Load the same fixed public build as the browser.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {verifyArtifact} from '../../shiro/wasi-packages';
import {SEVENZIP_ASSET_PINS} from '../../shiro/wasi-artifact-pins';
export async function loadNodeSevenZip(fetchImpl:typeof fetch) {
  const assets=[SEVENZIP_ASSET_PINS['7zz.umd.js'],SEVENZIP_ASSET_PINS['7zz.wasm']];
  const [loader,wasm]=await Promise.all(assets.map(async pin=>{
    const response=await fetchImpl(pin.url);
    if (!response.ok) throw new Error(`7-Zip reference runtime HTTP ${response.status}`);
    const bytes=await response.arrayBuffer();
    await verifyArtifact(bytes,pin);
    return new Uint8Array(bytes);
  }));
  const directory=await mkdtemp(join(tmpdir(),'fg-sevenzip-'));
  try {
    const filename=join(directory,'7zz.cjs');
    await writeFile(filename,loader);
    const factory = createRequire(import.meta.url)(filename);
    return {factory,wasmBinary:wasm};
  } finally {await rm(directory,{recursive:true,force:true});}
}
