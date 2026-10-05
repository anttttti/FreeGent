# Current Shiro command inventory

Generated from the working tree by `npx tsx scripts/shiro-inventory.mjs --update-note`. Regenerate after routing changes. The machine-readable command matrix retains source hashes and candidate declarations.

248 command names; 140 command modules; 29 WASI artifact identities. Availability does not establish complete flag compatibility or migration acceptance.

## Registration and lookup

`shell-singleton.ts` registers `COMMAND_CATALOG` once. The catalog declares one owner per name; `CommandRegistry` rejects duplicates. Registration order does not replace previous owners.

Lookup precedence: grammar → alias expansion → function → enabled builtin → remembered command location → user PATH executable → catalog command → lazy package. Shell grammar and enabled builtin handling remain owned by `shell.ts`. A user PATH executable may override a catalog external command. Managed alternative package stubs do not override its catalog default; their explicit paths remain callable.

`hash` remembers external command locations and participates in lookup. PATH assignments invalidate remembered locations; discovery does not download lazy packages.

Lookup regression evidence: [shell precedence and hash tests](../../tests/shiro-shell-commands.test.ts) and [lazy packages and managed-stub tests](../../tests/shiro-wasm-packages.test.ts).

## Names grouped by current default route

| Route | Support scope | Names |
|---|---|---|
| adapter | bash | `openssl`, `util-linux`, `wabt` |
| native-only | capability-only | `chown`, `col`, `ln`, `make` |
| shell grammar | bash | `!`, `[[`, `case`, `coproc`, `do`, `done`, `elif`, `else`, `esac`, `fi`, `for`, `function`, `if`, `in`, `then`, `time`, `until`, `while` |
| shell parser | bash | `.`, `((...))`, `alias`, `break`, `builtin`, `caller`, `command`, `compgen`, `complete`, `compopt`, `continue`, `declare`, `dirs`, `disown`, `enable`, `eval`, `exec`, `export`, `fc`, `getopts`, `hash`, `let`, `local`, `mapfile`, `popd`, `pushd`, `read`, `readarray`, `readonly`, `return`, `set`, `setopt`, `shift`, `shopt`, `source`, `trap`, `type`, `typeset`, `umask`, `unalias`, `unset` |
| shell parser | capability-only | `ulimit` |
| typescript | bash | `[`, `7z`, `awk`, `base32`, `base64`, `basename`, `bash`, `bunzip2`, `bzcat`, `bzip2`, `cat`, `cd`, `chmod`, `cksum`, `clear`, `cmp`, `column`, `comm`, `cp`, `csplit`, `curl`, `cut`, `date`, `dd`, `df`, `diff`, `dirname`, `dos2unix`, `du`, `echo`, `egrep`, `env`, `exit`, `expand`, `expr`, `factor`, `false`, `fgrep`, `file`, `find`, `fmt`, `fold`, `free`, `getconf`, `glob`, `grep`, `gunzip`, `gzip`, `head`, `help`, `hostname`, `iconv`, `id`, `install`, `join`, `js-eval`, `kill`, `less`, `ls`, `md5sum`, `mkdir`, `mktemp`, `mv`, `nl`, `node`, `nohup`, `npm`, `nproc`, `npx`, `numfmt`, `od`, `paste`, `patch`, `pip`, `pip3`, `pkg-config`, `pr`, `printenv`, `printf`, `pwd`, `pytest`, `python`, `python3`, `readlink`, `realpath`, `rg`, `rm`, `rmdir`, `sed`, `seq`, `sh`, `sha1sum`, `sha256sum`, `sha384sum`, `sha512sum`, `shasum`, `shuf`, `sleep`, `sort`, `split`, `stat`, `strings`, `sum`, `sync`, `tac`, `tail`, `tar`, `tee`, `test`, `timeout`, `touch`, `tr`, `true`, `truncate`, `tsort`, `uname`, `unexpand`, `uniq`, `unix2dos`, `unxz`, `unzip`, `uptime`, `uuidgen`, `watch`, `wc`, `wget`, `which`, `whoami`, `xargs`, `xxd`, `xz`, `xzcat`, `yes`, `zcat`, `zip` |
| typescript | integration-only | `open`, `pkg`, `xdg-open` |
| wasm package | bash | `brotli`, `cal`, `coreutils`, `cowsay`, `dash`, `figlet`, `fortune`, `gbase64`, `gcat`, `ghashsum`, `ghead`, `gls`, `gsort`, `gtail`, `guniq`, `gwc`, `irb`, `lolcat`, `lua`, `optipng`, `php`, `qjs`, `qr2text`, `quickjs`, `ruby`, `sqlite`, `sqlite3`, `uuid`, `viu`, `wasm-grep`, `wasm-sed`, `wasm-strip`, `wasm-validate`, `wasm2wat`, `wat2wasm` |
| wasm | bash | `bc`, `dc`, `hexdump`, `jq`, `rev`, `unzstd`, `zstd`, `zstdcat` |

