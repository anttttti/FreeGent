/** Inspect immutable artifacts with upstream webc, then generate runtime slice metadata.
 * Usage: npx tsx scripts/wasi-artifacts/generate.mjs /tmp/reviewed-pins.ts
 */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listAvailable } from '../../shiro/wasi-packages.ts';
import { ARTIFACT_PINS } from '../../shiro/wasi-artifact-pins.ts';
import { createHash } from 'node:crypto';

const output = process.argv[2];
if (!output) throw new Error('Supply a separate output file; review generated pins before adoption.');
const scratch = await mkdtemp(join(tmpdir(),'fg-webc-'));
try {
  const build = spawnSync('cargo',['+stable','build','--release','--locked','--manifest-path','scripts/wasi-artifacts/Cargo.toml','--target-dir',join(scratch,'target')],{stdio:'inherit'});
  if (build.status !== 0) throw new Error('Upstream WebC inspector build failed');
  const pins = {};
  for (const pkg of listAvailable()) {
    const response = pkg.url.startsWith('/shiro/wasm/') ? new Response(await readFile(resolve('public'+pkg.url))) : await fetch(pkg.url);
    if (!response.ok) throw new Error(`${pkg.name}: HTTP ${response.status}`);
    const path = join(scratch,pkg.name + '.webc');
    const raw = new Uint8Array(await response.arrayBuffer());
    if (pkg.format === 'wasm') {
      const hash = createHash('sha256').update(raw).digest('hex');
      if (hash !== ARTIFACT_PINS[pkg.name].sha256) throw new Error(`${pkg.name}: published bytes changed; review source, build, entrypoint and new integrity pin before adoption`);
      pins[pkg.name] = ARTIFACT_PINS[pkg.name];
      continue;
    }
    await writeFile(path,raw);
    const inspect = spawnSync(join(scratch,'target/release/freegent-webc-inspect'),[path],{encoding:'utf8',maxBuffer:32 * 1024 * 1024});
    if (inspect.status !== 0) throw new Error(`${pkg.name}: ${inspect.stderr}`);
    const data = JSON.parse(inspect.stdout);
    const resources = {};
    for (const mapping of data.manifest.package?.fs ?? []) {
      if (mapping.from) throw new Error(`${pkg.name}: external volume dependency requires review`);
      const prefix = (mapping.original_path ?? '/').replace(/\/$/,'') + '/';
      const mount = mapping.mount_path.replace(/\/$/,'');
      for (const [path,slice] of Object.entries(data.volumes[mapping.volume_name])) {
        if (path.startsWith(prefix)) resources[mount + '/' + path.slice(prefix.length)] = slice;
      }
    }
    for (const [path,slice] of Object.entries(data.volumes.metadata ?? {})) resources['/usr/share/doc/shiro/' + pkg.name + path] = slice;
    const commands = Object.fromEntries(Object.entries(data.manifest.commands ?? {}).map(([name,cmd]) => [name,cmd.annotations.atom?.name ?? cmd.annotations.wasi?.atom]));
    pins[pkg.name] = {sha256:data.sha256,length:data.length,atoms:data.atoms,commands,resources,upstream:data.manifest.package?.wapm ?? {}};
    process.stderr.write(`${pkg.name}: ${Object.keys(data.atoms).length} atoms, ${Object.keys(resources).length} resources\n`);
  }
  // Preserve the type declarations; regenerate only the data, in manifest order.
  const source = await readFile('shiro/wasi-artifact-pins.ts','utf8');
  const prefix = source.slice(0,source.indexOf(' = {') + 3);
  const runtimeAssets = source.indexOf('\n// Emscripten loader code');
  const suffix = runtimeAssets < 0 ? '' : source.slice(runtimeAssets);
  await writeFile(resolve(output),prefix + JSON.stringify(pins,null,2) + ';\n' + suffix);
} finally { await rm(scratch,{recursive:true,force:true}); }
