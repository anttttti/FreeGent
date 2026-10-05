# Generated Shiro implementation matrix

Regenerate: `npx tsx scripts/shiro-inventory.mjs --update-note`. Check: `npx tsx scripts/shiro-inventory.mjs --check`. Do not hand edit.

The matrix includes the generator hash and separately versioned coverage snapshot hash. Registration describes availability. Acceptance requires independent byte comparisons. Static reachability alone does not authorize deleting a file.

| Command | Default owner / route | Parity scope | Explicit package alternative | Native inputs |
|---|---|---|---|---:|
| `!` | shell grammar; shiro/shell.ts | bash |  | 2 |
| `.` | shell parser; shiro/shell.ts | bash |  | 2 |
| `((...))` | shell parser; shiro/shell.ts | bash |  | 2 |
| `[` | typescript; shiro/commands/posix-test.ts | bash |  | 3 |
| `[[` | shell grammar; shiro/shell.ts | bash |  | 2 |
| `7z` | typescript; shiro/commands/sevenzip.ts | bash |  | 4 |
| `alias` | shell parser; shiro/shell.ts | bash |  | 2 |
| `awk` | typescript; shiro/commands/awk.ts | bash |  | 6 |
| `base32` | typescript; shiro/commands/base32.ts | bash |  | 4 |
| `base64` | typescript; shiro/commands/base64.ts | bash |  | 4 |
| `basename` | typescript; shiro/commands/basename.ts | bash |  | 4 |
| `bash` | typescript; shiro/commands/shell-builtins.ts | bash | bash@1.0.25: bash; argv ["bash"] | 2 |
| `bc` | wasm; shiro/commands/bc.ts | bash | bc@1.07.1: bc; argv ["bc"] | 3 |
| `break` | shell parser; shiro/shell.ts | bash |  | 1 |
| `brotli` | wasm package; shiro/wasi-packages.ts | bash | brotli@0.0.1: brotli; argv ["brotli"] | 1 |
| `builtin` | shell parser; shiro/shell.ts | bash |  | 2 |
| `bunzip2` | typescript; shiro/commands/bzip2.ts | bash |  | 2 |
| `bzcat` | typescript; shiro/commands/bzip2.ts | bash |  | 2 |
| `bzip2` | typescript; shiro/commands/bzip2.ts | bash |  | 4 |
| `cal` | wasm package; shiro/wasi-packages.ts | bash | cal@12.1.7-fg1: cal; argv ["cal"] | 1 |
| `caller` | shell parser; shiro/shell.ts | bash |  | 1 |
| `case` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `cat` | typescript; shiro/commands/cat.ts | bash |  | 8 |
| `cd` | typescript; shiro/commands/shell-builtins.ts | bash |  | 2 |
| `chmod` | typescript; shiro/commands/chmod.ts | bash |  | 4 |
| `chown` | native-only; shiro/commands/chown.ts | capability-only |  | 2 |
| `cksum` | typescript; shiro/commands/cksum.ts | bash |  | 2 |
| `clear` | typescript; shiro/commands/clear.ts | bash |  | 11 |
| `cmp` | typescript; shiro/commands/text-utils.ts | bash |  | 3 |
| `col` | native-only; shiro/commands/shiro-cmds.ts | capability-only |  | 1 |
| `column` | typescript; shiro/commands/column.ts | bash |  | 2 |
| `comm` | typescript; shiro/commands/comm.ts | bash |  | 2 |
| `command` | shell parser; shiro/shell.ts | bash |  | 24 |
| `compgen` | shell parser; shiro/shell.ts | bash |  | 2 |
| `complete` | shell parser; shiro/shell.ts | bash |  | 2 |
| `compopt` | shell parser; shiro/shell.ts | bash |  | 1 |
| `continue` | shell parser; shiro/shell.ts | bash |  | 1 |
| `coproc` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `coreutils` | wasm package; shiro/wasi-packages.ts | bash | coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3: coreutils; argv ["coreutils"] | 1 |
| `cowsay` | wasm package; shiro/wasi-packages.ts | bash | cowsay@0.3.0-fg1: cowsay; argv ["cowsay"] | 1 |
| `cp` | typescript; shiro/commands/cp.ts | bash |  | 4 |
| `csplit` | typescript; shiro/commands/csplit.ts | bash |  | 3 |
| `curl` | typescript; shiro/commands/curl.ts | bash |  | 12 |
| `cut` | typescript; shiro/commands/cut.ts | bash |  | 4 |
| `dash` | wasm package; shiro/wasi-packages.ts | bash | dash@1.0.19: dash; argv ["dash"] | 1 |
| `date` | typescript; shiro/commands/date.ts | bash |  | 4 |
| `dc` | wasm; shiro/commands/dc.ts | bash | dc@1.07.1: dc; argv ["dc"] | 3 |
| `dd` | typescript; shiro/commands/dd.ts | bash |  | 4 |
| `declare` | shell parser; shiro/shell.ts | bash |  | 2 |
| `df` | typescript; shiro/commands/df.ts | bash |  | 2 |
| `diff` | typescript; shiro/commands/diff.ts | bash |  | 3 |
| `dirname` | typescript; shiro/commands/dirname.ts | bash |  | 4 |
| `dirs` | shell parser; shiro/shell.ts | bash |  | 1 |
| `disown` | shell parser; shiro/shell.ts | bash |  | 1 |
| `do` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `done` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `dos2unix` | typescript; shiro/commands/line-endings.ts | bash |  | 2 |
| `du` | typescript; shiro/commands/du.ts | bash |  | 4 |
| `echo` | typescript; shiro/commands/echo.ts | bash |  | 4 |
| `egrep` | typescript; shiro/commands/index.ts (catalog identity; candidate declarations listed) | bash |  | 2 |
| `elif` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `else` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `enable` | shell parser; shiro/shell.ts | bash |  | 1 |
| `env` | typescript; shiro/commands/env.ts | bash |  | 3 |
| `esac` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `eval` | shell parser; shiro/shell.ts | bash |  | 2 |
| `exec` | shell parser; shiro/shell.ts | bash |  | 2 |
| `exit` | typescript; shiro/commands/exit.ts | bash |  | 2 |
| `expand` | typescript; shiro/commands/expand.ts | bash |  | 2 |
| `export` | shell parser; shiro/shell.ts | bash |  | 2 |
| `expr` | typescript; shiro/commands/expr.ts | bash |  | 4 |
| `factor` | typescript; shiro/commands/factor.ts | bash |  | 3 |
| `false` | typescript; shiro/commands/false.ts | bash |  | 1 |
| `fc` | shell parser; shiro/shell.ts | bash |  | 1 |
| `fgrep` | typescript; shiro/commands/index.ts (catalog identity; candidate declarations listed) | bash |  | 2 |
| `fi` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `figlet` | wasm package; shiro/wasi-packages.ts | bash | figlet@0.0.1: figlet; argv ["figlet"] | 1 |
| `file` | typescript; shiro/commands/file.ts | bash |  | 3 |
| `find` | typescript; shiro/commands/find.ts | bash |  | 5 |
| `fmt` | typescript; shiro/commands/fmt.ts | bash |  | 2 |
| `fold` | typescript; shiro/commands/fold.ts | bash |  | 2 |
| `for` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `fortune` | wasm package; shiro/wasi-packages.ts | bash | fortune@0.2.0: fortune; argv ["fortune"] | 1 |
| `free` | typescript; shiro/commands/free.ts | bash |  | 2 |
| `function` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `gbase64` | wasm package; shiro/wasi-packages.ts | bash | coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3: coreutils; argv ["coreutils","base64"] | 2 |
| `gcat` | wasm package; shiro/wasi-packages.ts | bash | coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3: coreutils; argv ["coreutils","cat"] | 2 |
| `getconf` | typescript; shiro/commands/getconf.ts | bash |  | 2 |
| `getopts` | shell parser; shiro/shell.ts | bash |  | 2 |
| `ghashsum` | wasm package; shiro/wasi-packages.ts | bash | coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3: coreutils; argv ["coreutils","sha256sum"] | 2 |
| `ghead` | wasm package; shiro/wasi-packages.ts | bash | coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3: coreutils; argv ["coreutils","head"] | 2 |
| `glob` | typescript; shiro/commands/glob.ts | bash |  | 2 |
| `gls` | wasm package; shiro/wasi-packages.ts | bash | coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3: coreutils; argv ["coreutils","ls"] | 2 |
| `grep` | typescript; shiro/commands/grep.ts | bash | grep@3.12.0: grep; argv ["grep"] | 12 |
| `gsort` | wasm package; shiro/wasi-packages.ts | bash | coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3: coreutils; argv ["coreutils","sort"] | 2 |
| `gtail` | wasm package; shiro/wasi-packages.ts | bash | coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3: coreutils; argv ["coreutils","tail"] | 2 |
| `guniq` | wasm package; shiro/wasi-packages.ts | bash | coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3: coreutils; argv ["coreutils","uniq"] | 2 |
| `gunzip` | typescript; shiro/commands/gzip.ts | bash |  | 2 |
| `gwc` | wasm package; shiro/wasi-packages.ts | bash | coreutils@a6d1eb3835c0f808fa9678e4551df7377bcab8d3: coreutils; argv ["coreutils","wc"] | 2 |
| `gzip` | typescript; shiro/commands/gzip.ts | bash |  | 4 |
| `hash` | shell parser; shiro/shell.ts | bash |  | 22 |
| `head` | typescript; shiro/commands/head.ts | bash |  | 4 |
| `help` | typescript; shiro/commands/shell-builtins.ts | bash |  | 1 |
| `hexdump` | wasm; shiro/commands/unix.ts | bash | hexdump@2.37.2-fg1: hexdump; argv ["hexdump"] | 27 |
| `hostname` | typescript; shiro/commands/shiro-cmds.ts | bash |  | 1 |
| `iconv` | typescript; shiro/commands/iconv.ts | bash |  | 3 |
| `id` | typescript; shiro/commands/id.ts | bash |  | 3 |
| `if` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `in` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `install` | typescript; shiro/commands/install.ts | bash |  | 3 |
| `irb` | wasm package; shiro/wasi-packages.ts | bash | ruby@0.1.2: ruby; argv ["ruby","-rirb","-e","IRB.start","--"] | 1 |
| `join` | typescript; shiro/commands/join.ts | bash |  | 3 |
| `jq` | wasm; shiro/commands/jq.ts | bash | jq@1.8.2: jq; argv ["jq"] | 27 |
| `js-eval` | typescript; shiro/commands/jseval/js-eval-cmd.ts | bash |  | 2 |
| `kill` | typescript; shiro/commands/trap.ts | bash |  | 3 |
| `less` | typescript; shiro/commands/less.ts | bash |  | 9 |
| `let` | shell parser; shiro/shell.ts | bash |  | 2 |
| `ln` | native-only; shiro/commands/shiro-cmds.ts | capability-only |  | 3 |
| `local` | shell parser; shiro/shell.ts | bash |  | 2 |
| `lolcat` | wasm package; shiro/wasi-packages.ts | bash | lolcat@0.2.0: lolcat; argv ["lolcat"] | 1 |
| `ls` | typescript; shiro/commands/ls.ts | bash |  | 8 |
| `lua` | wasm package; shiro/wasi-packages.ts | bash | lua@5.3.6: lua; argv ["lua"] | 12 |
| `make` | native-only; shiro/commands/make.ts | capability-only |  | 3 |
| `mapfile` | shell parser; shiro/shell.ts | bash |  | 2 |
| `md5sum` | typescript; shiro/commands/index.ts (catalog identity; candidate declarations listed) | bash |  | 3 |
| `mkdir` | typescript; shiro/commands/mkdir.ts | bash |  | 4 |
| `mktemp` | typescript; shiro/commands/mktemp.ts | bash |  | 4 |
| `mv` | typescript; shiro/commands/mv.ts | bash |  | 3 |
| `nl` | typescript; shiro/commands/nl.ts | bash |  | 3 |
| `node` | typescript; shiro/commands/jseval/node-cmd.ts | bash |  | 3 |
| `nohup` | typescript; shiro/commands/nohup.ts | bash |  | 2 |
| `npm` | typescript; shiro/commands/npm.ts | bash |  | 1 |
| `nproc` | typescript; shiro/commands/nproc.ts | bash |  | 1 |
| `npx` | typescript; shiro/commands/npx.ts | bash |  | 1 |
| `numfmt` | typescript; shiro/commands/numfmt.ts | bash |  | 3 |
| `od` | typescript; shiro/commands/od.ts | bash |  | 3 |
| `open` | typescript; shiro/commands/shiro-cmds.ts | integration-only |  | 2 |
| `openssl` | adapter; shiro/commands/openssl.ts | bash | openssl@0.2.0: openssl; argv ["openssl"] | 5 |
| `optipng` | wasm package; shiro/wasi-packages.ts | bash | optipng@0.1.2: optipng; argv ["optipng"] | 1 |
| `paste` | typescript; shiro/commands/paste.ts | bash |  | 3 |
| `patch` | typescript; shiro/commands/patch.ts | bash |  | 2 |
| `php` | wasm package; shiro/wasi-packages.ts | bash | php@8.3.403: php; argv ["php"] | 2 |
| `pip` | typescript; shiro/commands/python.ts | bash |  | 1 |
| `pip3` | typescript; shiro/commands/python.ts | bash |  | 1 |
| `pkg` | typescript; shiro/commands/pkg.ts | integration-only |  | 3 |
| `pkg-config` | typescript; shiro/commands/pkg-config.ts | bash |  | 3 |
| `popd` | shell parser; shiro/shell.ts | bash |  | 1 |
| `pr` | typescript; shiro/commands/pr.ts | bash |  | 3 |
| `printenv` | typescript; shiro/commands/printenv.ts | bash |  | 2 |
| `printf` | typescript; shiro/commands/printf.ts | bash |  | 6 |
| `pushd` | shell parser; shiro/shell.ts | bash |  | 1 |
| `pwd` | typescript; shiro/commands/pwd.ts | bash |  | 2 |
| `pytest` | typescript; shiro/commands/python.ts | bash |  | 1 |
| `python` | typescript; shiro/commands/python.ts | bash |  | 4 |
| `python3` | typescript; shiro/commands/python.ts | bash |  | 5 |
| `qjs` | wasm package; shiro/wasi-packages.ts | bash | quickjs@0.0.3: quickjs; argv ["quickjs"] | 2 |
| `qr2text` | wasm package; shiro/wasi-packages.ts | bash | qr2text@0.0.1: qr2text; argv ["qr2text"] | 1 |
| `quickjs` | wasm package; shiro/wasi-packages.ts | bash | quickjs@0.0.3: quickjs; argv ["quickjs"] | 2 |
| `read` | shell parser; shiro/shell.ts | bash |  | 2 |
| `readarray` | shell parser; shiro/shell.ts | bash |  | 2 |
| `readlink` | typescript; shiro/commands/readlink.ts | bash |  | 4 |
| `readonly` | shell parser; shiro/shell.ts | bash |  | 3 |
| `realpath` | typescript; shiro/commands/realpath.ts | bash |  | 4 |
| `return` | shell parser; shiro/shell.ts | bash |  | 2 |
| `rev` | wasm; shiro/commands/unix.ts | bash | rev@2.37.2-fg1: rev; argv ["rev"] | 18 |
| `rg` | typescript; shiro/commands/rg.ts | bash |  | 6 |
| `rm` | typescript; shiro/commands/shiro-cmds.ts | bash |  | 4 |
| `rmdir` | typescript; shiro/commands/shiro-cmds.ts | bash |  | 3 |
| `ruby` | wasm package; shiro/wasi-packages.ts | bash | ruby@0.1.2: ruby; argv ["ruby"] | 2 |
| `sed` | typescript; shiro/commands/sed.ts | bash | sed@4.9.0: sed; argv ["sed"] | 8 |
| `seq` | typescript; shiro/commands/seq.ts | bash |  | 4 |
| `set` | shell parser; shiro/shell.ts | bash |  | 2 |
| `setopt` | shell parser; shiro/shell.ts | bash |  | 1 |
| `sh` | typescript; shiro/commands/shell-builtins.ts | bash |  | 2 |
| `sha1sum` | typescript; shiro/commands/index.ts (catalog identity; candidate declarations listed) | bash |  | 3 |
| `sha256sum` | typescript; shiro/commands/index.ts (catalog identity; candidate declarations listed) | bash |  | 3 |
| `sha384sum` | typescript; shiro/commands/index.ts (catalog identity; candidate declarations listed) | bash |  | 3 |
| `sha512sum` | typescript; shiro/commands/index.ts (catalog identity; candidate declarations listed) | bash |  | 3 |
| `shasum` | typescript; shiro/commands/shiro-cmds.ts | bash |  | 5 |
| `shift` | shell parser; shiro/shell.ts | bash |  | 2 |
| `shopt` | shell parser; shiro/shell.ts | bash |  | 2 |
| `shuf` | typescript; shiro/commands/text-utils.ts | bash |  | 4 |
| `sleep` | typescript; shiro/commands/sleep.ts | bash |  | 3 |
| `sort` | typescript; shiro/commands/sort.ts | bash |  | 7 |
| `source` | shell parser; shiro/shell.ts | bash |  | 2 |
| `split` | typescript; shiro/commands/split.ts | bash |  | 3 |
| `sqlite` | wasm package; shiro/wasi-packages.ts | bash | sqlite@0.2.2: sqlite; argv ["sqlite"] | 3 |
| `sqlite3` | wasm package; shiro/wasi-packages.ts | bash | sqlite@0.2.2: sqlite; argv ["sqlite"] | 3 |
| `stat` | typescript; shiro/commands/stat.ts | bash |  | 4 |
| `strings` | typescript; shiro/commands/strings.ts | bash |  | 2 |
| `sum` | typescript; shiro/commands/sum.ts | bash |  | 3 |
| `sync` | typescript; shiro/commands/extras.ts | bash |  | 2 |
| `tac` | typescript; shiro/commands/text-utils.ts | bash |  | 3 |
| `tail` | typescript; shiro/commands/tail.ts | bash |  | 4 |
| `tar` | typescript; shiro/commands/tar.ts | bash |  | 5 |
| `tee` | typescript; shiro/commands/tee.ts | bash |  | 2 |
| `test` | typescript; shiro/commands/posix-test.ts | bash |  | 2 |
| `then` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `time` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `timeout` | typescript; shiro/commands/timeout.ts | bash |  | 2 |
| `touch` | typescript; shiro/commands/touch.ts | bash |  | 3 |
| `tr` | typescript; shiro/commands/tr.ts | bash |  | 4 |
| `trap` | shell parser; shiro/shell.ts | bash |  | 2 |
| `true` | typescript; shiro/commands/true.ts | bash |  | 1 |
| `truncate` | typescript; shiro/commands/extras.ts | bash |  | 3 |
| `tsort` | typescript; shiro/commands/tsort.ts | bash |  | 3 |
| `type` | shell parser; shiro/shell.ts | bash |  | 24 |
| `typeset` | shell parser; shiro/shell.ts | bash |  | 2 |
| `ulimit` | shell parser; shiro/shell.ts | capability-only |  | 2 |
| `umask` | shell parser; shiro/shell.ts | bash |  | 7 |
| `unalias` | shell parser; shiro/shell.ts | bash |  | 1 |
| `uname` | typescript; shiro/commands/shiro-cmds.ts | bash |  | 2 |
| `unexpand` | typescript; shiro/commands/unexpand.ts | bash |  | 2 |
| `uniq` | typescript; shiro/commands/uniq.ts | bash |  | 4 |
| `unix2dos` | typescript; shiro/commands/line-endings.ts | bash |  | 1 |
| `unset` | shell parser; shiro/shell.ts | bash |  | 2 |
| `until` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `unxz` | typescript; shiro/commands/xz.ts | bash |  | 2 |
| `unzip` | typescript; shiro/commands/zip.ts | bash |  | 3 |
| `unzstd` | wasm; shiro/commands/zstd.ts | bash | zstd@1.4.8: zstd; argv ["zstd","-d"] | 2 |
| `uptime` | typescript; shiro/commands/uptime.ts | bash |  | 1 |
| `util-linux` | adapter; shiro/commands/index.ts | bash | util-linux@: declared subcommand launcher; argv [null] | 5 |
| `uuid` | wasm package; shiro/wasi-packages.ts | bash | uuid@0.3.0: uuid; argv ["uuid"] | 1 |
| `uuidgen` | typescript; shiro/commands/extras.ts | bash |  | 2 |
| `viu` | wasm package; shiro/wasi-packages.ts | bash | viu@0.2.3: viu; argv ["viu"] | 1 |
| `wabt` | adapter; shiro/commands/index.ts | bash | wabt@: declared subcommand launcher; argv [null] | 1 |
| `wasm-grep` | wasm package; shiro/wasi-packages.ts | bash | grep@3.12.0: grep; argv ["grep"] | 2 |
| `wasm-sed` | wasm package; shiro/wasi-packages.ts | bash | sed@4.9.0: sed; argv ["sed"] | 2 |
| `wasm-strip` | wasm package; shiro/wasi-packages.ts | bash | wabt@1.0.37: wasm-strip; argv ["wasm-strip"] | 1 |
| `wasm-validate` | wasm package; shiro/wasi-packages.ts | bash | wabt@1.0.37: wasm-validate; argv ["wasm-validate"] | 1 |
| `wasm2wat` | wasm package; shiro/wasi-packages.ts | bash | wabt@1.0.37: wasm2wat; argv ["wasm2wat"] | 1 |
| `wat2wasm` | wasm package; shiro/wasi-packages.ts | bash | wabt@1.0.37: wat2wasm; argv ["wat2wasm"] | 1 |
| `watch` | typescript; shiro/commands/watch.ts | bash |  | 1 |
| `wc` | typescript; shiro/commands/wc.ts | bash |  | 5 |
| `wget` | typescript; shiro/commands/curl.ts | bash |  | 5 |
| `which` | typescript; shiro/commands/shiro-cmds.ts | bash |  | 2 |
| `while` | shell grammar; shiro/shell.ts | bash |  | 1 |
| `whoami` | typescript; shiro/commands/whoami.ts | bash |  | 1 |
| `xargs` | typescript; shiro/commands/xargs.ts | bash |  | 4 |
| `xdg-open` | typescript; shiro/commands/shiro-cmds.ts | integration-only |  | 2 |
| `xxd` | typescript; shiro/commands/xxd.ts | bash |  | 3 |
| `xz` | typescript; shiro/commands/xz.ts | bash |  | 4 |
| `xzcat` | typescript; shiro/commands/xz.ts | bash |  | 2 |
| `yes` | typescript; shiro/commands/yes.ts | bash |  | 2 |
| `zcat` | typescript; shiro/commands/index.ts (catalog identity; candidate declarations listed) | bash |  | 2 |
| `zip` | typescript; shiro/commands/zip.ts | bash |  | 2 |
| `zstd` | wasm; shiro/commands/zstd.ts | bash | zstd@1.4.8: zstd; argv ["zstd"] | 10 |
| `zstdcat` | wasm; shiro/commands/zstd.ts | bash | zstd@1.4.8: zstd; argv ["zstd","-dc"] | 2 |

