# Archived v0.61 inventory

The text below records the original snapshot. Its registry, routes and file-presence claims are historical; consult the [generated current inventory](shiro-commands-v0.61.md) for the working tree. Historical line citations are retained for provenance.

# Shiro v0.61 command inventory

Date: 2026-10-03

This is the command surface assembled for the FreeGent-backed Shiro shell. “Supported” means registered by `shell-singleton.ts`, implemented directly in the shell executor, or present in Shiro’s WASI package manifest. A command file elsewhere under `shiro/commands/` is not necessarily active.

## How a command is executed

1. `shell.ts` parses shell syntax and handles special forms such as `[[ ... ]]` and `/bin/sh -c ...`.
2. Shell functions and registered commands are checked first. The active registry is assembled in `shell-singleton.ts` from `unix.ts`, shell builtins, Shiro commands, and an explicit extra-command list.
3. If no registered command matches, Shiro searches `PATH` for a script, WASI package stub, or `.wasm` binary.
4. If there is no executable in `PATH`, Shiro checks the WASI manifest. A match is downloaded, cached in IndexedDB, compiled, and run through the WASI runtime. The runtime is hosted in a Worker when available. WASI programs that `exec` another command are routed back through Shiro’s command dispatcher.

Key code: [shell.ts command dispatch](../shiro/shell.ts:2394), [shell.ts WASI execution](../shiro/shell.ts:5757), [shell-singleton.ts registry](../shiro/shell-singleton.ts:41), [WASI package manifest](../shiro/wasi-packages.ts:35), [WASI host](../shiro/wasi-host.ts:1).

## Shell language and builtins

These are implemented by Shiro’s TypeScript shell, rather than launched as Unix binaries. Shell grammar, expansion, control flow, and many special forms live in `shell.ts`; command-style builtins live in `commands/shell-builtins.ts` and the Unix command barrel.

`!`, `[[`, `((...))`, `[`, `alias`, `caller`, `command`, `cd`, `case`/`esac`, `declare`/`typeset`, `do`/`done`, `elif`/`else`/`fi`/`if`/`then`, `eval`, `exit`, `export`, `for`/`in`, `function`, `hash`, `help`, `local`, `read`, `readonly`, `return`, `set`, `shift`, `sh`/`bash`, `shopt`, `source`/`.`, `time`, `type`, `ulimit`, `umask`, `unalias`, `unset`, `until`, and `while`.

This is a Bash-like interpreter, not GNU Bash. In particular, `bash` and `sh` invoke Shiro’s own interpreter. `/bin/bash`, `/bin/sh`, and `/bin/zsh` forms are also dispatched internally. The GNU Bash and Dash WASI entries below do not take over those registered names.

## Manually implemented and registered commands

These run FreeGent/Shiro TypeScript implementations, not the matching WASI binary. Files are under `shiro/commands/`; `unix.ts` is the main Unix command list. The order in `shell-singleton.ts` matters: later registrations replace earlier commands with the same name.

| Group | Registered commands |
|---|---|
| Files and directories | `basename`, `cat`, `chmod`, `chown`, `cp`, `dd`, `df`, `dirname`, `du`, `find`, `install`, `ln`, `ls`, `mkdir`, `mktemp`, `mv`, `pwd`, `readlink`, `realpath`, `rm`, `rmdir`, `stat`, `touch` |
| Text, search, and comparison | `awk`, `cmp`, `column`, `comm`, `csplit`, `cut`, `diff`, `egrep`, `expand`, `fmt`, `fold`, `grep`, `head`, `join`, `jq`, `nl`, `od`, `paste`, `pr`, `printf`, `rg`, `sed`, `sort`, `split`, `strings`, `tac`, `tail`, `tee`, `tr`, `tsort`, `unexpand`, `uniq`, `wc`, `xargs`, `xxd` |
| Archives, compression, and encoding | `base32`, `base64`, `bzip2`, `bunzip2`, `bzcat`, `cksum`, `dos2unix`, `gunzip`, `gzip`, `iconv`, `md5sum`, `sha1sum`, `sha256sum`, `sha384sum`, `sha512sum`, `shasum`, `sum`, `tar`, `unix2dos`, `unzip`, `xz`, `xzcat`, `unxz`, `zip`, `zcat`, `zstd`, `zstdcat`, `unzstd` |
| System and utilities | `clear`, `date`, `echo`, `env`, `expr`, `factor`, `false`, `file`, `free`, `getconf`, `hexdump`, `hostname`, `id`, `kill`, `make`, `nohup`, `nproc`, `numfmt`, `printenv`, `seq`, `sleep`, `sync`, `timeout`, `truncate`, `true`, `uname`, `uptime`, `uuidgen`, `watch`, `which`, `whoami`, `yes` |
| Shiro/browser integrations and language/tool wrappers | `curl`, `wget`, `glob`, `js-eval`, `node`, `python`, `python3`, `pip`, `pip3`, `npm`, `npx`, `pkg`, `pkg-config`, `open`, `xdg-open` |
| Less common but registered | `bc`, `dc`, `less`, `patch`, `rev`, `shuf` |

