import type { FileSystem } from '../filesystem';
import type { Shell } from '../shell';

export interface TerminalLike {
  writeOutput(text: string): void;
  enterStdinPassthrough(cb: (data: string) => void, forceExitCb?: () => void): void;
  exitStdinPassthrough(): void;
  enterRawMode(cb: (key: string) => void): void;
  exitRawMode(): void;
  isRawMode(): boolean;
  onResize(cb: (cols: number, rows: number) => void): () => void;
  getSize(): { rows: number; cols: number };
  getBufferContent?(): string;
  term: any; // xterm.js Terminal instance
}

export interface CommandContext {
  args: string[];
  fs: FileSystem;
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  stdout: string;
  stderr: string;
  shell: Shell;
  terminal?: TerminalLike;
}

export interface Command {
  name: string;
  description: string;
  route?: 'adapter'|'wasm'|'native-only';
  /** Bash parity, a documented missing capability, or a browser integration contract. */
  parityScope?: 'bash'|'capability-only'|'integration-only';
  requirements?: string[];
  exec(ctx: CommandContext): Promise<number>;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(cmd: Command): void {
    if (this.commands.has(cmd.name)) throw new Error(`Duplicate command registration: ${cmd.name}`);
    this.commands.set(cmd.name, cmd);
  }

  registerAll(cmds: Command[]): void {
    for (const cmd of cmds) this.register(cmd);
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  list(): Command[] {
    return Array.from(this.commands.values());
  }
}

import { unixCommands } from './unix';
import { shellBuiltins } from './shell-builtins';
import { shiroCmds } from './shiro-cmds';
import { grepCmd } from './grep';
import { sedCmd } from './sed';
import { jqCmd } from './jq';
import { globCmd } from './glob';
import { jsEvalCmd } from './jseval';
import { nodeCmd } from './jseval/node-cmd';
import { pythonCmd, python3Cmd, pipCmd, pip3Cmd, pytestCmd } from './python';
import { curlCmd, wgetCmd } from './curl';
import { npmCmd } from './npm';
import { npxCmd } from './npx';
import { diffCmd } from './diff';
import { rgCmd } from './rg';
import { gzipCmd, gunzipCmd } from './gzip';
import { xzCmd, unxzCmd, xzcatCmd } from './xz';
import { zstdCmd, unzstdCmd, zstdcatCmd } from './zstd';
import { bzip2Cmd, bunzip2Cmd, bzcatCmd } from './bzip2';
import { mkTempCmd } from './mktemp';
import { pkgCmd } from './pkg';
import { sevenZipCmd } from './sevenzip';
import { openssl } from './openssl';
import { packageFamilyCommand } from '../wasi-packages';

/** One declared registry owner per name. CommandRegistry rejects duplicates. */
export const COMMAND_CATALOG = [
    ...unixCommands,
    ...shellBuiltins,
    ...shiroCmds,
    ...[grepCmd, sedCmd, globCmd, jsEvalCmd, nodeCmd, pythonCmd, python3Cmd, pipCmd, pip3Cmd, pytestCmd, curlCmd, wgetCmd],
    ...[npmCmd, npxCmd, diffCmd, jqCmd, rgCmd, gzipCmd, gunzipCmd, mkTempCmd,
        pkgCmd, sevenZipCmd, openssl, packageFamilyCommand('wabt'), packageFamilyCommand('util-linux'),
        xzCmd, unxzCmd, xzcatCmd, zstdCmd, unzstdCmd, zstdcatCmd, bzip2Cmd, bunzip2Cmd, bzcatCmd],
];
