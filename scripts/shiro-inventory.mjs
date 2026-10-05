/** Generate route and import evidence from the live owners, without executing commands.
 * npx tsx scripts/shiro-inventory.mjs --update-note | --check | --help
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const root = resolve(import.meta.dirname,'..');
const usage = `Usage: npx tsx scripts/shiro-inventory.mjs --update-note | --check | --help
  --update-note  Write the current note and all generated inventory artifacts.
  --check        Compare the note and artifacts without writing; fail on drift.
  --help         Show this help without generating or writing files.
  --output-dir   Override the artifact directory (default: docs/shiro).
`;
let options;
try {
  options = parseArgs({options:{'update-note':{type:'boolean'},check:{type:'boolean'},help:{type:'boolean'},'output-dir':{type:'string'}},strict:true,allowPositionals:false}).values;
  if ([options['update-note'],options.check,options.help].filter(Boolean).length !== 1) throw new Error('Choose exactly one of --update-note, --check or --help.');
} catch (error) {
  console.error(error.message + '\n' + usage);
  process.exit(2);
}
if (options.help) { console.log(usage); process.exit(0); }
const output = resolve(root,options['output-dir'] ?? 'docs/shiro');
const generated = new Map();
(globalThis).window = {parent:{postMessage(){throw new Error('Unexpected workspace RPC during inventory');}},addEventListener(){}};
const { COMMAND_CATALOG } = await import('../shiro/commands/index');
const { listAvailable, resolvePackageCommand } = await import('../shiro/wasi-packages');
const { ARTIFACT_PINS } = await import('../shiro/wasi-artifact-pins');
const { SHELL_BUILTINS, SHELL_KEYWORDS } = await import('../shiro/shell');

const sources = new Map();
async function collect(directory, recursive) {
  for (const entry of await readdir(resolve(root,directory),{withFileTypes:true})) {
    const path = directory ? directory + '/' + entry.name : entry.name;
    if (entry.isDirectory()) { if (recursive && !entry.name.startsWith('.')) await collect(path,true); }
    else if (/\.(ts|js|mjs)$/.test(entry.name)) sources.set(path,await readFile(resolve(root,path),'utf8'));
  }
}
await collect('',false); await collect('shiro',true); await collect('exec-sandbox',true);
const declarations = new Map();
const edges = new Map();
const symbols = new Map();
const importTarget = (path,specifier) => {
  const base = relative(root,resolve(root,dirname(path),specifier));
  const withoutExtension = extname(base) ? base.slice(0,-extname(base).length) : base;
  return [base,withoutExtension+'.ts',withoutExtension+'.js',base+'/index.ts'].find(p=>sources.has(p));
};
for (const [path,source] of sources) {
  const file = ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
  const bindings = new Map();
  symbols.set(path,bindings);
  const imports = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text,{expression:node.initializer});
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const target = importTarget(path,node.moduleSpecifier.text);
      const names = node.importClause?.namedBindings;
      if (target && names && ts.isNamedImports(names)) for (const item of names.elements) {
        bindings.set(item.name.text,{path:target,name:item.propertyName?.text ?? item.name.text});
      }
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'name' && ts.isStringLiteralLike(node.initializer)) {
      const name = node.initializer.text;
      if (path.startsWith('shiro/commands/')) {
        if (!declarations.has(name)) declarations.set(name,new Set());
        declarations.get(name).add(path);
      }
    }
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
      const absolute = resolve(root,dirname(path),specifier.text);
      const base = relative(root,absolute);
      const withoutExtension = extname(base) ? base.slice(0,-extname(base).length) : base;
      const target = [base,withoutExtension + '.ts',withoutExtension + '.js',base + '/index.ts'].find(p=>sources.has(p));
      if (target) imports.add(target);
    }
    ts.forEachChild(node,visit);
  };
  visit(file); edges.set(path,[...imports].sort());
}
// Follow the actual catalog array and its imported arrays/identifiers. Other
// same-named exports are candidate declarations, not registered owners.
const catalogOwners = new Map();
function catalogExpression(path,node,seen=new Set()) {
  if (!node) return;
  if (ts.isIdentifier(node)) {
    const key = path+':'+node.text;
    if (seen.has(key)) return;
    const next = new Set(seen).add(key);
    const binding = symbols.get(path)?.get(node.text);
    if (binding?.expression) catalogExpression(path,binding.expression,next);
    else if (binding?.path) catalogExpression(binding.path,ts.factory.createIdentifier(binding.name),next);
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const item of node.elements) catalogExpression(path,item,seen);
  } else if (ts.isSpreadElement(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    catalogExpression(path,node.expression,seen);
  } else if (ts.isObjectLiteralExpression(node)) {
    const name = node.properties.find(item=>ts.isPropertyAssignment(item) && item.name.getText()==='name');
    if (name && ts.isStringLiteralLike(name.initializer)) catalogOwners.set(name.initializer.text,path);
  } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['packageCommand','packageFamilyCommand'].includes(node.expression.text)) {
    const name = node.arguments[0];
    if (name && ts.isStringLiteralLike(name)) catalogOwners.set(name.text,path);
  }
}
catalogExpression('shiro/commands/index.ts',ts.factory.createIdentifier('COMMAND_CATALOG'));
const entrypoints = ['shiro/shell-singleton.ts','exec-sandbox/entry.ts','pyodide-run.ts','headless-runner.ts'];
const reachable = new Set();
const queue = [...entrypoints];
for (let index = 0; index < queue.length; index++) {
  const path = queue[index]; if (reachable.has(path)) continue;
  reachable.add(path); queue.push(...(edges.get(path) ?? []));
}
const parserNames = new Set();
for (const match of sources.get('shiro/shell.ts').matchAll(/(?:effectiveCmdName|cmdName)\s*===\s*'([^']+)'/g)) {
  if (!match[1].includes('/')) parserNames.add(match[1]);
}
const commands = new Map();
for (const command of COMMAND_CATALOG) {
  if (commands.has(command.name)) throw new Error('Duplicate command: ' + command.name);
  commands.set(command.name,{name:command.name,route:command.route ?? 'typescript',description:command.description,
    parityScope:command.parityScope ?? 'bash',requirements:command.requirements ?? []});
}
for (const pkg of listAvailable()) for (const name of [pkg.name,...(pkg.aliases ?? [])]) {
  const mapping = resolvePackageCommand(name);
  const packageRoute = mapping ? {package:mapping.package.name,version:mapping.package.version,atom:mapping.atom,argv0:mapping.argv0,leadingArgs:mapping.leadingArgs,sha256:ARTIFACT_PINS[mapping.package.name].sha256} : {package:pkg.name,status:pkg.family && name === pkg.name ? 'declared subcommand launcher' : 'no executable entrypoint'};
  if (commands.has(name)) commands.get(name).explicitPackageAlternative = packageRoute;
  else commands.set(name,{name,route:mapping ? 'wasm package' : 'package installation only',packageRoute,requirements:['Worker','complete filesystem snapshot','validated imports/assets']});
}
for (const name of [...parserNames,'!','((...))']) {
  const row = commands.get(name) ?? {name};
  if (parserNames.has(name) || name === '!' || name === '((...))') row.route = 'shell parser';
  commands.set(name,row);
}
// bench/ is a separate optional repository. Retain a generated coverage snapshot
// so fresh FreeGent checkouts can check routing documents without that checkout.
let coverageSnapshot;
try {
  const raw = await readFile(resolve(root,'bench/dev-tests/log-replay/cases/coverage-index.json'),'utf8');
  const coverage = JSON.parse(raw);
  coverageSnapshot = {source:'bench/dev-tests/log-replay/cases/coverage-index.json',sha256:createHash('sha256').update(raw).digest('hex'),commands:coverage.commands.map(({name,cases})=>({name,cases}))};
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  coverageSnapshot = JSON.parse(await readFile(resolve(root,'docs/shiro/command-coverage.json'),'utf8'));
}
generated.set(resolve(output,'command-coverage.json'),JSON.stringify(coverageSnapshot,null,2)+'\n');
const caseCommands = new Map(coverageSnapshot.commands.map((c)=>[c.name,c.cases]));
for (const row of commands.values()) {
  row.parityScope ??= 'bash';
  row.declarations = [...(declarations.get(row.name) ?? [])].sort();
  if (row.route === 'shell parser') row.owner = 'shiro/shell.ts';
  else row.owner = catalogOwners.get(row.name) ?? (row.declarations.length === 1 ? row.declarations[0] : 'shiro/commands/index.ts (catalog identity; candidate declarations listed)');
  if (catalogOwners.has(row.name)) row.catalogOwner = catalogOwners.get(row.name);
  row.builtin = SHELL_BUILTINS.includes(row.name);
  row.keyword = SHELL_KEYWORDS.includes(row.name);
  if (row.keyword) {row.route = 'shell grammar'; row.owner = 'shiro/shell.ts';}
  if (row.packageRoute) row.owner = 'shiro/wasi-packages.ts';
  row.cases = caseCommands.get(row.name) ?? [];
  row.migrationAccepted = false; // acceptance is an independent comparison, never inferred from registration
}
const data = {
  schema:2, coverageSha256:coverageSnapshot.sha256, generatorSha256:createHash('sha256').update(await readFile(resolve(root,'scripts/shiro-inventory.mjs'))).digest('hex'), source:'live COMMAND_CATALOG, parser branches, package manifest, integrity pins and static imports',
  commands:[...commands.values()].sort((a,b)=>a.name.localeCompare(b.name)),
  precedence:['grammar','alias expansion','function','enabled builtin','remembered command location','user PATH executable','catalog command','lazy package'],
  managedPackageStubs:'Do not override catalog defaults; explicit absolute stub paths select upstream alternatives.',
  entrypoints,
  modules:[...sources.keys()].filter(p=>p.startsWith('shiro/commands/')).sort().map(path=>({path,reachable:reachable.has(path),imports:edges.get(path),referencedBy:[...edges].filter(([,targets])=>targets.includes(path)).map(([from])=>from).sort()})),
  artifacts:listAvailable().map(pkg=>({name:pkg.name,version:pkg.version,url:pkg.url,format:pkg.format,pin:ARTIFACT_PINS[pkg.name],validation:'integrity/entrypoint metadata; behavioral and source/license acceptance tracked separately'})),
  sourceSha256:Object.fromEntries([...sources].filter(([path])=>path.startsWith('shiro/') || ['exec-sandbox/entry.ts','exec-sandbox/bash-run.ts','exec-sandbox/channel.ts'].includes(path) || entrypoints.includes(path)).sort(([a],[b])=>a.localeCompare(b)).map(([path,source])=>[path,createHash('sha256').update(source).digest('hex')])),
};
const escape = (text) => String(text ?? '').replaceAll('|','\\|').replaceAll('\n',' ');
const lines = ['# Generated Shiro implementation matrix','','Regenerate: `npx tsx scripts/shiro-inventory.mjs --update-note`. Check: `npx tsx scripts/shiro-inventory.mjs --check`. Do not hand edit.','',
  'The matrix includes the generator hash and separately versioned coverage snapshot hash. Registration describes availability. Acceptance requires independent byte comparisons. Static reachability alone does not authorize deleting a file.','',
  '| Command | Default owner / route | Parity scope | Explicit package alternative | Native inputs |', '|---|---|---|---|---:|'];
for (const row of data.commands) {
  const pkg = row.packageRoute ?? row.explicitPackageAlternative;
  const artifact = pkg ? `${pkg.package}@${pkg.version ?? ''}: ${pkg.atom ?? pkg.status}; argv ${JSON.stringify([pkg.argv0,...(pkg.leadingArgs ?? [])])}` : '';
  lines.push(`| \`${escape(row.name)}\` | ${escape(row.route)}; ${escape(row.owner)} | ${row.parityScope} | ${escape(artifact)} | ${row.cases.length} |`);
}
lines.push('','## Command files outside the recorded execution import closure','','These files require checking other entrypoints and dynamic consumers before deletion.','');
for (const module of data.modules.filter(m=>!m.reachable)) lines.push(`- \`${module.path}\`: static callers ${module.referencedBy.join(', ') || 'none found'}.`);
lines.push('','## Artifact identities','','| Package | Version | Bytes | SHA-256 | Named atoms | Resources |','|---|---|---:|---|---|---:|');
for (const artifact of data.artifacts) lines.push(`| ${artifact.name} | ${artifact.version} | ${artifact.pin.length} | ${artifact.pin.sha256} | ${Object.keys(artifact.pin.atoms).join(', ')} | ${Object.keys(artifact.pin.resources).length} |`);
generated.set(resolve(output,'command-matrix.json'),JSON.stringify(data,null,2) + '\n');
generated.set(resolve(output,'command-matrix.md'),lines.join('\n') + '\n');
const commonCandidates = 'chgrp chroot mkfifo mknod syncfs install-info ldconfig ldd readelf objdump strip ar as ld systemctl service journalctl dmesg modprobe lsmod mount umount swapon swapoff sudo su passwd useradd userdel groupadd groups who w last login ssh scp sftp rsync telnet ftp ping traceroute ip ifconfig ss netstat lsof nc netcat tcpdump git svn hg docker podman kubectl crontab at watchdog ps man vi nano ed top pgrep pkill tput stty cc gcc ffmpeg magick psql'.split(' ');
const absent = commonCandidates.filter(name=>!commands.has(name));
const inventory = ['# Current Shiro command inventory','',
  'Generated from the working tree by `npx tsx scripts/shiro-inventory.mjs --update-note`. Regenerate after routing changes. The machine-readable command matrix retains source hashes and candidate declarations. `command-coverage.json` retains a generated snapshot from the separately versioned benchmark repository; when that checkout is present, `--check` also detects coverage drift.','',
  `${data.commands.length} command names; ${data.modules.length} command modules; ${data.artifacts.length} WASI artifact identities. Availability does not establish complete flag compatibility or migration acceptance.`,
  '', '## Registration and lookup','',
  '`shell-singleton.ts` registers `COMMAND_CATALOG` once. The catalog declares one owner per name; `CommandRegistry` rejects duplicates. Registration order does not replace previous owners.',
  '', 'Lookup precedence: '+data.precedence.join(' → ')+'. Shell grammar and enabled builtin handling remain owned by `shell.ts`. A user PATH executable may override a catalog external command. Managed alternative package stubs do not override its catalog default; their explicit paths remain callable.',
  '', '`hash` remembers external command locations and participates in lookup. PATH assignments invalidate remembered locations; discovery does not download lazy packages.',
  '', 'Lookup regression evidence: [shell precedence and hash tests](../../tests/shiro-shell-commands.test.ts) and [lazy packages and managed-stub tests](../../tests/shiro-wasm-packages.test.ts).',
  '', '## Names grouped by current default route','', '| Route | Support scope | Names |','|---|---|---|'];
for (const group of [...new Set(data.commands.map(row=>row.route+';'+row.parityScope))].sort()) {
  const [route,scope] = group.split(';');
  inventory.push(`| ${route} | ${scope} | ${data.commands.filter(row=>row.route===route && row.parityScope===scope).map(row=>'`'+escape(row.name)+'`').join(', ')} |`);
}
inventory.push('', '## Current routing checks','',
  '| Name | Catalog/parser owner | Default route |','|---|---|---|');
for (const name of ['grep','sed','hexdump','rev','cal','bc','dc','jq','zstd','unzstd','zstdcat','util-linux','wabt','which','alias','read','let','getopts','time']) {
  const row = commands.get(name);
  inventory.push(`| \`${name}\` | ${escape(row?.owner ?? 'absent')} | ${escape(row?.route ?? 'absent')} |`);
}
inventory.push('', 'bc, dc, jq and zstd declarations are thin adapters selecting the upstream WASI CLI. Their `.ts` filenames do not indicate local language/codec engines. `util-linux` and `wabt` are registered family launchers. Each declared entrypoint resolves independently to its selected package; catalog bindings determine the default command owner.',
  '', '## WASI manifest packages','',
  'Artifact identities count distinct manifest package/version/pin cache keys, including explicitly installable alternatives. Aliases and family entrypoints do not add artifacts. `util-linux` retains its legacy installable WebC artifact; its family launcher dispatches hexdump, cal and rev to their standalone pinned artifacts. bc and dc are separately compiled programs. An alternative artifact listed here is not necessarily the default owner.',
  '', '| Package artifact | Version | Declared aliases | Default owner / route |','|---|---|---|---|');
for (const pkg of listAvailable()) {
  const names = [...new Set([pkg.name,...(pkg.aliases ?? []),...(pkg.entrypoints ?? [])])];
  const owners = names.map(name=>{
    const row = commands.get(name), mapping = resolvePackageCommand(name);
    const selected = mapping ? `; selected artifact ${mapping.package.name}@${mapping.package.version}` : pkg.family && name===pkg.name ? '; family launcher' : '';
    return `${name}: ${row?.owner ?? 'absent'} (${row?.route ?? 'absent'}${selected})`;
  });
  inventory.push(`| \`${pkg.name}\` | ${escape(pkg.version)} | ${(pkg.aliases ?? []).map(name=>'`'+name+'`').join(', ') || 'none'} | ${escape(owners.join('; '))} |`);
}
inventory.push('', '### Family dispatch','', '| Family | Entrypoint | Selected artifact / atom |','|---|---|---|');
for (const pkg of listAvailable().filter(pkg=>pkg.family)) for (const name of pkg.entrypoints ?? pkg.aliases ?? []) {
  const mapping = resolvePackageCommand(name);
  inventory.push(`| ${pkg.name} | ${name} | ${mapping ? `${mapping.package.name}@${mapping.package.version} / ${mapping.atom}` : 'unavailable'} |`);
}
inventory.push('', '## Common names absent from the current surface','',
  'This candidate list is a documentation comparison, not another runtime registry. Names below have no catalog/parser/package entry; installed user scripts may still add them.','', absent.map(name=>'`'+name+'`').join(', ')+'.',
  '', '`make`, `chown`, `ln`, `col` and `ulimit` have explicit capability-only contracts. A listed name does not mean browser build execution, ownership changes, links or kernel limits are available.',
  '', '## Removed command modules','',
  'The removal record contains hashes and import/caller evidence. Removed files are not described as existing unregistered implementations. Their names may remain active through another owner.','');
const removals = JSON.parse(await readFile(resolve(root,'docs/shiro/removals.json'),'utf8'));
for (const row of removals.removed_command_modules) inventory.push(`- \`${row.path}\``);
generated.set(resolve(output,'command-inventory.md'),inventory.join('\n')+'\n');
{
  const notePath = resolve(root,'docs/shiro-commands-v0.61.md');
  const historicalPath = resolve(root,'docs/shiro-commands-v0.61-historical.md');
  // The immutable archive is the only source for historical measurements.
  const previous = await readFile(historicalPath,'utf8');
  const marker = '## v0.61 benchmark command usage';
  const start = previous.indexOf(marker);
  if (start < 0) throw new Error('Historical benchmark section missing; refusing to discard it');
  let historical = previous.slice(start)
    .replace(/^## v0\.61 benchmark command usage[^\n]*/, '## v0.61 benchmark command usage — historical measurements')
    .replace('the support classification below is against Shiro’s active command registry and WASI manifest.', 'the support classification below is against the original v0.61 command surface.')
    .replace('Observed command names unavailable in Shiro, with invocation counts:', 'Observed command names unavailable in the original v0.61 Shiro surface, with invocation counts:');
  // Preserve lexical measurements; recompute only their current availability.
  const observedSection = historical.slice(historical.indexOf('Observed command names'),historical.indexOf('That is 22'));
  const observed = [...observedSection.matchAll(/\|\s*`([^`]+)`\s*\|\s*([\d,]+)/g)].map(match=>({name:match[1],count:Number(match[2].replaceAll(',',''))}));
  const current = ['## Current availability of historically unavailable names','',
    'Invocation counts retain the historical lexical extraction. Availability below is regenerated from the current catalog/parser/manifest.','',
    '| Name | Historical invocations | Current route |','|---|---:|---|'];
  for (const row of observed) current.push(`| \`${row.name}\` | ${row.count} | ${commands.get(row.name)?.route ?? 'absent'} |`);
  const missing = observed.filter(row=>!commands.has(row.name));
  current.push('', `${missing.length} of those names remain absent (${missing.reduce((sum,row)=>sum+row.count,0)} historical invocations). The original 22-name/1,071-invocation baseline remains unchanged in the historical section.`);
  const footer = previous.indexOf('## Current availability of historically unavailable names',start);
  if (footer >= 0) historical = historical.slice(0,historical.indexOf('## Current availability of historically unavailable names')).trimEnd()+'\n';
  generated.set(notePath,inventory.join('\n').replaceAll('../../tests/','../tests/')+'\n\nComplete per-command routes and source hashes: [generated matrix](../docs/shiro/command-matrix.md), [JSON](../docs/shiro/command-matrix.json). Original routing claims are retained in the [historical note](shiro-commands-v0.61-historical.md).\n\n'+historical+'\n'+current.join('\n')+'\n');
}
if (options.check) {
  const stale = [];
  for (const [path,expected] of generated) {
    let actual;
    try { actual = await readFile(path,'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (actual !== expected) stale.push(relative(root,path));
  }
  if (stale.length) {
    console.error('Stale or missing Shiro inventory: \n' + stale.join('\n') + '\nRun npx tsx scripts/shiro-inventory.mjs --update-note.');
    process.exitCode = 1;
  } else console.log('Shiro inventory is current (no files written).');
} else {
  for (const [path,content] of generated) { await mkdir(dirname(path),{recursive:true}); await writeFile(path,content); }
}
console.log(`${data.commands.length} names, ${data.modules.length} command modules, ${data.artifacts.length} artifact identities: ${output}`);
