#!/usr/bin/env python3
"""Contract checks for exec-diff cases whose output cannot be byte-identical to a native run.

Some commands report the machine (df, free, uptime, id, hostname), draw from entropy or the
clock (uuidgen, fortune), or print terminal art / timing (lolcat, viu, pytest). A browser shell
has no real host to match and a native golden would record the reference machine, not behavior.
Those cases carry a *contract* instead: the rule the output must satisfy. The same contract is
checked against the native run (when the tool exists there) and against the browser shell, so it
is held to real output, not invented.

A contract is a dict; every key is optional:
  exit       expected exit status (default 0)
  stdout     regex the whole normalized stdout must match (re.DOTALL, fullmatch); absent = unchecked
  stderr     same for stderr; "" means empty
  normalize  names applied to stdout/stderr before matching:
               ansi     strip terminal escape sequences (colour, cursor movement)
               cr       CRLF -> LF
               elapsed  "in 0.01s" -> "in #s" (test-runner timing)
  files      workspace paths the run may change; an entry ending in "/" allows everything under that
             directory (".pytest_cache/"). Any other change fails. Absent = unchecked.
  native     "required" | "optional" | "none"   how the native run is used (see command-cases.py)
  native_note  why a native run is not used, when it is "none"
"""
import json
import re
import sys

_ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]')


def normalize(text: str, names) -> str:
    for name in names or []:
        if name == 'ansi':
            text = _ANSI.sub('', text)
        elif name == 'cr':
            text = text.replace('\r\n', '\n')
        elif name == 'elapsed':
            text = re.sub(r'\bin \d+(?:\.\d+)?s\b', 'in #s', text)
        else:
            raise ValueError('unknown normalizer: ' + name)
    return text


def check(contract: dict, stdout: bytes, stderr: bytes, exit_code, changed=None) -> list:
    """Return the list of ways the output breaks the contract (empty = it holds)."""
    problems = []
    want = contract.get('exit', 0)
    if exit_code != want:
        problems.append(f'exit {exit_code}, expected {want}')
    for stream, data in (('stdout', stdout), ('stderr', stderr)):
        pattern = contract.get(stream)
        if pattern is None:
            continue
        text = normalize(data.decode('utf-8', errors='replace'), contract.get('normalize'))
        if not re.fullmatch(pattern, text, re.DOTALL):
            problems.append(f'{stream} {text[:160]!r} does not match /{pattern}/')
    allowed = contract.get('files')
    if allowed is not None and changed is not None:
        extra = sorted(p for p in set(changed)
                       if p not in allowed and not any(a.endswith('/') and p.startswith(a) for a in allowed))
        if extra:
            problems.append('unexpected file changes: ' + ', '.join(extra))
    return problems


def validate(contract: dict) -> None:
    """Reject a malformed contract when it is recorded, not when a sweep first runs it."""
    known = {'exit', 'stdout', 'stderr', 'normalize', 'files', 'native', 'native_note'}
    if not isinstance(contract, dict) or set(contract) - known:
        raise ValueError('bad contract keys: ' + ', '.join(sorted(set(contract) - known)) if isinstance(contract, dict) else 'contract must be an object')
    for key in ('stdout', 'stderr'):
        if contract.get(key) is not None:
            re.compile(contract[key], re.DOTALL)
    normalize('', contract.get('normalize'))
    if contract.get('native', 'optional') not in ('required', 'optional', 'none'):
        raise ValueError('native must be required, optional or none')
    if contract.get('native') == 'none' and not contract.get('native_note'):
        raise ValueError('native "none" needs a native_note saying why')


def _changed_from_manifest(text: str) -> list:
    """Paths from exec-diff's file-effect manifest: "file:./<path>\\t<sha256|deleted>" lines."""
    return [line[len('file:./'):].split('\t')[0] for line in text.splitlines() if line.startswith('file:./')]


def main(argv):
    # contract.py check CONTRACT.json STDOUT STDERR EXIT [FILES]   -> prints problems, exit 1 if any
    if len(argv) >= 6 and argv[1] == 'check':
        contract = json.load(open(argv[2]))
        stdout, stderr = open(argv[3], 'rb').read(), open(argv[4], 'rb').read()
        code = int(open(argv[5]).read().strip() or 0)
        changed = _changed_from_manifest(open(argv[6]).read()) if len(argv) > 6 else None
        problems = check(contract, stdout, stderr, code, changed)
        print('; '.join(problems))
        return 1 if problems else 0
    # contract.py eval  (JSON on stdin: {contract, stdout, stderr, exit, files}) -> {"problems":[...]}
    if len(argv) == 2 and argv[1] == 'eval':
        req = json.load(sys.stdin)
        try:
            validate(req['contract'])
            problems = check(req['contract'], req.get('stdout', '').encode(), req.get('stderr', '').encode(),
                             req.get('exit', 0), req.get('files'))
            print(json.dumps({'problems': problems}))
        except (ValueError, re.error) as e:
            print(json.dumps({'invalid': str(e)}))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