## Current routing checks

| Name | Catalog/parser owner | Default route |
|---|---|---|
| `grep` | shiro/commands/grep.ts | typescript |
| `sed` | shiro/commands/sed.ts | typescript |
| `hexdump` | shiro/commands/unix.ts | wasm |
| `rev` | shiro/commands/unix.ts | wasm |
| `cal` | shiro/wasi-packages.ts | wasm package |
| `bc` | shiro/commands/bc.ts | wasm |
| `dc` | shiro/commands/dc.ts | wasm |
| `jq` | shiro/commands/jq.ts | wasm |
| `zstd` | shiro/commands/zstd.ts | wasm |
| `unzstd` | shiro/commands/zstd.ts | wasm |
| `zstdcat` | shiro/commands/zstd.ts | wasm |
| `util-linux` | shiro/commands/index.ts | adapter |
| `wabt` | shiro/commands/index.ts | adapter |
| `which` | shiro/commands/shiro-cmds.ts | typescript |
| `alias` | shiro/shell.ts | shell parser |
| `read` | shiro/shell.ts | shell parser |
| `let` | shiro/shell.ts | shell parser |
| `getopts` | shiro/shell.ts | shell parser |
| `time` | shiro/shell.ts | shell grammar |

bc, dc, jq and zstd declarations are thin adapters selecting the upstream WASI CLI. Their `.ts` filenames do not indicate local language/codec engines. `util-linux` and `wabt` are registered family launchers. Each declared entrypoint resolves independently to its selected package; catalog bindings determine the default command owner.

## WASI manifest packages

Artifact identities count distinct manifest package/version/pin cache keys, including explicitly installable alternatives. Aliases and family entrypoints do not add artifacts. `util-linux` retains its legacy installable WebC artifact; its family launcher dispatches hexdump, cal and rev to their standalone pinned artifacts. bc and dc are separately compiled programs. An alternative artifact listed here is not necessarily the default owner.

