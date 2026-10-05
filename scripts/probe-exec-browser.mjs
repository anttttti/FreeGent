// Actual opaque-origin iframe/Worker acceptance. Requires a running Vite server and
// playwright-core (no bundled browser); FG_BROWSER_TOOLS can point to a temporary npm prefix.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const zstdExpected = JSON.parse(readFileSync('bench/dev-tests/log-replay/cases/coverage-expectations.json','utf8')).cases['coverage-zstd-05.sh'].expected.stdout_base64;
const zstdInput = readFileSync('scripts/shell-diff/fixtures/words.txt','utf8');
const utilCaseIds = ['coverage-rev-04.sh','coverage-hexdump-03.sh'];
const inputs = JSON.parse(readFileSync('bench/dev-tests/log-replay/command-inputs.json','utf8')).cases;
const expectations = JSON.parse(readFileSync('bench/dev-tests/log-replay/cases/coverage-expectations.json','utf8')).cases;
const utilCodes = utilCaseIds.map(id=>inputs.find(input=>input.id===id).code);
const utilExpected = utilCaseIds.map(id=> {
  const e=expectations[id].expected;
  return {stdout:Buffer.from(e.stdout_base64,'base64').toString('utf8'),stderr:Buffer.from(e.stderr_base64,'base64').toString('utf8'),exit_code:e.exit_code};
});
import { spin } from '../tests/helpers/wasm-assemble.ts';

