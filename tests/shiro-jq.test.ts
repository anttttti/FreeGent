import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { jqCmd } from '../shiro/commands/jq';

const files: Record<string, string> = {};
import 'fake-indexeddb/auto';
import { FileSystem } from '../shiro/filesystem';
import { Shell } from '../shiro/shell';
import { CommandRegistry } from '../shiro/commands/index';
import { setWasiWorkerFactory } from '../shiro/wasi-host';
import { nodeWorkerFactory } from './helpers/node-wasi-worker';
let shell:Shell;
beforeAll(async () => {
  setWasiWorkerFactory(await nodeWorkerFactory());
  const fs = new FileSystem(); await fs.init();
  const commands=new CommandRegistry(); commands.register(jqCmd);
  shell=new Shell(fs,commands); shell.cwd='/';
});
afterAll(() => setWasiWorkerFactory(null));

async function jq(args: string[], stdin = '') {
  for (const [name,content] of Object.entries(files)) await shell.fs.writeFile(shell.fs.resolvePath(name,'/'),content);
  const ctx = { args, fs:shell.fs, shell,cwd: '/', env: { HOME: '/home/x' }, stdin, stdout: '', stderr: '' };
  const code = await jqCmd.exec(ctx);
  return { code, out: ctx.stdout as string, err: ctx.stderr as string };
}
const c = async (filter: string, input: string, ...opts: string[]) => (await jq(['-c', ...opts, filter], input)).out.trim();

