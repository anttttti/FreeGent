/** Preserve existing exec-diff outputs; this does not execute cases or record new oracles.
 * node scripts/record-shiro-comparison.mjs BASELINE_DIR CANDIDATE_DIR
 */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root = resolve(import.meta.dirname,'..');
const [baselineDir,candidateDir] = process.argv.slice(2);
if (!baselineDir || !candidateDir) throw new Error('Provide baseline and candidate exec-diff output directories');
const corpus = resolve(root,'bench/dev-tests/log-replay');
const parse = async path => JSON.parse(await readFile(path,'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baseline = await parse(resolve(baselineDir,'results.json'));
const candidate = await parse(resolve(candidateDir,'results.json'));
const matrix = await parse(resolve(root,'docs/shiro/command-matrix.json'));
const oracle = await parse(resolve(corpus,'cases/coverage-expectations.json'));
const caseFixtures = await parse(resolve(corpus,'cases/case-fixtures.json'));
const nativePrograms = await parse(resolve(candidateDir,'native-programs.json'));
const byId = new Map(baseline.cases.map(row => [row.id,row]));
const byCommand = new Map(matrix.commands.map(row => [row.name,row]));
const raw = async (directory,side,id) => {
  const value = {};
  for (const stream of ['stdout','stderr','exit','files']) {
    try { value[stream + '_base64'] = (await readFile(resolve(directory,`${side}.${stream}.${id}`))).toString('base64'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; value[stream + '_base64'] = null; }
  }
  return value;
};
const same = (left,right) => JSON.stringify(left) === JSON.stringify(right);
const cases = [];
const transitions = {};
for (const current of candidate.cases) {
  const previous = byId.get(current.id);

  const expected = await raw(candidateDir,'real',current.id);
  const priorExpected = await raw(baselineDir,'real',current.id);
  const referenceChanged = !!previous && priorExpected.stdout_base64 !== null && !same(expected,priorExpected);
  const transition = !previous ? 'added-case' : ['capability-only','integration-only'].includes(current.status) ? 'reclassified-out-of-parity'
    : referenceChanged ? 'reference-changed'
    : previous.status === 'mismatch' && current.status === 'identical' ? 'fixed'
    : previous.status === 'identical' && current.status === 'mismatch' ? 'new-mismatch'
    : `${previous.status}->${current.status}`;
  transitions[transition] = (transitions[transition] ?? 0)+1;
  cases.push({...current, transition, referenceChanged, parity_scope:current.parity_scope ?? 'bash',
    input_sha256:hash(await readFile(resolve(corpus,'cases',current.id))),
    input_fixture:caseFixtures[current.id] ?? null,
    routes:(current.commands ?? []).map(name => byCommand.get(name)).filter(Boolean),
    baseline:previous ? {...previous,expected:priorExpected,actual:await raw(baselineDir,'browser',current.id)} : {status:'not measured',expected:null,actual:null},
    expected, actual:await raw(candidateDir,'browser',current.id),
    native_reference:oracle.cases[current.id] ? {
      status:oracle.cases[current.id].status, runs:oracle.cases[current.id].runs,
      native_programs:oracle.cases[current.id].native_programs ?? null,
      input_sha256:oracle.cases[current.id].input_sha256, reference_sha256:oracle.cases[current.id].reference_sha256,
    } : {status:'measured at sweep time', runs:1, selected_native_programs:nativePrograms},
  });
}
for (const row of baseline.cases) if (!candidate.cases.some(current=>current.id===row.id)) throw new Error('Baseline case was removed: '+row.id);
const trackedPaths = ['command-inputs.json','cases/coverage-index.json','cases/coverage-expectations.json','cases/known-differences.txt','cases/case-fixtures.json','native-tools.json','native-tools.py','extract.py','command-cases.py','jq-1.6-historical-oracles.json'];
const corpusHashes = Object.fromEntries(await Promise.all(trackedPaths.map(async path => [path,hash(await readFile(resolve(corpus,path)))])));
const harnessPaths = ['scripts/exec-diff.sh','tests/exec-diff.harness.test.ts','scripts/record-shiro-comparison.mjs'];
const harnessHashes = Object.fromEntries(await Promise.all(harnessPaths.map(async path => [path,hash(await readFile(resolve(root,path)))])));
const report = {
  schema:1,recorded_at:new Date().toISOString(),acceptance:'FAILED',
  command:'FG_NET_TESTS=1 scripts/exec-diff.sh bench/dev-tests/log-replay/cases',
  freegent_head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  baseline:{counts:baseline.counts,source_sha256:null,
    provenance_limit:'Full baseline source hashes were not captured during its execution. Do not infer them from HEAD or current sources.'},
  candidate:{counts:candidate.counts,source_sha256:matrix.sourceSha256,harness_sha256:harnessHashes,
    selected_native_programs:nativePrograms},
  corpus_sha256:corpusHashes,transitions,
  permanent_native_provenance:{oracle:oracle.oracle,environment:oracle.environment,bash_version:oracle.bash_version,
    fixtures_sha256:oracle.fixtures_sha256,native_programs:oracle.native_programs},
  comparison_limits:[
    'Raw streams are separate and byte-exact; base64 retains invalid UTF-8 and NULs. Exit and file-effect manifest bytes are preserved too.',
    'File effects compare changed/deleted file content hashes. Empty-directory, ownership, link-identity and metadata effects still require extending the harness.',
    'Permanent native oracles are independently verified twice. Sampled cases are measured once at sweep time; changed native expectations are flagged and excluded from fixed/regression claims.',
    'Per-case operand fixtures are recorded explicitly. Historical missing-operand results remain in the baseline; fixture changes are reference changes, not compatibility fixes.',
    'Static command routes are generated from current owners. Sampled cases have no command-family index; their complete inputs are identified by hash and case ID.',
    'Known Python/JavaScript differences are counted separately from identical cases. No Bash mismatch is waived.',
  ],cases,
};
await writeFile(resolve(corpus,'comparison-implementation.json'),JSON.stringify(report,null,2)+'\n');
const lines = ['# Shiro implementation comparison','','Acceptance: **FAILED**. This is an execution record, not migration approval.','',
  '| Sweep | Bash-identical | Bash mismatches | Non-Bash known differences | Capability-only | Integration-only | Unresolved references |',
  '|---|---:|---:|---:|---:|---:|---:|'];
for (const [name,counts] of [['Full baseline',baseline.counts],['Current candidate',candidate.counts]]) {
  lines.push(`| ${name} | ${counts.identical ?? 0} | ${counts.mismatch ?? 0} | ${counts['known-difference'] ?? 0} | ${counts['capability-only'] ?? 0} | ${counts['integration-only'] ?? 0} | ${counts.blocked ?? 0} |`);
}
lines.push('',`Transitions: ${Object.entries(transitions).map(([key,value])=>`${key}: ${value}`).join('; ')}.`,
  '', 'The [machine-readable record](comparison-implementation.json) preserves raw native expected bytes when available, browser output bytes for every case, baseline browser bytes, input/source/oracle hashes, selected permanent-case routes/artifacts, native provenance, and each transition. Integration-only cases have no Bash expected output. The earlier permanent-only [baseline](COMPARISON-BASELINE.md) is retained.',
  '', ...report.comparison_limits.map(value => '- '+value),
  '', 'Full baseline source hashes were not recorded at execution time. The candidate source hashes are recorded; baseline source provenance is explicitly unknown.',
  '', '## New mismatches','','These cases previously reported parity but now fail. Explicit capability errors remain failures when the command is in the Bash parity scope.');
for (const row of cases.filter(row=>row.transition==='new-mismatch')) lines.push(`- \`${row.id}\``);
lines.push('','## Reference drift','');
for (const row of cases.filter(row=>row.referenceChanged)) lines.push(`- \`${row.id}\`: measured native outputs changed between runs; do not count its transition as a fix/regression with a fixed oracle.`);
const escaped = bytes => [...Buffer.from(bytes ?? '', 'base64')].map(byte=>byte===10?'\\n':byte===13?'\\r':byte===9?'\\t':byte>=32&&byte<127?String.fromCharCode(byte):'\\x'+byte.toString(16).padStart(2,'0')).join('');
lines.push('','## Capability-only cases','','These commands report a clear Shiro capability boundary. Their real Bash bytes remain in the dataset; Shiro capability behavior is checked by command-level tests, not Bash parity.');
for (const row of cases.filter(row=>row.status==='capability-only')) lines.push(`- \`${row.id}\``);
lines.push('','## Integration-only cases','','These browser commands have no native Bash behavior contract. Their inputs stay in the case corpus; Shiro output is recorded here and their browser behavior is verified in integration tests.');
for (const row of cases.filter(row=>row.status==='integration-only')) lines.push(`- \`${row.id}\`: ${row.reason?.trim() ?? ''}`);
lines.push('','## Remaining mismatches','');
for (const row of cases.filter(row=>row.status==='mismatch')) {
  lines.push(`### ${row.id}`,'',`Baseline: ${row.baseline.status}; transition: ${row.transition}.`, '');
  for (const field of ['stdout','stderr','exit','files']) {
    if (row.comparisons[field] === false) {
      lines.push(`**${field}**`, '', '```text', 'expected: '+escaped(row.expected[field+'_base64']), 'actual:   '+escaped(row.actual[field+'_base64']), '```', '');
    }
  }
}
lines.push('## Unresolved references','','| Case | Commands | Requirement |','|---|---|---|');
for (const row of cases.filter(row=>row.status==='blocked')) lines.push(`| ${row.id} | ${(row.commands??[]).join(', ')} | ${(row.reason??'').replace(/\|/g,'\\|')} |`);
await writeFile(resolve(corpus,'COMPARISON-IMPLEMENTATION.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({counts:candidate.counts,transitions}));