| Package artifact | Version | Declared aliases | Default owner / route |
|---|---|---|---|
| `hexdump` | 2.37.2-fg1 | none | hexdump: shiro/commands/unix.ts (wasm; selected artifact hexdump@2.37.2-fg1) |
| `rev` | 2.37.2-fg1 | none | rev: shiro/commands/unix.ts (wasm; selected artifact rev@2.37.2-fg1) |
| `cal` | 12.1.7-fg1 | none | cal: shiro/wasi-packages.ts (wasm package; selected artifact cal@12.1.7-fg1) |
| `bc` | 1.07.1 | none | bc: shiro/commands/bc.ts (wasm; selected artifact bc@1.07.1) |
| `dc` | 1.07.1 | none | dc: shiro/commands/dc.ts (wasm; selected artifact dc@1.07.1) |
| `cowsay` | 0.3.0-fg1 | none | cowsay: shiro/wasi-packages.ts (wasm package; selected artifact cowsay@0.3.0-fg1) |
| `fortune` | 0.2.0 | none | fortune: shiro/wasi-packages.ts (wasm package; selected artifact fortune@0.2.0) |
| `lolcat` | 0.2.0 | none | lolcat: shiro/wasi-packages.ts (wasm package; selected artifact lolcat@0.2.0) |
| `figlet` | 0.0.1 | none | figlet: shiro/wasi-packages.ts (wasm package; selected artifact figlet@0.0.1) |
| `coreutils` | a6d1eb3835c0f808fa9678e4551df7377bcab8d3 | `gls`, `gcat`, `ghead`, `gtail`, `gwc`, `gsort`, `guniq`, `gbase64`, `ghashsum` | coreutils: shiro/wasi-packages.ts (wasm package; selected artifact coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3); gls: shiro/wasi-packages.ts (wasm package; selected artifact coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3); gcat: shiro/wasi-packages.ts (wasm package; selected artifact coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3); ghead: shiro/wasi-packages.ts (wasm package; selected artifact coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3); gtail: shiro/wasi-packages.ts (wasm package; selected artifact coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3); gwc: shiro/wasi-packages.ts (wasm package; selected artifact coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3); gsort: shiro/wasi-packages.ts (wasm package; selected artifact coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3); guniq: shiro/wasi-packages.ts (wasm package; selected artifact coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3); gbase64: shiro/wasi-packages.ts (wasm package; selected artifact coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3); ghashsum: shiro/wasi-packages.ts (wasm package; selected artifact coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3) |
| `grep` | 3.12.0 | `wasm-grep` | grep: shiro/commands/grep.ts (typescript; selected artifact grep@3.12.0); wasm-grep: shiro/wasi-packages.ts (wasm package; selected artifact grep@3.12.0) |
| `sed` | 4.9.0 | `wasm-sed` | sed: shiro/commands/sed.ts (typescript; selected artifact sed@4.9.0); wasm-sed: shiro/wasi-packages.ts (wasm package; selected artifact sed@4.9.0) |
| `jq` | 1.8.2 | none | jq: shiro/commands/jq.ts (wasm; selected artifact jq@1.8.2) |
| `zstd` | 1.4.8 | `unzstd`, `zstdcat` | zstd: shiro/commands/zstd.ts (wasm; selected artifact zstd@1.4.8); unzstd: shiro/commands/zstd.ts (wasm; selected artifact zstd@1.4.8); zstdcat: shiro/commands/zstd.ts (wasm; selected artifact zstd@1.4.8) |
| `quickjs` | 0.0.3 | `qjs` | quickjs: shiro/wasi-packages.ts (wasm package; selected artifact quickjs@0.0.3); qjs: shiro/wasi-packages.ts (wasm package; selected artifact quickjs@0.0.3) |
| `lua` | 5.3.6 | none | lua: shiro/wasi-packages.ts (wasm package; selected artifact lua@5.3.6) |
| `sqlite` | 0.2.2 | `sqlite3` | sqlite: shiro/wasi-packages.ts (wasm package; selected artifact sqlite@0.2.2); sqlite3: shiro/wasi-packages.ts (wasm package; selected artifact sqlite@0.2.2) |
| `viu` | 0.2.3 | none | viu: shiro/wasi-packages.ts (wasm package; selected artifact viu@0.2.3) |
| `util-linux` | 0.0.1 | `hexdump`, `rev` | util-linux: shiro/commands/index.ts (adapter; family launcher); hexdump: shiro/commands/unix.ts (wasm; selected artifact hexdump@2.37.2-fg1); rev: shiro/commands/unix.ts (wasm; selected artifact rev@2.37.2-fg1); cal: shiro/wasi-packages.ts (wasm package; selected artifact cal@12.1.7-fg1) |
| `dash` | 1.0.19 | none | dash: shiro/wasi-packages.ts (wasm package; selected artifact dash@1.0.19) |
| `bash` | 1.0.25 | none | bash: shiro/commands/shell-builtins.ts (typescript; selected artifact bash@1.0.25) |
| `ruby` | 0.1.2 | `irb` | ruby: shiro/wasi-packages.ts (wasm package; selected artifact ruby@0.1.2); irb: shiro/wasi-packages.ts (wasm package; selected artifact ruby@0.1.2) |
| `php` | 8.3.403 | none | php: shiro/wasi-packages.ts (wasm package; selected artifact php@8.3.403) |
| `openssl` | 0.2.0 | none | openssl: shiro/commands/openssl.ts (adapter; selected artifact openssl@0.2.0) |
| `wabt` | 1.0.37 | `wat2wasm`, `wasm2wat`, `wasm-validate`, `wasm-strip` | wabt: shiro/commands/index.ts (adapter; family launcher); wat2wasm: shiro/wasi-packages.ts (wasm package; selected artifact wabt@1.0.37); wasm2wat: shiro/wasi-packages.ts (wasm package; selected artifact wabt@1.0.37); wasm-validate: shiro/wasi-packages.ts (wasm package; selected artifact wabt@1.0.37); wasm-strip: shiro/wasi-packages.ts (wasm package; selected artifact wabt@1.0.37) |
| `brotli` | 0.0.1 | none | brotli: shiro/wasi-packages.ts (wasm package; selected artifact brotli@0.0.1) |
| `uuid` | 0.3.0 | none | uuid: shiro/wasi-packages.ts (wasm package; selected artifact uuid@0.3.0) |
| `qr2text` | 0.0.1 | none | qr2text: shiro/wasi-packages.ts (wasm package; selected artifact qr2text@0.0.1) |
| `optipng` | 0.1.2 | none | optipng: shiro/wasi-packages.ts (wasm package; selected artifact optipng@0.1.2) |