Some names in the table are shell keywords as well as registered commands. Some implementations are compatibility subsets, not full GNU/POSIX replacements. The table records command availability, not complete option compatibility. `grep`, `sed`, `diff`, and `rev` are registered more than once; the later registration wins. In practice `grep` and `sed` are Shiro’s TypeScript implementations even though matching WASI packages exist.

## Precompiled WASI packages

These are external precompiled programs declared in `wasi-packages.ts` and installed on demand. They are not TypeScript command implementations.

| Package | Manifest aliases / notes |
|---|---|
| `coreutils` | uutils multicall package; declared aliases: `gls`, `gcat`, `ghead`, `gtail`, `gwc`, `gsort`, `guniq`, `gbase64`, `ghashsum` |
| `grep` | GNU grep; alias `wasm-grep` |
| `sed` | GNU sed; alias `wasm-sed` |
| `util-linux` | Includes `hexdump`, `cal`, `rev`, `col`; manifest aliases include `hexdump`, `cal`, `rev` |
| `bash` | GNU Bash; registered `bash` name normally resolves to Shiro’s own shell command |
| `dash` | Debian Almquist shell |
| `quickjs` | alias `qjs` |
| `lua` | Lua interpreter |
| `ruby` | alias `irb` |
| `php` | PHP 8.3 |
| `sqlite` | alias `sqlite3` |
| `openssl` | OpenSSL command-line toolkit |
| `wabt` | aliases `wat2wasm`, `wasm2wat`, `wasm-validate`, `wasm-strip` |
| `brotli` | Brotli compressor/decompressor |
| `uuid` | v1/v4 UUID utility |
| `qr2text` | QR code to ASCII text |
| `optipng` | PNG optimizer |
| `viu` | Terminal image viewer |
| `cowsay`, `fortune`, `lolcat`, `figlet` | Terminal/demo utilities |

Package availability is name/alias based. The manifest’s `coreutils` description mentions 90+ applets, but only the listed `g*` names are declared as aliases; other applets can be invoked through the `coreutils` multicall package if supported by that binary. A registered TypeScript command shadows a same-named package command. Thus the normal `grep`, `sed`, `hexdump`, and `rev` names resolve to TypeScript implementations; `wasm-grep`, `wasm-sed`, `cal`, or `coreutils ...` provide package routes where applicable. `col` is described as part of `util-linux` but is not declared as an alias; invoke the package as `util-linux col ...` if that applet is present.

## Common Unix commands without a direct Shiro command

“No direct command” means no active TypeScript registration and no same-named WASI manifest package/alias. Some of these may be approximated by shell syntax, another utility, a user-installed script, or an explicitly invoked multicall package; they are not exposed as their usual command name by the built-in registry.

| Command(s) | Status |
|---|---|
| `chgrp`, `chroot`, `mkfifo`, `mknod`, `syncfs` | No direct registered command or matching WASI entry. `coreutils` may provide some applets when invoked explicitly. |
| `install-info`, `ldconfig`, `ldd`, `readelf`, `objdump`, `strip`, `ar`, `as`, `ld` | No direct command/package entry. `wabt` covers WebAssembly tools, not the general ELF/binutils suite. |
| `systemctl`, `service`, `journalctl`, `dmesg`, `modprobe`, `lsmod`, `mount`, `umount`, `swapon`, `swapoff` | Unsupported: these require host OS/service/kernel control unavailable to the browser workspace. |
| `sudo`, `su`, `passwd`, `useradd`, `userdel`, `groupadd`, `groups`, `who`, `w`, `last`, `login` | No direct implementation; there is no host account/privilege database for the browser shell to manage. |
| `ssh`, `scp`, `sftp`, `rsync`, `telnet`, `ftp`, `ping`, `traceroute`, `ip`, `ifconfig`, `ss`, `netstat`, `lsof`, `nc`/`netcat`, `tcpdump` | No direct command/package entry. `curl`/`wget` are implemented, but do not provide these protocols or host networking tools. |
| `git`, `svn`, `hg`, `docker`, `podman`, `kubectl`, `crontab`, `at`, `watchdog`, `ps` | No direct Shiro command or matching package in this manifest. |
| `man` | A `man.ts` implementation exists in the tree but is not registered by `shell-singleton.ts`; treat it as unavailable in the default shell. |
| `vi`, `nano`, `ed`, `top`, `pgrep`, `pkill`, `tput`, `stty`, `cc`, `gcc`, `ffmpeg`, `magick`, `psql` | Source files exist for some of these, but the singleton explicitly does not register terminal/process-table commands such as `vi`, `tput`, `stty`, `pgrep`, and `pkill`. `ed`, `nano`, `top`, `cc`, `gcc`, `ffmpeg`, `magick`, and `psql` are also not in its active registration list. The WASI `viu` package is an image viewer, not `vi`. |