const require = createRequire(resolve(process.env.FG_BROWSER_TOOLS ?? '.', 'package.json'));
const { chromium } = require('playwright-core');
const browser = await chromium.launch({executablePath:process.env.FG_BROWSER_BIN ?? '/snap/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try {
  const page = await browser.newPage();
  await page.exposeFunction('__fgProbeStage', name => process.stderr.write(`Browser probe: ${name}\n`));
  await page.goto(process.env.FG_BROWSER_URL ?? 'http://127.0.0.1:5000/');
  await page.waitForFunction(() => typeof agentWriteFile === 'function' && typeof initDB === 'function');
  const results = await page.evaluate(async ({spinBase64,zstdInput,utilCodes}) => {
    await initDB();
    const {sandboxCall,resetSandbox} = await import('/exec-sandbox-host.ts');
    const call = async (code,onProgress) => {
      await globalThis.__fgProbeStage(code.slice(0,100));
      return sandboxCall('bash',{code},120000,onProgress);
    };
    const basic = await call('printf "%s\\n" "a b"; echo x > probe.txt; cat probe.txt');
    const isolation = await sandboxCall('js',{files:{},code:'for (const read of [() => parent.document.body, () => localStorage.length, () => indexedDB.open("page-data")]) {try {read(); console.log("allowed");} catch (e) {console.log(e.name);}}'},30000);
    const frame = document.querySelector('iframe[sandbox="allow-scripts"]');
    const boundary = {sandbox:frame?.getAttribute('sandbox'),inaccessible:frame?.contentDocument === null};
    const progress = [];
    await agentWriteFile('bytes.bin',btoa(String.fromCharCode(0,255,13,10)),'base64');
    const binary = await call('gcat bytes.bin | od -An -v -tx1',message => progress.push(message));
    for (let i=0;i<105;i++) await agentWriteFile(`tree/${i}/a/b/c/d/input.txt`,'needle\n');
    const recursive = await call('wasm-grep -r -l needle tree | wc -l');
    await agentWriteFile('spin.wasm',spinBase64,'base64');
    const start = performance.now();
    const deadline = await call('chmod +x spin.wasm; timeout 0.2 ./spin.wasm');
    const elapsed = performance.now()-start;
    const recovery = await call('printf recovered');
    await agentWriteFile('zstd-probe.txt',zstdInput);
    const zstd = await call('zstd -q -c zstd-probe.txt | base64 -w0');
    const sevenzip = await call('7z a -bd -bso0 -bsp0 probe.7z bytes.bin; 7z x -so -bsp0 probe.7z bytes.bin | od -An -v -tx1; rm probe.7z');
    const interpreters = await call('printf \'{"a":1,"b":2}\\n\' | jq -c \'pick(.a)\'; lua -e \'local ok, msg=pcall(function() error("caught") end); print(ok, type(msg))\'; printf "2^10\\n" | bc; printf "2 3 + p\\n" | dc');
    await agentWriteFile('words.txt',zstdInput);
    const utilResults=[];
    for (const code of utilCodes) utilResults.push(await call(code));
    resetSandbox();
    return {utilResults,basic,isolation,boundary,binary,progress,recursive,deadline,elapsed,recovery,zstd,sevenzip,interpreters};
  },{spinBase64:Buffer.from(spin()).toString('base64'),zstdInput,utilCodes});
  assert.deepEqual(results.utilResults,utilExpected);
  assert.deepEqual(results.basic,{stdout:'a b\nx\n',stderr:'',exit_code:0});
  assert.deepEqual(results.boundary,{sandbox:'allow-scripts',inaccessible:true});
  assert.equal(results.isolation.stdout,'SecurityError\nSecurityError\nSecurityError\n');
  assert.deepEqual(results.binary,{stdout:' 00 ff 0d 0a\n',stderr:'',exit_code:0});
  assert.ok(results.progress.some(message => /Downloading coreutils/.test(message)));
  assert.deepEqual(results.recursive,{stdout:'105\n',stderr:'',exit_code:0});
  assert.equal(results.deadline.exit_code,124);
  assert.ok(results.elapsed<5000);
  assert.deepEqual(results.recovery,{stdout:'recovered',stderr:'',exit_code:0});
  assert.deepEqual(results.zstd,{stdout:zstdExpected,stderr:'',exit_code:0});
  assert.deepEqual(results.sevenzip,{stdout:' 00 ff 0d 0a\n',stderr:'',exit_code:0});
  assert.deepEqual(results.interpreters,{stdout:'{"a":1}\nfalse\tstring\n1024\n5\n',stderr:'',exit_code:0});
  // A fresh frame has empty memory caches. Block external package fetches, so the next
  // command must use the page's verified artifact cache across the frame reset.
  await page.route('**/*',async route => {
    const request = route.request();
    if (request.url().includes('/shiro/wasm/') || request.headers().origin === 'null' || /^https:\/\/(uutils\.org|cdn\.wasmer\.io)\//.test(request.url())) await route.abort();
    else await route.continue();
  });
  const offline = await page.evaluate(async ({utilCodes}) => {
    const {sandboxCall,resetSandbox} = await import('/exec-sandbox-host.ts');
    const progress = [];
    const result = await sandboxCall('bash',{code:'gcat bytes.bin | od -An -v -tx1'},120000,message=>progress.push(message));
    const zstd = await sandboxCall('bash',{code:'zstd -q -c zstd-probe.txt | base64 -w0'},120000,message=>progress.push(message));
    const utilResults=[];
    for (const code of utilCodes) utilResults.push(await sandboxCall('bash',{code},120000,message=>progress.push(message)));
    resetSandbox();
    return {result,progress,zstd,utilResults};
  },{utilCodes});
  assert.deepEqual(offline.utilResults,utilExpected);
  assert.deepEqual(offline.result,{stdout:' 00 ff 0d 0a\n',stderr:'',exit_code:0});
  assert.deepEqual(offline.zstd,{stdout:zstdExpected,stderr:'',exit_code:0});
  assert.ok(!offline.progress.some(message=>/Downloading/.test(message)));
  process.stdout.write(JSON.stringify({status:'passed',checks:['workspace','opaque origin','loader progress','binary pipe','deep recursive WASI input','Worker deadline','recovery','offline package cache across frame resets','local pinned artifact RPC and offline byte parity','verified 7-Zip loader import and binary archive round trip','jq, Lua exception handling, bc and dc upstream CLIs','upstream rev Unicode and hexdump offsets, including offline frame reset'],deadlineMs:Math.round(results.elapsed)},null,2)+'\n');
} finally {await browser.close();}