### Family dispatch

| Family | Entrypoint | Selected artifact / atom |
|---|---|---|
| util-linux | hexdump | hexdump@2.37.2-fg1 / hexdump |
| util-linux | cal | cal@12.1.7-fg1 / cal |
| util-linux | rev | rev@2.37.2-fg1 / rev |
| wabt | wat2wasm | wabt@1.0.37 / wat2wasm |
| wabt | wasm2wat | wabt@1.0.37 / wasm2wat |
| wabt | wasm-validate | wabt@1.0.37 / wasm-validate |
| wabt | wasm-strip | wabt@1.0.37 / wasm-strip |

## Common names absent from the current surface

This candidate list is a documentation comparison, not another runtime registry. Names below have no catalog/parser/package entry; installed user scripts may still add them.

`chgrp`, `chroot`, `mkfifo`, `mknod`, `syncfs`, `install-info`, `ldconfig`, `ldd`, `readelf`, `objdump`, `strip`, `ar`, `as`, `ld`, `systemctl`, `service`, `journalctl`, `dmesg`, `modprobe`, `lsmod`, `mount`, `umount`, `swapon`, `swapoff`, `sudo`, `su`, `passwd`, `useradd`, `userdel`, `groupadd`, `groups`, `who`, `w`, `last`, `login`, `ssh`, `scp`, `sftp`, `rsync`, `telnet`, `ftp`, `ping`, `traceroute`, `ip`, `ifconfig`, `ss`, `netstat`, `lsof`, `nc`, `netcat`, `tcpdump`, `git`, `svn`, `hg`, `docker`, `podman`, `kubectl`, `crontab`, `at`, `watchdog`, `ps`, `man`, `vi`, `nano`, `ed`, `top`, `pgrep`, `pkill`, `tput`, `stty`, `cc`, `gcc`, `ffmpeg`, `magick`, `psql`.

`make`, `chown`, `ln`, `col` and `ulimit` have explicit capability-only contracts. A listed name does not mean browser build execution, ownership changes, links or kernel limits are available.

## Removed command modules

The removal record contains hashes and import/caller evidence. Removed files are not described as existing unregistered implementations. Their names may remain active through another owner.

- `shiro/commands/cc.ts`
- `shiro/commands/ed.ts`
- `shiro/commands/export.ts`
- `shiro/commands/ffmpeg.ts`
- `shiro/commands/history.ts`
- `shiro/commands/jobs.ts`
- `shiro/commands/jseval/index.ts`
- `shiro/commands/listen.ts`
- `shiro/commands/lua.ts`
- `shiro/commands/magick.ts`
- `shiro/commands/man.ts`
- `shiro/commands/nano.ts`
- `shiro/commands/notify.ts`
- `shiro/commands/pgrep.ts`
- `shiro/commands/postgres.ts`
- `shiro/commands/ps.ts`
- `shiro/commands/source.ts`
- `shiro/commands/sqlite.ts`
- `shiro/commands/stty.ts`
- `shiro/commands/test.ts`
- `shiro/commands/top.ts`
- `shiro/commands/tput.ts`
- `shiro/commands/type.ts`
- `shiro/commands/vi.ts`
- `shiro/commands/wasi.ts`
- `shiro/commands/which.ts`
- `shiro/commands/x86.ts`
- `shiro/commands/xpkg.ts`