describe('jq', () => {
  it('basics', async () => {
    expect(await c('.a.b', '{"a":{"b":3}}')).toBe('3');
    expect(await c('.[] | select(. > 1)', '[1,2,3]')).toBe('2\n3');
    expect(await c('map(.+1)', '[1,2]')).toBe('[2,3]');
    expect(await c('{a, b: .c}', '{"a":1,"c":2}')).toBe('{"a":1,"b":2}');
    expect(await c('.[1:]', '[1,2,3]')).toBe('[2,3]');
    expect(await c('"x\\(.a)y"', '{"a":5}')).toBe('"x5y"');
  });

  it('variables and as-bindings', async () => {
    expect(await c('. as $x | $x + 1', '1')).toBe('2');
    expect(await c('.[] as [$a,$b] | $a+$b', '[[1,2],[3,4]]')).toBe('3\n7');
    expect(await c('. as {a:$x, b:[$y]} | [$x,$y]', '{"a":1,"b":[2]}')).toBe('[1,2]');
    expect(await c('--arg', 'x', '1') ).toBeDefined();
    expect((await jq(['-n', '--arg', 'v', 'hi', '$v'])).out).toBe('"hi"\n');
    expect((await jq(['-n', '-c', '--argjson', 'o', '{"a":[1,2]}', '$o.a|length'])).out).toBe('2\n');
  });

  it('--slurpfile / --rawfile / --args / $ARGS', async () => {
    files['/regs.json'] = '{"a":1}\n{"b":2}';
    files['/t.txt'] = 'hello';
    expect((await jq(['-n', '-c', '--slurpfile', 'r', '/regs.json', '$r'])).out).toBe('[{"a":1},{"b":2}]\n');
    expect((await jq(['-n', '--rawfile', 't', '/t.txt', '$t'])).out).toBe('"hello"\n');
    expect((await jq(['-n', '-c', '$ARGS.positional', '--args', 'a', 'b'])).out).toBe('["a","b"]\n');
    expect((await jq(['-n', '-c', '$ARGS.named', '--arg', 'k', 'v'])).out).toBe('{"k":"v"}\n');
  });

  it('the coverage pattern from the bug report', async () => {
    files['/regs.json'] = '[{"iso":"BOL"},{"iso":"XXX"}]';
    const countries = '[{"adm0cap":1,"iso":"BOL","featurecla":"Admin-0 capital"},{"adm0cap":1,"iso":"BOL"},{"adm0cap":0,"iso":"ZZZ"}]';
    const r = await jq(['-c', '--slurpfile', 'regs', '/regs.json',
      '($regs[0] | map({key:.iso, value:true}) | from_entries) as $r | [.[] | select(.adm0cap==1 and (.featurecla // "" | test("capital";"i"))) | .iso] | map(select($r[.] // false))', ], countries);
    expect(r.out.trim()).toBe('["BOL"]');
    expect((await c('(.[1]|from_entries) as $r | $r|length', '[[],[{"key":"a","value":1},{"key":"b","value":2}]]'))).toBe('2');
    expect(await c('group_by(.k) | map({k: .[0].k, n: length})', '[{"k":"a"},{"k":"b"},{"k":"a"}]')).toBe('[{"k":"a","n":2},{"k":"b","n":1}]');
  });

  it('reduce / foreach / def / recursion', async () => {
    expect(await c('reduce .[] as $x (0; . + $x)', '[1,2,3]')).toBe('6');
    expect(await c('[foreach .[] as $x (0; . + $x)]', '[1,2,3]')).toBe('[1,3,6]');
    expect(await c('def f(x): x * 2; f(.)', '4')).toBe('8');
    expect(await c('def fac: if . <= 1 then 1 else . * (. - 1 | fac) end; fac', '5')).toBe('120');
    expect(await c('def addv($a; $b): $a + $b; addv(1; 2)', 'null')).toBe('3');
    expect(await c('[limit(3; range(100))]', 'null')).toBe('[0,1,2]');
    expect(await c('[range(0;10;3)]', 'null')).toBe('[0,3,6,9]');
    expect(await c('last(range(5))', 'null')).toBe('4');
    expect(await c('[.[] | until(. > 100; . * 2)]', '[1,3]')).toBe('[128,192]');
  });

  it('paths and assignment', async () => {
    expect(await c('.a = 1', '{}')).toBe('{"a":1}');
    expect(await c('.a |= . + 1', '{"a":1}')).toBe('{"a":2}');
    expect(await c('.[] += 1', '[1,2]')).toBe('[2,3]');
    expect(await c('.a //= 5', '{"a":null}')).toBe('{"a":5}');
    expect(await c('del(.a)', '{"a":1,"b":2}')).toBe('{"b":2}');
    expect(await c('del(.[0,2])', '[1,2,3]')).toBe('[2]');
    expect(await c('[paths]', '{"a":[1]}')).toBe('[["a"],["a",0]]');
    expect(await c('to_entries', '{"a":1}')).toBe('[{"key":"a","value":1}]');
    expect(await c('with_entries(.value += 1)', '{"a":1}')).toBe('{"a":2}');
    expect(await c('map_values(select(. > 1))', '{"a":1,"b":2}')).toBe('{"b":2}');
    expect(await c('walk(if type=="number" then .+1 else . end)', '[1,[2]]')).toBe('[2,[3]]');
    expect(await c('pick(.a)', '{"a":1,"b":2}')).toBe('{"a":1}');
  });

  it('strings, regex, formats', async () => {
    expect(await c('test("^a")', '"abc"')).toBe('true');
    expect(await c('[match("a";"g").offset]', '"aXa"')).toBe('[0,2]');
    expect(await c('capture("(?<y>\\\\d+)-(?<m>\\\\d+)")', '"2024-05"')).toBe('{"y":"2024","m":"05"}');
    expect(await c('gsub("a";"b")', '"aaa"')).toBe('"bbb"');
    expect(await c('sub("(?<x>a)";"[\\(.x)]")', '"cat"')).toBe('"c[a]t"');
    expect(await c('[scan("\\\\d")]', '"a1b2"')).toBe('["1","2"]');
    expect(await c('split(", ")', '"a, b"')).toBe('["a","b"]');
    expect(await c('join("-")', '["a",1,null]')).toBe('"a-1-"');
    expect(await c('@csv', '["a",1,"b\\"c"]')).toBe('"\\"a\\",1,\\"b\\"\\"c\\""');
    expect(await c('@base64', '"hi"')).toBe('"aGk="');
    expect(await c('@sh "echo \\(.)"', '"it\'s"')).toBe('"echo \'it\'\\\\\'\'s\'"');
    expect(await c('ascii_downcase', '"ABC"')).toBe('"abc"');
    expect(await c('ltrimstr("a")', '"abc"')).toBe('"bc"');
  });

  it('control flow & errors', async () => {
    expect(await c('if . > 1 then "big" elif . == 1 then "one" else "small" end', '1')).toBe('"one"');
    expect(await c('try error("x") catch .', 'null')).toBe('"x"');
    expect(await c('[.[] | (.a)?]', '[1,{"a":2}]')).toBe('[2]');
    expect(await c('.a // "d"', '{}')).toBe('"d"');
    expect(await c('label $out | 1, 2, break $out, 3', 'null')).toBe('1\n2');
    expect(await c('first(range(10;0;-1))', 'null')).toBe('10');
    expect(await c('[.[] | tostring]', '[1,"a",null]')).toBe('["1","a","null"]');
    expect(await c('(1,2) + (10,20)', 'null', '-n')).toBe('11\n12\n21\n22');
    const e = await jq(['.a.b'], '{"a":1}');
    expect(e.code).toBe(5);
    expect(e.err).toBe('jq: error (at <stdin>:0): Cannot index number with string ("b")\n');
    const u = await jq(['nosuchfn'], '1');
    expect(u.code).toBe(3);
    expect(u.err).toMatch(/nosuchfn\/0 is not defined/);
    expect((await jq(['.a |'], '1')).code).toBe(3);
  });

  it('sorting, grouping, misc builtins', async () => {
    expect(await c('sort', '[3,"a",null,[1],{"a":1},true,1]')).toBe('[null,true,1,3,"a",[1],{"a":1}]');
    expect(await c('sort_by(.a)', '[{"a":2},{"a":1}]')).toBe('[{"a":1},{"a":2}]');
    expect(await c('unique_by(.a)', '[{"a":1,"b":1},{"a":1,"b":2}]')).toBe('[{"a":1,"b":1}]');
    expect(await c('min_by(.a), max_by(.a)', '[{"a":2},{"a":1}]')).toBe('{"a":1}\n{"a":2}');
    expect(await c('flatten', '[1,[2,[3]]]')).toBe('[1,2,3]');
    expect(await c('add', '[1,2,3]')).toBe('6');
    expect(await c('any(. > 2), all(. > 0)', '[1,2,3]')).toBe('true\ntrue');
    expect(await c('transpose', '[[1,2],[3,4]]')).toBe('[[1,3],[2,4]]');
    expect(await c('[.[] | floor]', '[1.5,-1.5]')).toBe('[1,-2]');
    expect(await c('indices(1)', '[0,1,2,1]')).toBe('[1,3]');
    expect(await c('inside({"a":1,"b":2})', '{"a":1}')).toBe('true');
    expect(await c('todate', '1700000000')).toBe('"2023-11-14T22:13:20Z"');
    expect(await c('[.[]|tojson]', '[1,"a"]')).toBe('["1","\\"a\\""]');
    expect(await c('IN(1,2)', '2')).toBe('true');
    expect(await c('[combinations]', '[[1,2],[3]]')).toBe('[[1,3],[2,3]]');
    expect(await c('[.] | implode', '65')).toBe('"A"');
    const ascii = await jq(['ascii'], '65');
    expect(ascii.code).toBe(3);
    expect(ascii.err).toContain('ascii/0 is not defined');
    expect(await c('[tostream]', '{"a":[1]}')).toBe('[[["a",0],1],[["a",0]],[["a"]]]');
    expect(await c('fromstream(tostream)', '{"a":[1]}')).toBe('{"a":[1]}');
  });

  it('CLI options & input handling', async () => {
    expect((await jq(['.'], '{"a":[1,{"b":2}],"c":{}}')).out).toBe('{\n  "a": [\n    1,\n    {\n      "b": 2\n    }\n  ],\n  "c": {}\n}\n');
    expect((await jq(['-r', '.[]'], '["a","b"]')).out).toBe('a\nb\n');
    expect((await jq(['-j', '.[]'], '["a","b"]')).out).toBe('ab');
    expect((await jq(['-rc', '.'], '"x"')).out).toBe('x\n');
    expect((await jq(['-s', '-c', '.'], '1 2\n3')).out).toBe('[1,2,3]\n');
    expect((await jq(['-c', '.'], '{"a":1}{"a":2}')).out).toBe('{"a":1}\n{"a":2}\n');
    expect((await jq(['-n', '[inputs]', '-c'], '1 2 3')).out).toBe('[1,2,3]\n');
    expect((await jq(['-n', 'input', '-c'], '1 2 3')).out).toBe('1\n');
    expect((await jq(['-R', '.'], 'a\nb\n')).out).toBe('"a"\n"b"\n');
    expect((await jq(['-Rs', '.'], 'a\nb\n')).out).toBe('"a\\nb\\n"\n');
    expect((await jq(['-S', '-c', '.'], '{"b":1,"a":2}')).out).toBe('{"a":2,"b":1}\n');
    expect((await jq(['--tab', '.'], '[1]')).out).toBe('[\n\t1\n]\n');
    expect((await jq(['--indent', '1', '.'], '[1]')).out).toBe('[\n 1\n]\n');
    expect((await jq(['-e', '.'], 'null')).code).toBe(1);
    expect((await jq(['-e', 'empty'], '1')).code).toBe(4);
    expect((await jq(['-n', '$ENV.HOME', '-r'])).out).toBe('/home/x\n');
    expect((await jq(['.', '/missing.json'])).code).toBe(2);
    files['/prog.jq'] = '.a # comment\n| . + 1';
    files['/in.json'] = '{"a":1}';
    expect((await jq(['-f', '/prog.jq', '/in.json'])).out).toBe('2\n');
    const bad = await jq(['.'], '{"a":1} {');
    expect(bad.out).toBe('{\n  "a": 1\n}\n');
    expect(bad.code).toBe(5);
  });
});
