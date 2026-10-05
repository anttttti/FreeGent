# Command implementation removals

Removed 28 unregistered modules (6220 lines). The available command names are retained; subsequent engine migrations change their declared owners. Imports, dynamic string imports, command registrations and repository symbol references were checked before removal. Shared Node compatibility helpers and the WASI runtime remain.

| Module | Lines removed |
|---|---:|
| `shiro/commands/cc.ts` | 741 |
| `shiro/commands/ed.ts` | 244 |
| `shiro/commands/export.ts` | 71 |
| `shiro/commands/ffmpeg.ts` | 228 |
| `shiro/commands/history.ts` | 101 |
| `shiro/commands/jobs.ts` | 136 |
| `shiro/commands/jseval/index.ts` | 2 |
| `shiro/commands/listen.ts` | 101 |
| `shiro/commands/lua.ts` | 202 |
| `shiro/commands/magick.ts` | 318 |
| `shiro/commands/man.ts` | 968 |
| `shiro/commands/nano.ts` | 388 |
| `shiro/commands/notify.ts` | 42 |
| `shiro/commands/pgrep.ts` | 69 |
| `shiro/commands/postgres.ts` | 206 |
| `shiro/commands/ps.ts` | 71 |
| `shiro/commands/source.ts` | 105 |
| `shiro/commands/sqlite.ts` | 290 |
| `shiro/commands/stty.ts` | 27 |
| `shiro/commands/test.ts` | 369 |
| `shiro/commands/top.ts` | 219 |
| `shiro/commands/tput.ts` | 98 |
| `shiro/commands/type.ts` | 62 |
| `shiro/commands/vi.ts` | 548 |
| `shiro/commands/wasi.ts` | 166 |
| `shiro/commands/which.ts` | 49 |
| `shiro/commands/x86.ts` | 118 |
| `shiro/commands/xpkg.ts` | 281 |

## Accepted Zstandard engine replacement

`zstd`, `unzstd`, `zstdcat` and tar codec callers use the same pinned reference CLI in the existing Worker runtime. `zstd.ts` is a small argv/byte adapter; the handwritten compression and entropy-decoding engine is removed. Native reference cases compare raw compressed stdout and retained file hashes, rather than relying only on round trips.

The [machine record](removals.json) preserves removed source hashes. Broader family migrations and unresolved native references remain open.

## JSON and arithmetic engine replacements

`jq`, `bc` and `dc` use the same package/Worker execution adapter as other raw WASI CLIs. Their local language engines have been removed after focused native comparisons; source hashes and remaining adapter sizes are in the machine record. jq now selects upstream 1.8.2 with its security fixes, compared against a pinned native 1.8.2 binary; earlier 1.6 oracles remain separate historical evidence. Wider input, runtime and security acceptance gates remain open.

## rev and hexdump replacements

Both commands select reproducibly built util-linux 2.37.2 through shared catalog package adapters. Removed hexdump.ts and both local rev implementations after import/caller checks and 42/42 focused native comparisons. The machine record preserves the removed source hashes. Raw native inputs include Unicode, invalid encoding, missing final newlines, formats, offsets, multiple files and failures.