The “unsupported” list is a practical set of common Linux/Unix commands, not a claim that every vendor-specific command is covered. To classify another name, check the active registrations in `shell-singleton.ts`, direct parser/builtin handling in `shell.ts`, and exact package names/aliases in `wasi-packages.ts`.

## v0.61 benchmark command usage

I inspected the v0.61 benchmark event logs and extracted `execute_code(language="bash")` calls from all 853 event-log files. These calls ran in the benchmarks’ native shell environments; the support classification below is against Shiro’s active command registry and WASI manifest. It indicates command names unavailable in Shiro, even if the native benchmark container had them.

There were 6,627 Bash tool calls and approximately 11,429 parsed command invocations. Compound commands and pipelines count each simple command position separately. The extraction is lexical rather than a full Bash AST parse: it skips comments and here-doc bodies, but can miss commands nested in substitutions or embedded in another language. Final commands returned for grading are not included.

Most frequent parsed commands:

| Command | Invocations |
|---|---:|
| `python3` | 2,378 |
| `curl` | 1,707 |
| `grep` | 1,154 |
| `cat` | 964 |
| `ls` | 900 |
| `find` | 852 |
| `mysql` | 406 |
| `export` | 380 |
| `sed` | 372 |
| `echo` | 321 |
| `pytest` | 257 |
| `head` | 245 |
| `pip3` | 216 |
| `git` | 174 |
| `cd` | 143 |

Observed command names unavailable in Shiro, with invocation counts:

| Command | Invocations | Command | Invocations |
|---|---:|---|---:|
| `mysql` | 406 | `pytest` | 257 |
| `git` | 174 | `cmake` | 67 |
| `apt-get` | 35 | `gcc` | 27 |
| `7z` | 23 | `pdflatex` | 22 |
| `ps` | 18 | `sudo` | 13 |
| `nc` | 7 | `service` | 3 |
| `psql` | 3 | `ffmpeg` | 3 |
| `docker` | 2 | `netstat` | 2 |
| `ss` | 2 | `perl` | 2 |
| `yt-dlp` | 2 | `whereis` | 1 |
| `vim` | 1 | `john` | 1 |

That is 22 distinct unsupported names and approximately 1,071 invocations. The dedicated InterCode Bash logs contained 195 parsed command invocations; `whereis` was the only unsupported name found in that subset. Most unsupported usage came from other benchmark suites, including `mysql` in InterCode SQL and `git`, `cmake`, and `7z` in TerminalBench.

Since this v0.61 inventory was recorded, Shiro added `7z` as an on-demand WebAssembly command and `pytest` through its Pyodide runtime. The 23 `7z` and 257 `pytest` attempts remain classified as unsupported for the historical benchmark baseline above.

Source logs: [v0.61 benchmark run summary](../bench/run_all_output_v0.61_seed102.log), [InterCode SQL `mysql` attempt](../bench/logs/gemma-intercode-sql-v0.61/events/c52ddf65534b7b460muq82y3veb7fb4-1790900775212.jsonl), [TerminalBench `cmake` attempt](../bench/logs/gemma-terminalbench-v0.61/events/c52ddf65534b7b460muqne8rs4c3e55-1790926496488.jsonl), and [InterCode Bash `whereis` attempt](../bench/logs/gemma-intercode-bash-v0.61/events/51375c6b4f21672c0muq75wd3e63b14-1790899233304.jsonl).