## Command files outside the recorded execution import closure

These files require checking other entrypoints and dynamic consumers before deletion.


## Artifact identities

| Package | Version | Bytes | SHA-256 | Named atoms | Resources |
|---|---|---:|---|---|---:|
| hexdump | 2.37.2-fg1 | 426420 | c1d430c483e6b256adf55398ae5bbe24dc920f5a3f87660ed76733f325453381 | hexdump | 0 |
| rev | 2.37.2-fg1 | 303780 | f16932cc2f3946a997e6d725042dd8a4bf1da4a7c915632d1c9156f8dfbb4bf5 | rev | 0 |
| cal | 12.1.7-fg1 | 389040 | 36bb2a5e5fc4c3a4e7c59ced38a30799e32d57d6440faeb311880fce791507c0 | cal | 0 |
| bc | 1.07.1 | 360751 | f2da8c5f7a05fbb76a90f745835abf343f88c908873f99953972ba855960d8ca | bc | 0 |
| dc | 1.07.1 | 334804 | 29d781630c8f34cb8d9ead76d9e9a275c0979c622350d565a357f517bf2d2b14 | dc | 0 |
| cowsay | 0.3.0-fg1 | 432352 | a2e3295a5dd39bdc39e23c6e9f88187af25e518cc8dbfb1a8fffeda7a2f2d12f | cowsay | 0 |
| fortune | 0.2.0 | 2416516 | 59c02fd68e98da2c445ee8e97098aff1038ef7aa237601b2a099e734a99ef49d | fortune | 1 |
| lolcat | 0.2.0 | 2131185 | b867558fee3734d9c77a9bdc38abcfc0793bfbad0e901639a192641d5a34bdb7 | lolcat | 1 |
| figlet | 0.0.1 | 769349 | 9fc959de4ce58c6c2bc11b8cbaa0a1a471bcde84a0fe341cffc25a42251d91c9 | chkfont, figlet | 58 |
| coreutils | a6d1eb3835c0f808fa9678e4551df7377bcab8d3 | 12964555 | c53b61ad7d6f3b1231b8c38d8d9566ec649b0ba0b8da9d7952d1825886efc927 | coreutils | 0 |
| grep | 3.12.0 | 364536 | 42a2dd5452990c94a51036cfb5eb9574899beccb5ce8f83f75995f7ac5e0e1ca | grep | 0 |
| sed | 4.9.0 | 262523 | 3fc12256be87f6b8b7810d68d642359a6220f63b39a2ea6ef7a2bb6d79ec1393 | sed | 0 |
| jq | 1.8.2 | 1535250 | 162db948e4432c35849670c36ab09127880d2b808c63fd796207d0e25b11d552 | jq | 0 |
| zstd | 1.4.8 | 950591 | a969524aea789aa933186008c12f4ff3031e07292b3ca9dc500941c3fa837a9d | zstd | 0 |
| quickjs | 0.0.3 | 2565315 | 430237aeffc912f4cd0981eb03ebad42a71d6b62781bd0c01903cae7d21b5733 | quickjs | 1 |
| lua | 5.3.6 | 646508 | 0c4b3ce2fd473db00ec01dd08eef759c2fee91ee564c8c6a229280d08be7ffb1 | lua | 0 |
| sqlite | 0.2.2 | 3575511 | 435044351ae60f7fd07ff97c1cac083f1e46d43bd9bc811b249bb376ee328725 | sqlite | 1 |
| viu | 0.2.3 | 3066430 | b988b51ee1a395853fa402f37d69d1b379c4441b3bfca7372876098e13d4e3e9 | viu | 1 |
| util-linux | 0.0.1 | 542738 | 3af9902aebda64554afa9b05c8726d3d183ba5c1ac57d902637e3894f3187c98 | cal, col, colcrt, hexdump, rev | 0 |
| dash | 1.0.19 | 335469 | c81513a53f11a2a23ea305fa008049d15fa1b5f52b696cedbf63554077ea5998 | dash | 1 |
| bash | 1.0.25 | 1870786 | 059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1 | bash | 0 |
| ruby | 0.1.2 | 34328971 | 036c313a707ffc5b70c700a9ac44e07bb76efe2797ef7f69c8f5d38fc6a080fc | ruby | 0 |
| php | 8.3.403 | 85700002 | da8d3fcfcf02d2401787532c4af3fdaf5b680b05144a9591ca70b97131ee2f32 | php | 284 |
| openssl | 0.2.0 | 1642434 | ac3a7fa2a57d384fa9e4b30c935a99fa323193cd1b7421bb899dfc2864ec43cc | openssl | 1 |
| wabt | 1.0.37 | 3420566 | 28b90a71338d161324ec4187d7afeb08df0eb98181e7e51c83f3f3f9a4cd1522 | wabt, wasm-interp, wasm-strip, wasm-validate, wasm2wat, wast2json, wat2wasm | 2 |
| brotli | 0.0.1 | 707459 | 824ad12803f95ed9a963f0e68df7ab3f1b875387f84417390ec73df52b3b2fb0 | brotli | 1 |
| uuid | 0.3.0 | 2425666 | bcfcf285510b75a47156a46c8103593a44047acf892114c83344138a0dc0effc | uuid | 1 |
| qr2text | 0.0.1 | 498852 | 3741fc7486de905f87bcf8829557260473b0b789c0ec362d9374fd36f4fb62c6 | qr2text | 0 |
| optipng | 0.1.2 | 230683 | ee84c20006bd67d128c67877c9ccaa8ba669a7cbd94ab225fafa241c5552ba8e | optipng | 1 |
