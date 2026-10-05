import { FileSystem, withCreationMask } from './filesystem';
import type { CommandRegistry, CommandContext } from './commands/index';
import type { ShiroTerminal } from './terminal';
import { recordCommand } from './favicon';
import { isAvailableAsPackage, getCompiledModule, resolvePackageCommand, writePackageStubs, runPackageCommand } from './wasi-packages';
import { ereToJs } from './utils/posix-regex';
import { bytesToText, byteChar, normalizeBytes, textToBytes } from './utils/bytes';
import { filesystemError } from './commands/flags';
import { ULIMIT_UNAVAILABLE } from './commands/ulimit';
import { processUmask } from './commands/umask';

export const SHELL_KEYWORDS = ['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done',
      'in', 'function', 'time', '{', '}', '!', '[[', ']]', 'coproc'];
export const SHELL_BUILTINS = ['alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete', 'compopt',
      'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg',
      'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd',
      'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap',
      'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait', '.', ':', '['];

// Lazy-load the WASI runtime (~960 lines) only when WASM execution is needed
let _wasiRuntime: typeof import('./wasi-runtime') | null = null;
async function loadWasiRuntime() {
  if (!_wasiRuntime) _wasiRuntime = await import('./wasi-runtime');
  return _wasiRuntime;
}

interface Redirect {
  type: '>' | '>>' | '<' | '2>' | '2>>' | '2>&1' | '>&-' | '>&2';
  target: string;
  fd?: number;
}

export interface BackgroundJob {
  id: number;
  command: string;
  promise: Promise<number>;
  status: 'running' | 'done' | 'failed';
  exitCode: number;
  abortController?: AbortController;
}

// Env var names whose values should be masked in terminal output
const SECRET_ENV_KEYS = [
  'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY',
  'API_KEY', 'SECRET_KEY', 'ACCESS_TOKEN', 'AUTH_TOKEN',
];

interface CompletionSpec {
  options?: string[];
  words?: string[];
  funcName?: string;
  action?: string;
  prefix?: string;
  suffix?: string;
}

/** Sentinel thrown by `break [N]` inside loops */
class BreakSignal { constructor(public levels: number = 1) {} }
/** Sentinel thrown by `continue [N]` inside loops */
class ContinueSignal { constructor(public levels: number = 1) {} }
/** Sentinel thrown by `return [N]` inside functions */
class ReturnSignal { constructor(public code: number = 0) {} }

export class Shell {
  private static processSubstitutionSequence = 0;
  /** Loading status is UI information, never part of a program's byte streams. */
  onProgress?: (message: string) => void;
  fs: FileSystem;
  cwd: string = '/home/user';
  private envValues: Record<string,string> = {};
  private temporaryPath = false;
  get env(): Record<string,string> { return this.envValues; }
  set env(value:Record<string,string>) {
    this.commandHashes?.clear();
    this.envValues = new Proxy(value, {
      set:(target,key,value) => {
        if (key === 'PATH') this.commandHashes.clear();
        return Reflect.set(target,key,value);
      },
      deleteProperty:(target,key) => {
        if (key === 'PATH') this.commandHashes.clear();
        return Reflect.deleteProperty(target,key);
      },
    });
  }
  umask: number = 0o022;
  history: string[] = [];
  commands: CommandRegistry;
  lastExitCode: number = 0;
  functions: Record<string, { body: string; group?: 'brace' | 'subshell' }> = {};
  /** Hidden functions standing in for { } / ( ) groups (hoistGroups), by group text. */
  private groupFunctions = new Map<string, string>();
  /** Heredoc bodies inside joined blocks (heredocToHereString): quoted text ↔ placeholder. */
  private heredocNames = new Map<string, string>();
  private heredocBodies = new Map<string, string>();
  backgroundJobs: Map<number, BackgroundJob> = new Map();
  /** Shell options: errexit (-e), xtrace (-x), nounset (-u), verbose (-v) */
  options: Set<string> = new Set(['hashall']);
  /** Bash-style indexed arrays */
  arrays: Map<string, string[]> = new Map();
  /** Bash-style associative arrays (declare -A) */
  assocArrays: Map<string, Map<string, string>> = new Map();
  /** Trap handlers: signal → command string */
  traps: Map<string, string> = new Map();
  /** Shell aliases: name → replacement string */
  aliases: Map<string, string> = new Map();
  /** Namerefs: name → target variable name */
  namerefs: Map<string, string> = new Map();
  /** Directory stack for pushd/popd */
  dirStack: string[] = [];
  /** Local variable frames for function scoping — stack of {varName → savedValue|undefined} */
  private localVarStack: Map<string, string | undefined>[] = [];
  /** Readonly variable names */
  readonlyVars: Set<string> = new Set();
  /** Call stack for BASH_SOURCE/caller: {funcName, source} */
  callStack: { funcName: string; source: string }[] = [];
  /** Bash shopt options: extglob, nocaseglob, nullglob, dotglob, globstar, etc. */
  shoptopts: Set<string> = new Set();
  /** Programmable completion specs: command name → spec */
  completionSpecs: Map<string, CompletionSpec> = new Map();
  /** Builtins disabled via `enable -n` */
  disabledBuiltins: Set<string> = new Set();
  /** File descriptors for `read -u FD` and `exec N< file` */
  fileDescriptors: Map<number, { content: string; offset: number }> = new Map();
  /** Coproc state: { name, pid, output } */
  /** Abort controller for the currently running command (SIGINT) */
  abortController: AbortController | null = null;
  /** Current line number for LINENO tracking */
  currentLine: number = 1;
  /** Depth of execute() recursion — only top-level resets LINENO */
  private executeDepth: number = 0;
  private requestedExit: number | null = null;
  private stdoutFile: string | null = null;
  /** Terminate the current script, including enclosing functions and loops. */
  requestExit(status: number): void { this.requestedExit = status; }
  /** File writes of built-in output under > / >> (see execute), in order. */
  private redirectWrites: Promise<void> = Promise.resolve();
  private nextJobId = 1;
  private terminal?: ShiroTerminal;

  constructor(fs: FileSystem, commands: CommandRegistry) {
    this.fs = withCreationMask(fs,() => this.umask);
    this.commands = commands;
    this.env = {
      HOME: '/home/user',
      USER: 'user',
      SHELL: '/bin/sh',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      PWD: '/home/user',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
    };
    // Load history async (don't block construction)
    this.loadHistory();
  }

  private historyFile = '/home/user/.bash_history';
  private maxHistorySize = 1000;

  /** Load command history from ~/.bash_history */
  async loadHistory(): Promise<void> {
    try {
      const raw = await this.fs.readFile(this.historyFile);
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      this.history = content.split('\n')
        .map((line: string) => line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''))
        .filter((line: string) => line.trim());
      // Keep only the most recent entries
      if (this.history.length > this.maxHistorySize) {
        this.history = this.history.slice(-this.maxHistorySize);
      }
    } catch {
      // File doesn't exist yet, that's fine
      this.history = [];
    }
  }

  /** Save command history to ~/.bash_history */
  async saveHistory(): Promise<void> {
    try {
      // Keep only the most recent entries
      const toSave = this.history.slice(-this.maxHistorySize);
      await this.fs.writeFile(this.historyFile, toSave.join('\n') + '\n');
    } catch (err) {
      // Silently fail - history is nice to have but not critical
    }
  }

  /**
   * Set the terminal reference for interactive commands like vi.
   */
  setTerminal(terminal: ShiroTerminal): void {
    this.terminal = terminal;
    this.shoptopts.add('expand_aliases');
  }

  /**
   * Create a child shell that shares fs/commands but has its own cwd/env.
   * Used by spawn to isolate process state from the parent terminal.
   */
  /** Get positional parameters $1..$# as an array */
  private getPositionalArgs(): string[] {
    const count = parseInt(this.env['#'] || '0', 10);
    const args: string[] = [];
    for (let i = 1; i <= count; i++) args.push(this.env[String(i)] || '');
    return args;
  }

  /** Pop and restore local variable frame */
  private restoreLocalVars(): void {
    const frame = this.localVarStack.pop();
    if (!frame) return;
    for (const [varName, savedValue] of frame) {
      if (savedValue === undefined) delete this.env[varName];
      else this.env[varName] = savedValue;
    }
  }

  fork(): Shell {
    const child = new Shell(this.fs, this.commands);
    child.cwd = this.cwd;
    child.stdoutFile = this.stdoutFile;
    child.onProgress = this.onProgress;
    child.inheritedSignals = [...this.inheritedSignals];
    child.abortScopes = [...this.abortScopes];
    if (this.abortController) child.abortScopes.push(this.abortController);
    child.deadlines = [...this.deadlines];
    child.env = { ...this.env };
    child.umask = this.umask;
    child.functions = { ...this.functions };
    child.options = new Set(this.options);
    child.arrays = new Map(Array.from(this.arrays.entries()).map(([k, v]) => [k, [...v]]));
    child.assocArrays = new Map(Array.from(this.assocArrays.entries()).map(([k, v]) => [k, new Map(v)]));
    child.traps = new Map(this.traps);
    child.aliases = new Map(this.aliases);
    child.namerefs = new Map(this.namerefs);
    child.dirStack = [...this.dirStack];
    child.history = this.history; // share history array reference
    child.completionSpecs = new Map(this.completionSpecs);
    child.commandHashes = new Map([...this.commandHashes].map(([name,entry]) => [name,{...entry}]));
    return child;
  }

  /**
   * Replace secret env values in text with '***'.
   * Used by terminals to mask tokens in output.
   */
  maskSecrets(text: string): string {
    for (const key of SECRET_ENV_KEYS) {
      const val = this.env[key];
      if (val && val.length >= 8 && text.includes(val)) {
        text = text.replaceAll(val, '***');
      }
    }
    return text;
  }

  // Execute a command string and return { stdout, stderr, exitCode }
  /** Runs input and returns its output as plain text (\n line endings, not the terminal's \r\n). */
  async exec(input: string, remote: boolean = false): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let stdout = '';
    let stderr = '';
    const exitCode = await this.execute(
      input,
      (s) => { stdout += s; },
      (s) => { stderr += s; },
      remote,
    );
    // An EXIT trap runs when the script ends (a multi-line script's already ran in execute).
    if (this.executeDepth === 0 && this.traps.has('EXIT')) {
      const exitCmd = this.traps.get('EXIT')!;
      this.traps.delete('EXIT');
      await this.execute(exitCmd, (s) => { stdout += s; }, (s) => { stderr += s; }, false, undefined, true);
    }
    return { stdout: stdout.replace(/\r\n/g, '\n'), stderr: stderr.replace(/\r\n/g, '\n'), exitCode };
  }

  private executeBackground(
    command: string,
    writeStdout: (s: string) => void,
    writeStderr?: (s: string) => void,
  ): number {
    const jobId = this.nextJobId++;
    const stderrWriter = writeStderr || writeStdout;
    const job: BackgroundJob = {
      id: jobId,
      command,
      status: 'running',
      exitCode: 0,
      promise: this.execute(command, () => {}, stderrWriter).then(
        (code) => {
          job.status = code === 0 ? 'done' : 'failed';
          job.exitCode = code;
          return code;
        },
        (err) => {
          job.status = 'failed';
          job.exitCode = 1;
          return 1;
        },
      ),
    };
    this.backgroundJobs.set(jobId, job);
    // A non-interactive shell prints nothing for `cmd &` (bash prints job numbers only interactively).
    if (this.terminal) writeStdout(`[${jobId}] started\n`);
    return 0;
  }

  /** Dispatch already-expanded arguments through the same builtin/PATH/package engine. */
  async execArgv(argv: string[], stdin = '', skipFunctions = false, pathOverride?:string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!argv.length) return { stdout:'', stderr:'', exitCode:0 };
    let stdout = '', stderr = '';
    const saved = this.env['__PIPE_STDIN'];
    this.env['__PIPE_STDIN'] = stdin;
    try {
      const exitCode = await this.execute('', s => { stdout += s; }, s => { stderr += s; }, false, undefined, true, { argv, skipFunctions, pathOverride });
      return { stdout:stdout.replace(/\r\n/g, '\n'), stderr:stderr.replace(/\r\n/g, '\n'), exitCode };
    } finally {
      if (saved === undefined) delete this.env['__PIPE_STDIN']; else this.env['__PIPE_STDIN'] = saved;
    }
  }

  async execute(
    line: string,
    writeStdout: (s: string) => void,
    writeStderr?: (s: string) => void,
    remote: boolean = false,
    terminalOverride?: any,
    skipHistory: boolean = false,
    invocation?: { argv: string[]; skipFunctions: boolean; pathOverride?:string },
  ): Promise<number> {
    // Built-ins print through writeStdout; under > / >> it is swapped per command (below).
    const baseWriteStdout = writeStdout;
    // Handle backslash line continuations: \<newline> joins lines; comments go, as in bash
    // (a script starting with "# …" used to run nothing, and "cmd # note" passed "# note" on).
    const joined = invocation ? '[argv]' : stripComments(line.replace(/\\\n/g, ''));
    const trimmed = joined.trim();
    if (!trimmed) return 0;

    // LINENO tracking: reset at top-level execute, track depth
    this.executeDepth++;
    const isTopLevel = this.executeDepth === 1;
    if (isTopLevel) {
      this.requestedExit = null;
      this.currentLine = 1;
      // Set up abort controller for SIGINT (Ctrl+C)
      this.abortController = new AbortController();
    }

    // Record command for title display
    recordCommand(trimmed, remote);

    // Check for background execution (&)
    if (trimmed.endsWith('&') && !trimmed.endsWith('&&')) {
      const bgCmd = trimmed.slice(0, -1).trim();
      if (bgCmd) {
        this.executeDepth--;
        if (isTopLevel) this.abortController = null;
        return this.executeBackground(bgCmd, writeStdout, writeStderr);
      }
    }

    // Split multi-line input into individual statements (respecting heredoc blocks)
    const statements = invocation ? [trimmed] : this.splitStatements(trimmed);
    // One statement that differs from the input is a multi-line block joined onto one line.
    if (statements.length > 1 || statements[0] !== trimmed) {
      let lastExit = 0;
      let lineOffset = isTopLevel ? 0 : this.currentLine - 1;
      for (let si = 0; si < statements.length; si++) {
        if (this.requestedExit !== null) break;
        const stmt = statements[si];
        if (!stmt.trim()) { if (isTopLevel) this.currentLine = lineOffset + si + 1; continue; }
        this.currentLine = lineOffset + si + 1;
        this.env['LINENO'] = String(this.currentLine);
        lastExit = await this.execute(stmt, writeStdout, writeStderr, remote, terminalOverride, true);
        // errexit: abort on non-zero exit code
        if (this.options.has('errexit') && lastExit !== 0) break;
      }
      // Fire EXIT trap at end of top-level multi-line script
      if (isTopLevel && this.traps.has('EXIT')) {
        const exitCmd = this.traps.get('EXIT')!;
        this.traps.delete('EXIT'); // prevent re-entry
        await this.execute(exitCmd, writeStdout, writeStderr, false, terminalOverride, true);
      }
      this.lastExitCode = lastExit;
      this.env['?'] = String(lastExit);
      this.executeDepth--;
      if (isTopLevel) this.abortController = null;
      return lastExit;
    }

    // Handle heredocs before anything else
    const heredoc = invocation ? null : this.parseHeredoc(trimmed);
    const effectiveLine = heredoc ? heredoc.command : trimmed;
    const heredocStdin = heredoc ? heredoc.body : '';

    // Strip control characters from history entries (ink UI can leak ANSI/DEL chars)
    // Only record user-typed commands (not programmatic calls from child_process, spawn, etc.)
    if (!skipHistory) {
      const sanitized = trimmed.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      if (sanitized.trim()) {
        this.history.push(sanitized);
        this.saveHistory(); // Persist to disk (async, don't await)
      }
    }

    const baseStderrWriter = writeStderr || writeStdout;
    let stderrWriter = baseStderrWriter;

    // Check for function definition: name() { ... } or function name { ... }
    const funcDef = invocation ? null : this.parseFunctionDef(effectiveLine);
    if (funcDef) {
      this.functions[funcDef.name] = { body: funcDef.body };
      this.executeDepth--;
      if (isTopLevel) this.abortController = null;
      return 0;
    }

    // Update LINENO before executing commands
    this.env['LINENO'] = String(this.currentLine);

    // NOTE: Control structures, (( )), and subshells are handled inside the
    // parseCompound loop below. This ensures that semicolons AFTER a control
    // structure closing keyword (fi, done, esac) are properly split.
    // e.g., "if [ $x -eq 1 ]; then break; fi; echo $x" → two compounds.

    // Split into compound commands: &&, ||, ;
    const compounds = invocation ? [{operator: '' as const, command:''}] : this.parseCompound(effectiveLine);
    let exitCode = 0;

    for (const compound of compounds) {
      if (this.requestedExit !== null) { exitCode = this.requestedExit; break; }
      // Check conditional
      if (compound.operator === '&&' && exitCode !== 0) continue;
      if (compound.operator === '||' && exitCode === 0) continue;

      // `cmd &` inside a list runs in the background; the list goes on at once with status 0.
      if (compounds.length > 1 && /[^&]&$/.test(compound.command.trim())) {
        this.executeBackground(compound.command.trim().slice(0, -1).trim(), writeStdout, writeStderr);
        exitCode = 0; this.lastExitCode = 0; this.env['?'] = '0';
        continue;
      }

      // Check for function definition in this compound
      const compFuncDef = this.parseFunctionDef(compound.command.trim());
      if (compFuncDef) {
        this.functions[compFuncDef.name] = { body: compFuncDef.body };
        continue;
      }

      // { list; } and ( list ) groups become calls to hidden functions, so pipes, redirects
      // and piped input apply to them like to any command.
      compound.command = this.hoistGroups(compound.command);
      const trimmedCmd = compound.command.trim();

      // [[ … ]] is evaluated on its own text (no word splitting, && || inside it).
      if (trimmedCmd.startsWith('[[') && this.doubleBracketEnd(trimmedCmd, 0) === trimmedCmd.length) {
        exitCode = await this.evalDoubleBracket(trimmedCmd.slice(2, -2));
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
        continue;
      }

      // Check for (( expr )) arithmetic command in compound
      if (trimmedCmd.startsWith('((') && trimmedCmd.endsWith('))')) {
        const expr = trimmedCmd.slice(2, -2).trim();
        exitCode = this.evalArithmetic(expr) !== 0 ? 0 : 1;
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
        continue;
      }

      // Check if compound is a subshell: (commands)
      if (trimmedCmd.startsWith('(') && trimmedCmd.endsWith(')')) {
        const inner = trimmedCmd.slice(1, -1).trim();
        if (inner) {
          const child = this.fork();
          const result = await child.exec(inner);
          if (result.stdout) writeStdout(result.stdout.replace(/\n/g, '\r\n'));
          if (result.stderr) stderrWriter(result.stderr.replace(/\n/g, '\r\n'));
          exitCode = result.exitCode;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          continue;
        }
      }

      // Check if compound is a control structure BEFORE variable expansion
      // (control structures handle their own expansion internally to support loop variables)
      if (this.isControlStructure(trimmedCmd)) {
        exitCode = await this.execControlStructure(trimmedCmd, writeStdout, stderrWriter);
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
        continue;
      }

      // Expand braces, arithmetic, command substitution, and environment variables. Heredoc
      // bodies go back in first — not into a control structure, whose parser would split them.
      let expanded = invocation ? '' : this.inlineHeredocs(compound.command);
      expanded = await this.expandProcessSubstitutionText(expanded, baseStderrWriter);
      expanded = this.expandBraces(expanded);
      // Command substitution before arithmetic, as in bash: $(( $(cmd) * 2 )).
      expanded = await this.expandCommandSubstitution(expanded, stderrWriter);
      expanded = this.expandArithmetic(expanded);
      expanded = this.expandVars(expanded);

      // Parse pipeline
      const pipeline = invocation ? [''] : this.parsePipeline(expanded);

      // Check for ! negation prefix
      let negateExit = false;
      if (pipeline.length > 0 && pipeline[0].trim().startsWith('! ')) {
        negateExit = true;
        pipeline[0] = pipeline[0].trim().slice(2);
      } else if (pipeline.length > 0 && pipeline[0].trim() === '!') {
        // Bare ! with pipeline after
        negateExit = true;
        pipeline.shift();
      }

      let lastOutput = '';
      exitCode = 0;
      const pipeExitCodes: number[] = [];
      // Pipeline stages have child shell state, as do command substitutions and subshells.
      // This also keeps exit, exec, cd and variable assignments from terminating/changing
      // the enclosing shell. Each child uses the ordinary dispatcher and redirections.
      if (pipeline.length > 1) {
        for (const [stage, segment] of pipeline.entries()) {
          const child = this.fork();
          if (stage < pipeline.length - 1) child.stdoutFile = null;
          child.env['__PIPE_STDIN'] = lastOutput;
          const result = await child.exec(segment);
          lastOutput = result.stdout;
          if (result.stderr) stderrWriter(result.stderr.replace(/\n/g, '\r\n'));
          pipeExitCodes.push(result.exitCode);
        }
        if (lastOutput) writeStdout(lastOutput.replace(/\n/g, '\r\n'));
        exitCode = pipeExitCodes[pipeExitCodes.length - 1];
      }
      // Undoes `VAR=value cmd` prefix assignments once cmd has run (next segment or loop end).
      let restorePrefix: (() => void) | null = null;

      // Output a built-in printed directly while piped (see below), for the next command's input.
      let builtinPiped: string | null = null;
      for (let i = 0; pipeline.length === 1 && i < pipeline.length; i++) {
        if (this.requestedExit !== null) { exitCode = this.requestedExit; break; }
        if (restorePrefix) { restorePrefix(); restorePrefix = null; }
        await this.redirectWrites;
        writeStdout = baseWriteStdout;
        stderrWriter = baseStderrWriter;
        if (builtinPiped !== null) { lastOutput = builtinPiped.replace(/\r\n/g, '\n'); builtinPiped = null; }
        // Check for SIGINT (abort)
        if (this.isAborted()) {
          exitCode = 130; // 128 + SIGINT(2)
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          break;
        }

        const segment = pipeline[i];

        // Check if this pipeline segment is a control structure (e.g. `echo foo | while ...`)
        if (this.isControlStructure(segment.trim())) {
          const pipeStdin = i > 0 ? lastOutput : '';
          exitCode = await this.execControlStructurePiped(segment.trim(), pipeStdin, writeStdout, stderrWriter);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        const { args, redirects, hereString } = invocation ? {args:[...invocation.argv], redirects:[], hereString:''} : this.parseSegment(segment);
        if (this.stdoutFile && !redirects.some(r => ['>', '>>', '>&2'].includes(r.type))) {
          redirects.unshift({ type: '>>', target: this.stdoutFile });
        }

        if (args.length === 0) continue;

        // Expand glob patterns in args (but not quoted ones marked with \x01)
        const globResult = invocation ? args : await this.expandGlobs(args, stderrWriter);
        if (globResult === null) {
          // failglob: unmatched glob pattern — abort this command
          exitCode = 1;
          this.lastExitCode = 1;
          this.env['?'] = '1';
          lastOutput = '';
          continue;
        }
        let expandedArgs = globResult;

        // Open redirections in lexical order and bind the two output descriptors once.
        // Builtins and registered programs use these same sinks; duplicated descriptors
        // retain the destination that existed when the duplication was encountered.
        let outputOpenFailed = false;
        for (const redir of redirects) {
          if (redir.type === '2>&1') { stderrWriter = writeStdout; continue; }
          if (redir.type === '>&2') { writeStdout = stderrWriter; continue; }
          if (!['>', '>>', '2>', '2>>'].includes(redir.type)) continue;
          let sink: (text: string) => void;
          if (redir.target === '/dev/null') sink = () => {};
          else if (redir.target === '/dev/stdout') sink = writeStdout;
          else if (redir.target === '/dev/stderr') sink = stderrWriter;
          else {
            const target = this.fs.resolvePath(redir.target, this.cwd);
            try {
              if (redir.type === '>' || redir.type === '2>') await this.fs.writeFile(target, '');
              else await this.fs.appendFile(target, '');
            } catch (error) {
              stderrWriter(`bash: line ${this.currentLine}: ${redir.target}: ${filesystemError(error)}\r\n`);
              outputOpenFailed = true;
              break;
            }
            sink = text => {
              this.redirectWrites = this.redirectWrites.then(() => this.fs.appendFile(target, text.replace(/\r\n/g, '\n')));
            };
          }
          if (redir.type === '2>' || redir.type === '2>>') stderrWriter = sink;
          else writeStdout = sink;
        }
        if (outputOpenFailed) {
          exitCode = 1; this.lastExitCode = 1; this.env['?'] = '1'; lastOutput = '';
          continue;
        }

        // Expand process substitution: <(cmd) and >(cmd)
        if (!invocation) expandedArgs = await this.expandProcessSubstitution(expandedArgs, baseStderrWriter);

        // `VAR=value cmd args`: VAR is set only while cmd runs. `a=1 b=2` (no command) sets all.
        if (!invocation) {
          const isAssign = (a: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a) && !/^[A-Za-z_][A-Za-z0-9_]*=\(/.test(a);
          let k = 0;
          while (k < expandedArgs.length && isAssign(expandedArgs[k])) k++;
          const assign = (a: string) => { const eq = a.indexOf('='); return [a.slice(0, eq), a.slice(eq + 1).replace(/\x01/g, '')]; };
          if (k > 0 && k < expandedArgs.length) {
            const saved = new Map<string, string | undefined>();
            const previousTemporaryPath = this.temporaryPath;
            if (expandedArgs.slice(0,k).some(a => a.startsWith('PATH='))) this.temporaryPath = true;
            for (const a of expandedArgs.slice(0, k)) {
              const [name, value] = assign(a);
              if (!saved.has(name)) saved.set(name, name in this.env ? this.env[name] : undefined);
              this.env[name] = value;
            }
            restorePrefix = () => {
              for (const [name, value] of saved) { if (value === undefined) delete this.env[name]; else this.env[name] = value; }
              this.temporaryPath = previousTemporaryPath;
            };
            expandedArgs = expandedArgs.slice(k);
          } else if (k > 1) {
            for (const a of expandedArgs.slice(0, k - 1)) {
              const [name, value] = assign(a);
              if (!this.readonlyVars.has(name)) this.env[name] = value;
            }
            expandedArgs = expandedArgs.slice(k - 1);   // the last one goes through the normal path
          }
        }

        const cmdName = expandedArgs[0];
        const cmdArgs = expandedArgs.slice(1);

        // Handle [[ ... ]] as inline test command
        if (cmdName === '[[') {
          const closingIdx = cmdArgs.indexOf(']]');
          const testArgs = closingIdx >= 0 ? cmdArgs.slice(0, closingIdx) : cmdArgs;
          exitCode = await this.evalTest(testArgs.join(' '));
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Absolute compatibility paths use the same child-shell / environment adapters.
        if (/^\/bin\/(sh|bash|zsh)$/.test(cmdName) || cmdName === '/usr/bin/env' || cmdName === '/bin/env') {
          const name = cmdName.endsWith('/env') ? 'env' : cmdName.endsWith('/bash') ? 'bash' : 'sh';
          const result = await this.execArgv([name,...cmdArgs], this.env['__PIPE_STDIN'] ?? lastOutput);
          writeStdout(result.stdout.replace(/\n/g,'\r\n'));
          stderrWriter(result.stderr.replace(/\n/g,'\r\n'));
          exitCode = result.exitCode;
          this.lastExitCode = exitCode; this.env['?'] = String(exitCode);
          lastOutput = ''; continue;
        }

        // Alias expansion: if cmdName matches an alias, replace it
        if (!invocation && this.shoptopts.has('expand_aliases') && this.aliases.has(cmdName)) {
          const aliasValue = this.aliases.get(cmdName)!;
          const fullCmd = aliasValue + (cmdArgs.length > 0 ? ' ' + cmdArgs.join(' ') : '');
          exitCode = await this.execute(fullCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Handle . as alias for source
        const effectiveCmdName = cmdName === '.' ? 'source' : cmdName;

        // xtrace: echo command to stderr before executing
        if (this.options.has('xtrace')) {
          stderrWriter(`+ ${[effectiveCmdName, ...cmdArgs].join(' ')}\r\n`);
        }

        // Handle array assignment: arr=(a b c) or arr[N]=val
        if (!invocation && effectiveCmdName.includes('=') && !effectiveCmdName.startsWith('=')) {
          const eqIdx = cmdName.indexOf('=');
          const key = cmdName.substring(0, eqIdx);
          const val = cmdName.substring(eqIdx + 1);

          // arr=(…) / arr+=(…): split the elements from the segment text, where quotes are
          // still in place ("a b" stays one element); unquoted globs expand.
          const rawArr = segment.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(\+?)=\(([\s\S]*)\)$/);
          if (rawArr && val.startsWith('(')) {
            const elems = (await this.expandGlobs(this.tokenize(rawArr[3]))) ?? [];
            if (rawArr[2]) this.arrays.set(rawArr[1], [...(this.arrays.get(rawArr[1]) || []), ...elems]);
            else this.arrays.set(rawArr[1], elems);
            continue;
          }

          // Array append: name+=(elem1 elem2)
          if (key.endsWith('+') && val.startsWith('(') && (val.endsWith(')') || cmdArgs.length > 0)) {
            const arrName = key.slice(0, -1);
            let elements: string;
            if (val.endsWith(')')) {
              elements = val.slice(1, -1);
            } else {
              const fullVal = [val, ...cmdArgs].join(' ');
              const closeIdx = fullVal.indexOf(')');
              elements = closeIdx >= 0 ? fullVal.slice(1, closeIdx) : fullVal.slice(1);
            }
            const newElems = elements.trim() ? this.tokenize(elements) : [];
            const existing = this.arrays.get(arrName) || [];
            existing.push(...newElems.map(a => a.replace(/\x01/g, '')));
            this.arrays.set(arrName, existing);
            continue;
          }

          // Array assignment: name=(elem1 elem2 elem3)
          if (val.startsWith('(') && (val.endsWith(')') || cmdArgs.length > 0)) {
            let elements: string;
            if (val.endsWith(')')) {
              elements = val.slice(1, -1);
            } else {
              // Multi-token: name=(a b c) got split, reconstruct
              const fullVal = [val, ...cmdArgs].join(' ');
              const closeIdx = fullVal.indexOf(')');
              elements = closeIdx >= 0 ? fullVal.slice(1, closeIdx) : fullVal.slice(1);
            }
            const arr = elements.trim() ? this.tokenize(elements) : [];
            this.arrays.set(key, arr.map(a => a.replace(/\x01/g, '')));
            continue;
          }

          // Indexed or associative array element assignment: arr[key]=val
          const bracketMatch = key.match(/^(\w+)\[(.+)\]$/);
          if (bracketMatch) {
            const arrName = bracketMatch[1];
            const idxKey = bracketMatch[2];
            // Associative array?
            if (this.assocArrays.has(arrName)) {
              this.assocArrays.get(arrName)!.set(idxKey, val);
              continue;
            }
            // Indexed array (numeric index)
            const numIdx = parseInt(idxKey, 10);
            if (!isNaN(numIdx)) {
              const arr = this.arrays.get(arrName) || [];
              while (arr.length <= numIdx) arr.push('');
              arr[numIdx] = val;
              this.arrays.set(arrName, arr);
            }
            continue;
          }

          // Regular variable assignment: FOO=bar
          if (this.readonlyVars.has(key)) {
            stderrWriter(`bash: line ${this.currentLine}: ${key}: readonly variable\r\n`);
            exitCode = 1;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          this.env[key] = val;
          if (key === 'PWD') this.cwd = val;
          // Persist API keys to localStorage
          const persistKeys: Record<string, string> = {
            ANTHROPIC_API_KEY: 'shiro_anthropic_key',
            OPENAI_API_KEY: 'shiro_openai_key',
            GOOGLE_API_KEY: 'shiro_google_key',
          };
          if (persistKeys[key] && typeof localStorage !== 'undefined') {
            localStorage.setItem(persistKeys[key], val);
          }
          continue;
        }

        // Check if this builtin has been disabled via `enable -n`
        // If disabled, skip the builtin dispatch and fall through to external command lookup
        const _builtinDisabled = this.disabledBuiltins.has(effectiveCmdName) || (!invocation?.skipFunctions && !!this.functions[effectiveCmdName]);

        // Shell builtin: time — measure command execution time
        if (!_builtinDisabled && effectiveCmdName === 'time') {
          const timeCmd = cmdArgs.join(' ');
          const start = performance.now();
          if (timeCmd) {
            exitCode = await this.execute(timeCmd, writeStdout, stderrWriter);
          }
          const elapsed = (performance.now() - start) / 1000;
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          if (this.env['TIMEFORMAT'] !== '') {
            stderrWriter(`\nreal\t${mins}m${secs.toFixed(3)}s\r\n`);
            stderrWriter(`user\t0m0.000s\r\n`);
            stderrWriter(`sys\t0m0.000s\r\n`);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: caller — print call stack info
        if (!_builtinDisabled && effectiveCmdName === 'caller') {
          const frameNum = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) : 0;
          if (this.callStack.length > frameNum) {
            const frame = this.callStack[this.callStack.length - 1 - frameNum];
            writeStdout(cmdArgs.length ? `1 ${frame.funcName} ${frame.source}\r\n` : `1 ${frame.source === 'main' ? 'NULL' : frame.source}\r\n`);
            exitCode = 0;
          } else {
            exitCode = 1;
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtins: eval, setopt, shopt
        if (!_builtinDisabled && effectiveCmdName === 'eval') {
          // Execute remaining args as a shell command
          const evalCmd = cmdArgs.join(' ');
          if (evalCmd) {
            exitCode = await this.execute(evalCmd, writeStdout, stderrWriter);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'setopt') {
          // zsh shell options — no-op in Shiro
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'shopt') {
          const allShopts = ['extglob', 'nocaseglob', 'nullglob', 'dotglob', 'globstar',
            'failglob', 'nocasematch', 'lastpipe', 'expand_aliases', 'sourcepath',
            'checkwinsize', 'histappend', 'cmdhist', 'lithist', 'xpg_echo'];
          let mode: 's' | 'u' | 'p' | 'q' | null = null;
          const optNames: string[] = [];
          for (const a of cmdArgs) {
            if (a === '-s') mode = 's';
            else if (a === '-u') mode = 'u';
            else if (a === '-p') mode = 'p';
            else if (a === '-q') mode = 'q';
            else optNames.push(a);
          }
          if (mode === 's') {
            for (const opt of optNames) {
              if (!allShopts.includes(opt)) { stderrWriter(`shopt: ${opt}: invalid shell option name\r\n`); exitCode = 1; continue; }
              this.shoptopts.add(opt);
            }
          } else if (mode === 'u') {
            for (const opt of optNames) {
              if (!allShopts.includes(opt)) { stderrWriter(`shopt: ${opt}: invalid shell option name\r\n`); exitCode = 1; continue; }
              this.shoptopts.delete(opt);
            }
          } else if (mode === 'q') {
            // Query: exit 0 if all named options are set, 1 otherwise
            exitCode = 0;
            for (const opt of optNames) {
              if (!this.shoptopts.has(opt)) { exitCode = 1; break; }
            }
          } else {
            // Print: -p or default (no mode flag)
            const toShow = optNames.length > 0 ? optNames : allShopts;
            for (const opt of toShow) {
              if (!allShopts.includes(opt)) { stderrWriter(`shopt: ${opt}: invalid shell option name\r\n`); exitCode = 1; continue; }
              writeStdout(`${opt.padEnd(15)}\t${this.shoptopts.has(opt) ? 'on' : 'off'}\r\n`);
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && (effectiveCmdName === 'declare' || effectiveCmdName === 'typeset' || effectiveCmdName === 'local')) {
          // declare -n ref=target → nameref
          if (cmdArgs.includes('-n')) {
            for (const arg of cmdArgs) {
              if (arg.startsWith('-')) continue;
              const eqIdx = arg.indexOf('=');
              if (eqIdx >= 0) {
                this.namerefs.set(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
              }
            }
            continue;
          }
          // declare -A name[=( [k]=v … )] / declare -a name[=( v … )]: arrays, with initial
          // elements read from the segment text so quoting is kept.
          if (cmdArgs.some(a => /^-[a-zA-Z]*[Aa]/.test(a))) {
            const assoc = cmdArgs.some(a => /^-[a-zA-Z]*A/.test(a));
            const inits = new Map<string, string>();
            for (const m of segment.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=\(([\s\S]*?)\)(?=\s|$)/g)) inits.set(m[1], m[2]);
            for (const arg of cmdArgs) {
              if (arg.startsWith('-')) continue;
              const name = arg.split('=')[0].replace(/[()\x01]/g, '');
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
              const body = inits.get(name);
              if (assoc) {
                const map = body !== undefined ? new Map<string, string>() : (this.assocArrays.get(name) ?? new Map<string, string>());
                for (const el of body !== undefined ? this.tokenize(body) : []) {
                  const km = /^\[([^\]]*)\]=([\s\S]*)$/.exec(el.replace(/\x01/g, ''));
                  if (km) map.set(km[1], km[2]);
                }
                this.assocArrays.set(name, map);
              } else {
                const arr: string[] = body !== undefined ? [] : (this.arrays.get(name) ?? []);
                for (const el of body !== undefined ? this.tokenize(body) : []) {
                  const e = el.replace(/\x01/g, '');
                  const im = /^\[(\d+)\]=([\s\S]*)$/.exec(e);
                  if (im) arr[parseInt(im[1], 10)] = im[2]; else arr.push(e);
                }
                this.arrays.set(name, arr);
              }
            }
            continue;
          }
          // Parse flags for declare/typeset/local
          const isLocal = effectiveCmdName === 'local';
          let declFlags = '';
          const declPositional: string[] = [];
          for (const arg of cmdArgs) {
            if (arg.startsWith('-') && /^-[xrilupg]+$/.test(arg)) { declFlags += arg.slice(1); continue; }
            if (arg.startsWith('-')) continue; // skip other flags
            declPositional.push(arg);
          }
          // declare -p: show variable values
          if (declFlags.includes('p') && declPositional.length > 0) {
            // An unknown name is an error (status 1), as in bash: `declare -p x` tests for x.
            let missing = false;
            for (const name of declPositional) {
              const val = this.env[name];
              if (val !== undefined) writeStdout(`declare -- ${name}="${val}"\r\n`);
              else if (!this.arrays.has(name) && !this.assocArrays.has(name)) { stderrWriter(`bash: declare: ${name}: not found\r\n`); missing = true; }
            }
            exitCode = missing ? 1 : 0; this.lastExitCode = exitCode; this.env['?'] = String(exitCode);
            continue;
          }
          for (const arg of declPositional) {
            const eqIdx = arg.indexOf('=');
            const varName = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
            let value = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined;
            // Apply type transformations
            if (value !== undefined) {
              if (declFlags.includes('i')) value = String(this.evalArithmetic(value));
              if (declFlags.includes('l')) value = value.toLowerCase();
              if (declFlags.includes('u')) value = value.toUpperCase();
            }
            // Save old value in local var frame if inside a function
            const isGlobal = declFlags.includes('g');
            if (isLocal && !isGlobal && this.localVarStack.length > 0) {
              const frame = this.localVarStack[this.localVarStack.length - 1];
              if (!frame.has(varName)) {
                frame.set(varName, varName in this.env ? this.env[varName] : undefined);
              }
            }
            if (value !== undefined) {
              this.env[varName] = value;
            } else {
              if (!(varName in this.env)) this.env[varName] = '';
            }
            // declare -r marks variable readonly
            if (declFlags.includes('r')) {
              this.readonlyVars.add(varName);
            }
          }
          continue;
        }

        // Shell builtin: read
        if (!_builtinDisabled && effectiveCmdName === 'read') {
          // Parse flags: -r (raw), -a (array), -p (prompt), -d (delimiter), -n (nchars), -s (silent), -t (timeout), -u (fd)
          let rawMode = false;
          let arrayMode = false;
          let readDelim = '\n';
          let readNchars = -1;
          let readTimeout = -1;
          let readFd = -1;
          const readVars: string[] = [];
          // Bundled flags (-ra, -rp PROMPT, -d ''): split into single ones.
          const readArgs: string[] = [];
          for (const a of cmdArgs) {
            if (/^-[rase]{2,}[pdntu]?$/.test(a)) for (const c of a.slice(1)) readArgs.push('-' + c);
            else readArgs.push(a);
          }
          cmdArgs.splice(0, cmdArgs.length, ...readArgs);
          for (let ri = 0; ri < cmdArgs.length; ri++) {
            const a = cmdArgs[ri];
            if (a === '-r') rawMode = true;
            else if (a === '-a') arrayMode = true;
            else if (a === '-s') { /* silent - no-op in non-interactive */ }
            else if (a === '-p' && ri + 1 < cmdArgs.length) { ri++; /* skip prompt text */ }
            else if (a === '-d' && ri + 1 < cmdArgs.length) { readDelim = cmdArgs[++ri]; }
            else if (a === '-n' && ri + 1 < cmdArgs.length) { readNchars = parseInt(cmdArgs[++ri], 10) || -1; }
            else if (a.startsWith('-n') && a.length > 2) { readNchars = parseInt(a.slice(2), 10) || -1; }
            else if (a.startsWith('-d') && a.length > 2) { readDelim = a.slice(2); }
            else if (a === '-t' && ri + 1 < cmdArgs.length) { readTimeout = parseFloat(cmdArgs[++ri]) || 0; }
            else if (a.startsWith('-t') && a.length > 2) { readTimeout = parseFloat(a.slice(2)) || 0; }
            else if (a === '-u' && ri + 1 < cmdArgs.length) { readFd = parseInt(cmdArgs[++ri], 10); }
            else if (a.startsWith('-u') && a.length > 2) { readFd = parseInt(a.slice(2), 10); }
            else if (!a.startsWith('-')) readVars.push(a);
          }
          // Read one line from stdin — prefer FD, a here-string or `< file` on this command,
          // piped stdin (__PIPE_STDIN), then pipe, then heredoc
          let readInput = '';
          const fileRedir = redirects.find(r => r.type === '<' && r.target !== '/dev/stdin');
          const ownInput = hereString !== undefined && hereString !== null && hereString !== '' || !!fileRedir;
          const hasPipeStdin = !ownInput && '__PIPE_STDIN' in this.env;
          if (readFd >= 0 && this.fileDescriptors.has(readFd)) {
            // Read from file descriptor
            const fd = this.fileDescriptors.get(readFd)!;
            readInput = fd.content.slice(fd.offset);
          } else if (hereString) {
            readInput = hereString;
          } else if (fileRedir) {
            try {
              const procSub = /^<\(([\s\S]*)\)$/.exec(fileRedir.target);
              readInput = fileRedir.target === '/dev/null' ? ''
                : procSub ? (await this.exec(procSub[1])).stdout
                : await this.fs.readFile(this.fs.resolvePath(fileRedir.target, this.cwd), 'utf8') as string;
            } catch (e: any) {
              stderrWriter(`shiro: ${fileRedir.target}: ${e.message}\r\n`);
              exitCode = 1; this.lastExitCode = 1; this.env['?'] = '1'; lastOutput = '';
              continue;
            }
          } else if (hasPipeStdin) {
            readInput = this.env['__PIPE_STDIN'];
          } else {
            readInput = i > 0 ? lastOutput : (heredocStdin || '');
          }
          // Handle -t 0: check if input is available (non-blocking)
          if (readTimeout === 0) {
            exitCode = readInput.length > 0 ? 0 : 1;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          // Handle -t N: timeout (for non-piped/non-interactive, just check availability)
          if (readTimeout > 0 && !readInput) {
            // No input available and timeout specified → exit 142 (128 + SIGALRM(14))
            exitCode = 142;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          let readLine: string;
          let remaining: string;
          // Succeeds when a whole line (delimiter included) was read. At end of input it fails,
          // still setting the variables to any unterminated last line (bash behavior); an empty
          // line in the middle of the input is not end of input.
          let gotLine: boolean;
          if (readNchars > 0) {
            readLine = readInput.slice(0, readNchars);
            remaining = readInput.slice(readNchars);
            gotLine = readLine.length > 0;
          } else {
            const delimIdx = readInput.indexOf(readDelim);
            if (delimIdx >= 0) {
              readLine = readInput.slice(0, delimIdx);
              remaining = readInput.slice(delimIdx + readDelim.length);
              gotLine = true;
            } else {
              readLine = readInput;
              remaining = '';
              gotLine = false;
            }
          }
          // Consume the line from source so next read gets the next line
          if (readFd >= 0 && this.fileDescriptors.has(readFd)) {
            const fd = this.fileDescriptors.get(readFd)!;
            fd.offset = fd.content.length - remaining.length;
          } else if (hasPipeStdin) {
            this.env['__PIPE_STDIN'] = remaining;
          }
          // Use IFS for splitting (default: space/tab/newline); IFS whitespace around the line
          // is trimmed.
          const ifs = this.env['IFS'] ?? ' \t\n';
          const ifsWs = ifs.replace(/[^ \t\n]/g, '');
          let processed = rawMode ? readLine : readLine.replace(/\\(.)/g, '$1');
          if (ifsWs) {
            const ws = '[' + ifsWs.replace(/\t/g, '\\t').replace(/\n/g, '\\n') + ']+';
            processed = processed.replace(new RegExp('^' + ws), '').replace(new RegExp(ws + '$'), '');
          }
          const ifsRegex = ifs === ' \t\n' ? /\s+/ : ifs === '' ? /(?!)/ : new RegExp('[' + ifs.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&').replace(/\t/g, '\\t').replace(/\n/g, '\\n') + ']+');
          if (arrayMode) {
            const arrName = readVars[0] || 'MAPFILE';
            const words = processed.split(ifsRegex).filter(Boolean);
            this.arrays.set(arrName, words);
            exitCode = gotLine ? 0 : 1;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          if (readVars.length === 0) {
            this.env['REPLY'] = processed;
          } else if (readVars.length === 1) {
            this.env[readVars[0]] = processed;
          } else {
            // Split into words using IFS, last var gets the remainder
            const words = processed.split(ifsRegex);
            const joinChar = ifs[0] || ' ';
            for (let vi = 0; vi < readVars.length; vi++) {
              if (vi === readVars.length - 1) {
                this.env[readVars[vi]] = words.slice(vi).join(joinChar);
              } else {
                this.env[readVars[vi]] = words[vi] || '';
              }
            }
          }
          exitCode = gotLine ? 0 : 1;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: mapfile / readarray
        if (!_builtinDisabled && (effectiveCmdName === 'mapfile' || effectiveCmdName === 'readarray')) {
          // Parse flags: -t (strip), -d (delimiter), -s (skip N lines), -n (count), -C callback, -c quantum
          let mapDelim = '\n';
          let mapSkip = 0;
          let mapCount = -1;
          let mapCallback = '';
          let mapQuantum = 5000;
          let arrName = 'MAPFILE';
          let mapStrip = false;
          for (let mi = 0; mi < cmdArgs.length; mi++) {
            if (cmdArgs[mi] === '-d' && mi + 1 < cmdArgs.length) { mapDelim = cmdArgs[++mi] || '\0'; }
            else if (cmdArgs[mi].startsWith('-d') && cmdArgs[mi].length > 2) { mapDelim = cmdArgs[mi].slice(2); }
            else if (cmdArgs[mi] === '-s' && mi + 1 < cmdArgs.length) { mapSkip = parseInt(cmdArgs[++mi], 10) || 0; }
            else if (cmdArgs[mi] === '-n' && mi + 1 < cmdArgs.length) { mapCount = parseInt(cmdArgs[++mi], 10) || -1; }
            else if (cmdArgs[mi] === '-C' && mi + 1 < cmdArgs.length) { mapCallback = cmdArgs[++mi]; }
            else if (cmdArgs[mi] === '-c' && mi + 1 < cmdArgs.length) { mapQuantum = parseInt(cmdArgs[++mi], 10) || 5000; }
            else if (cmdArgs[mi] === '-t') { mapStrip = true; }
            else if (!cmdArgs[mi].startsWith('-')) { arrName = cmdArgs[mi]; }
          }
          // Input: a here-string or < redirect (file or <(cmd)), else piped input.
          let mapInput = '';
          const mapFile = redirects.find(r => r.type === '<' && r.target !== '/dev/stdin');
          const hasPipeStdin = '__PIPE_STDIN' in this.env;
          if (hereString) mapInput = hereString;
          else if (mapFile) {
            const procSub = /^<\(([\s\S]*)\)$/.exec(mapFile.target);
            try { mapInput = procSub ? (await this.exec(procSub[1])).stdout : await this.fs.readFile(this.fs.resolvePath(mapFile.target, this.cwd), 'utf8') as string; }
            catch (e: any) { stderrWriter(`shiro: ${mapFile.target}: ${e.message}\r\n`); exitCode = 1; this.lastExitCode = 1; this.env['?'] = '1'; lastOutput = ''; continue; }
          } else if (hasPipeStdin) {
            mapInput = this.env['__PIPE_STDIN'];
            delete this.env['__PIPE_STDIN'];
          } else {
            mapInput = i > 0 ? lastOutput : (heredocStdin || '');
          }
          let lines = mapInput.split(mapDelim);
          // Remove trailing empty element from trailing delimiter
          const endsWithDelim = lines.length > 0 && lines[lines.length - 1] === '';
          if (endsWithDelim) lines.pop();
          // Without -t each element keeps its delimiter.
          if (!mapStrip) lines = lines.map((l, k) => k < lines.length - 1 || endsWithDelim ? l + mapDelim : l);
          // Apply skip
          if (mapSkip > 0) lines = lines.slice(mapSkip);
          // Apply count
          if (mapCount >= 0) lines = lines.slice(0, mapCount);
          this.arrays.set(arrName, lines);
          // Invoke -C callback every -c quantum lines
          if (mapCallback && this.functions[mapCallback]) {
            for (let li = 0; li < lines.length; li++) {
              if ((li % mapQuantum) === 0) {
                await this.execFunction(mapCallback, [String(li), lines[li]], writeStdout, stderrWriter);
              }
            }
          }
          exitCode = 0;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtins: break and continue (throw sentinels caught by loop handlers)
        if (effectiveCmdName === 'break') {
          const levels = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) || 1 : 1;
          throw new BreakSignal(levels);
        }
        if (effectiveCmdName === 'continue') {
          const levels = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) || 1 : 1;
          throw new ContinueSignal(levels);
        }

        // Shell builtin: return (throw sentinel caught by execFunction)
        if (effectiveCmdName === 'return') {
          const code = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) || 0 : this.lastExitCode;
          throw new ReturnSignal(code);
        }

        // Shell builtin: trap
        if (!_builtinDisabled && effectiveCmdName === 'trap') {
          if (cmdArgs.length === 0 || (cmdArgs.length === 1 && cmdArgs[0] === '-p')) {
            // List all traps
            for (const [sig, cmd] of this.traps) {
              writeStdout(`trap -- '${cmd}' ${sig}\r\n`);
            }
            exitCode = 0;
            this.lastExitCode = 0;
            this.env['?'] = '0';
            lastOutput = '';
            continue;
          }
          if (cmdArgs[0] === '-l') {
            // List signal names
            writeStdout('EXIT ERR INT TERM HUP QUIT DEBUG RETURN\r\n');
            exitCode = 0;
            this.lastExitCode = 0;
            this.env['?'] = '0';
            lastOutput = '';
            continue;
          }
          // trap -p SIGNAL — show specific trap
          if (cmdArgs[0] === '-p' && cmdArgs.length > 1) {
            for (let si = 1; si < cmdArgs.length; si++) {
              const sig = cmdArgs[si].toUpperCase();
              const cmd = this.traps.get(sig);
              if (cmd !== undefined) writeStdout(`trap -- '${cmd}' ${sig}\r\n`);
            }
            exitCode = 0;
            this.lastExitCode = 0;
            this.env['?'] = '0';
            lastOutput = '';
            continue;
          }
          if (cmdArgs.length === 1) {
            // trap SIGNAL — reset trap
            const sig = cmdArgs[0].toUpperCase();
            this.traps.delete(sig);
          } else {
            // trap 'command' SIGNAL [SIGNAL...]
            const cmd = cmdArgs[0];
            for (let si = 1; si < cmdArgs.length; si++) {
              const sig = cmdArgs[si].toUpperCase();
              if (cmd === '' || cmd === '-') {
                this.traps.delete(sig); // reset to default
              } else {
                this.traps.set(sig, cmd);
              }
            }
          }
          exitCode = 0;
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }

        // Shell builtin: fc (fix command — list/re-execute history)
        if (!_builtinDisabled && effectiveCmdName === 'fc') {
          let listMode = false;
          let reverseMode = false;
          let reExecMode = false;
          let substitution: { pat: string; rep: string } | null = null;
          const fcPositional: string[] = [];

          for (let ai = 0; ai < cmdArgs.length; ai++) {
            const a = cmdArgs[ai];
            if (a === '-l') { listMode = true; }
            else if (a === '-r') { reverseMode = true; }
            else if (a === '-s') { reExecMode = true; }
            else if (a === '-e' && cmdArgs[ai + 1] === '-') { reExecMode = true; ai++; }
            else if (a === '-lr' || a === '-rl') { listMode = true; reverseMode = true; }
            else if (reExecMode && a.includes('=') && fcPositional.length === 0) {
              const eqIdx = a.indexOf('=');
              substitution = { pat: a.slice(0, eqIdx), rep: a.slice(eqIdx + 1) };
            }
            else if (!a.startsWith('-')) { fcPositional.push(a); }
          }

          const hist = this.history;
          if (!hist.length) { this.lastExitCode = 0; this.env['?'] = '0'; lastOutput = ''; continue; }

          if (listMode) {
            // fc -l [first [last]] — list history entries
            let first = -16, last = -1;
            if (fcPositional.length >= 1) {
              first = this.fcResolveRef(fcPositional[0], hist);
            }
            if (fcPositional.length >= 2) {
              last = this.fcResolveRef(fcPositional[1], hist);
            }
            // Normalize negative indices
            if (first < 0) first = hist.length + first;
            if (last < 0) last = hist.length + last;
            first = Math.max(0, first);
            last = Math.min(hist.length - 1, last);
            if (first > last) { const tmp = first; first = last; last = tmp; reverseMode = !reverseMode; }
            const entries: string[] = [];
            for (let hi = first; hi <= last; hi++) {
              entries.push(`${hi + 1}\t${hist[hi]}`);
            }
            if (reverseMode) entries.reverse();
            writeStdout(entries.join('\r\n') + '\r\n');
          } else if (reExecMode) {
            // fc -s [pat=rep] [cmd] — re-execute (skip the fc command itself in history)
            let targetIdx = hist.length - 2;
            if (fcPositional.length > 0) {
              const ref = fcPositional[fcPositional.length - 1];
              targetIdx = this.fcResolveRef(ref, hist);
              if (targetIdx < 0) targetIdx = hist.length + targetIdx;
            }
            targetIdx = Math.max(0, Math.min(hist.length - 1, targetIdx));
            let cmd = hist[targetIdx] || '';
            if (substitution) {
              cmd = cmd.replace(substitution.pat, substitution.rep);
            }
            writeStdout(cmd + '\r\n');
            exitCode = await this.execute(cmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          } else {
            // Default: fc with no flags — in bash opens editor, here just list last 16
            let first = hist.length - 16, last = hist.length - 1;
            first = Math.max(0, first);
            const entries: string[] = [];
            for (let hi = first; hi <= last; hi++) {
              entries.push(`${hi + 1}\t${hist[hi]}`);
            }
            writeStdout(entries.join('\r\n') + '\r\n');
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Registered adapters and parser branches use the same shell-owned operations.
        if (!_builtinDisabled && (effectiveCmdName === 'type' || effectiveCmdName === 'command')) {
          const result = effectiveCmdName === 'type' ? await this.processType(cmdArgs)
            : await this.processCommand(cmdArgs, this.env['__PIPE_STDIN'] ?? lastOutput);
          writeStdout(result.stdout.replace(/\n/g, '\r\n'));
          stderrWriter(result.stderr.replace(/\n/g, '\r\n'));
          exitCode = result.exitCode;
          this.lastExitCode = exitCode; this.env['?'] = String(exitCode);
          lastOutput = ''; continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'hash') {
          const result = await this.processHash(cmdArgs);
          writeStdout(result.stdout.replace(/\n/g,'\r\n'));
          stderrWriter(result.stderr.replace(/\n/g,'\r\n'));
          exitCode = result.exitCode;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: getopts OPTSTRING VAR [args...]
        if (!_builtinDisabled && effectiveCmdName === 'getopts') {
          if (cmdArgs.length < 2) {
            stderrWriter('getopts: usage: getopts optstring name [arg ...]\r\n');
            exitCode = 1;
          } else {
            const optstring = cmdArgs[0];
            const varName = cmdArgs[1];
            // Use positional params if no extra args
            const args = cmdArgs.length > 2 ? cmdArgs.slice(2) : this.getPositionalArgs();
            const optind = parseInt(this.env['OPTIND'] || '1', 10);

            if (optind > args.length) {
              // No more arguments
              this.env[varName] = '?';
              exitCode = 1;
            } else {
              const arg = args[optind - 1];
              if (arg.startsWith('-') && arg.length > 1 && arg !== '--') {
                const opt = arg[1];
                const colonIdx = optstring.indexOf(opt);
                if (colonIdx < 0) {
                  // Unknown option
                  this.env[varName] = '?';
                  this.env['OPTARG'] = opt;
                  if (!optstring.startsWith(':') && this.env.OPTERR !== '0') stderrWriter(`getopts: illegal option -- ${opt}\r\n`);
                  this.env['OPTIND'] = String(optind + 1);
                  exitCode = 0;
                } else if (optstring[colonIdx + 1] === ':') {
                  // Option requires argument
                  if (arg.length > 2) {
                    // Argument attached: -fvalue
                    this.env[varName] = opt;
                    this.env['OPTARG'] = arg.slice(2);
                    this.env['OPTIND'] = String(optind + 1);
                  } else if (optind < args.length) {
                    // Next argument is the value
                    this.env[varName] = opt;
                    this.env['OPTARG'] = args[optind];
                    this.env['OPTIND'] = String(optind + 2);
                  } else {
                    // Missing argument
                    this.env[varName] = '?';
                    stderrWriter(`getopts: option requires an argument -- ${opt}\r\n`);
                    this.env['OPTIND'] = String(optind + 1);
                  }
                  exitCode = 0;
                } else {
                  // Boolean option
                  this.env[varName] = opt;
                  delete this.env['OPTARG'];
                  // Handle bundled options: -abc
                  if (arg.length > 2) {
                    // Rewrite arg to remaining options for next call
                    args[optind - 1] = '-' + arg.slice(2);
                  } else {
                    this.env['OPTIND'] = String(optind + 1);
                  }
                  exitCode = 0;
                }
              } else {
                // Non-option argument or --
                this.env[varName] = '?';
                if (arg === '--') this.env['OPTIND'] = String(optind + 1);
                exitCode = 1;
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: alias / unalias
        if (!_builtinDisabled && effectiveCmdName === 'alias') {
          if (cmdArgs.length === 0) {
            // List all aliases
            for (const [name, value] of this.aliases) {
              writeStdout(`alias ${name}='${value}'\r\n`);
            }
          } else {
            for (const arg of cmdArgs) {
              const eqIdx = arg.indexOf('=');
              if (eqIdx >= 0) {
                this.aliases.set(arg.substring(0, eqIdx), arg.substring(eqIdx + 1));
              } else {
                const val = this.aliases.get(arg);
                if (val !== undefined) {
                  writeStdout(`alias ${arg}='${val}'\r\n`);
                } else {
                  stderrWriter(`bash: line ${this.currentLine}: alias: ${arg}: not found\r\n`);
                  exitCode = 1;
                }
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'unalias') {
          if (cmdArgs.length === 0) {
            stderrWriter('unalias: usage: unalias [-a] name ...\r\n');
            exitCode = 1;
          } else if (cmdArgs[0] === '-a') {
            this.aliases.clear();
          } else {
            for (const name of cmdArgs) {
              if (!this.aliases.delete(name)) {
                stderrWriter(`unalias: ${name}: not found\r\n`);
                exitCode = 1;
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: pushd / popd / dirs
        if (!_builtinDisabled && effectiveCmdName === 'pushd') {
          if (cmdArgs.length === 0) {
            // Swap top two entries
            if (this.dirStack.length === 0) {
              stderrWriter('pushd: no other directory\r\n');
              exitCode = 1;
            } else {
              const top = this.dirStack.pop()!;
              this.dirStack.push(this.cwd);
              try {
                const resolved = this.fs.resolvePath(top, this.cwd);
                await this.fs.stat(resolved);
                this.cwd = resolved;
                this.env['PWD'] = resolved;
              } catch {
                stderrWriter(`pushd: ${top}: No such file or directory\r\n`);
                exitCode = 1;
              }
            }
          } else {
            const dir = cmdArgs[0];
            const resolved = this.fs.resolvePath(dir, this.cwd);
            try {
              await this.fs.stat(resolved);
              this.dirStack.push(this.cwd);
              this.cwd = resolved;
              this.env['PWD'] = resolved;
            } catch {
              stderrWriter(`pushd: ${dir}: No such file or directory\r\n`);
              exitCode = 1;
            }
          }
          if (exitCode === 0) {
            writeStdout(`${this.cwd} ${this.dirStack.slice().reverse().join(' ')}\r\n`);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'popd') {
          if (this.dirStack.length === 0) {
            stderrWriter('popd: directory stack empty\r\n');
            exitCode = 1;
          } else {
            const dir = this.dirStack.pop()!;
            this.cwd = dir;
            this.env['PWD'] = dir;
            writeStdout(`${this.cwd} ${this.dirStack.slice().reverse().join(' ')}\r\n`);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'dirs') {
          const stack = [this.cwd, ...this.dirStack.slice().reverse()];
          const home = this.env['HOME'];
          const display = (p:string) => !cmdArgs.includes('-l') && home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
          writeStdout(stack.map(display).join(' ') + '\r\n');
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }

        // Shell builtin: let "expr" — evaluate arithmetic, return 1 if result is 0
        if (!_builtinDisabled && effectiveCmdName === 'let') {
          if (cmdArgs.length === 0) {
            stderrWriter('let: usage: let expression\r\n');
            exitCode = 1;
          } else {
            let result = 0;
            for (const expr of cmdArgs) {
              result = this.evalArithmetic(expr);
            }
            exitCode = result === 0 ? 1 : 0;
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: shift — shift positional parameters
        if (!_builtinDisabled && effectiveCmdName === 'shift') {
          const n = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) : 1;
          if (isNaN(n) || n < 0) {
            stderrWriter('shift: numeric argument required\r\n');
            exitCode = 1;
          } else {
            const count = parseInt(this.env['#'] || '0', 10);
            if (n > count) {
              exitCode = 1;
            } else {
              const args = this.getPositionalArgs();
              const shifted = args.slice(n);
              // Clear old params
              for (let si = 1; si <= count; si++) delete this.env[String(si)];
              // Set new params
              for (let si = 0; si < shifted.length; si++) this.env[String(si + 1)] = shifted[si];
              this.env['#'] = String(shifted.length);
              this.env['@'] = shifted.join(' ');
              exitCode = 0;
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: unset — remove variables or functions
        if (!_builtinDisabled && effectiveCmdName === 'unset') {
          let unsetFunc = false;
          const unsetNames: string[] = [];
          for (const arg of cmdArgs) {
            if (arg === '-f') { unsetFunc = true; continue; }
            if (arg === '-v') { unsetFunc = false; continue; }
            unsetNames.push(arg);
          }
          exitCode = 0;
          for (const name of unsetNames) {
            if (unsetFunc) {
              delete this.functions[name];
            } else {
              // Check for array element: arr[idx]
              const bracketMatch = name.match(/^(\w+)\[(.+)\]$/);
              if (bracketMatch) {
                const arrName = bracketMatch[1];
                const idx = bracketMatch[2];
                const assoc = this.assocArrays.get(arrName);
                if (assoc) {
                  assoc.delete(idx);
                } else {
                  const arr = this.arrays.get(arrName);
                  if (arr) {
                    const numIdx = parseInt(idx, 10);
                    if (!isNaN(numIdx) && numIdx >= 0 && numIdx < arr.length) {
                      arr[numIdx] = '';
                    }
                  }
                }
              } else if (this.readonlyVars.has(name)) {
                stderrWriter(`unset: ${name}: cannot unset: readonly variable\r\n`);
                exitCode = 1;
              } else {
                delete this.env[name];
                this.namerefs.delete(name);
                this.arrays.delete(name);
                this.assocArrays.delete(name);
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: readonly — mark variables as readonly
        if (!_builtinDisabled && effectiveCmdName === 'readonly') {
          exitCode = 0;
          if (cmdArgs.length === 0 || (cmdArgs.length === 1 && cmdArgs[0] === '-p')) {
            // List readonly variables
            for (const name of [...this.readonlyVars].sort()) {
              const val = this.env[name];
              writeStdout(`declare -r ${name}${val !== undefined ? `="${val}"` : ''}\r\n`);
            }
          } else {
            for (const arg of cmdArgs) {
              if (arg === '-p') continue;
              const eqIdx = arg.indexOf('=');
              if (eqIdx !== -1) {
                const name = arg.slice(0, eqIdx);
                const val = arg.slice(eqIdx + 1);
                if (this.readonlyVars.has(name)) {
                  stderrWriter(`readonly: ${name}: readonly variable\r\n`);
                  exitCode = 1;
                } else {
                  this.env[name] = val;
                  this.readonlyVars.add(name);
                }
              } else {
                this.readonlyVars.add(arg);
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: export — set/list exported variables
        if (!_builtinDisabled && effectiveCmdName === 'export') {
          exitCode = 0;
          if (cmdArgs.length === 0 || (cmdArgs.length === 1 && cmdArgs[0] === '-p')) {
            const lines = Object.entries(this.env)
              .filter(([k]) => !k.match(/^[0-9?#@*!_$]$/))
              .map(([k, v]) => `declare -x ${k}="${v}"`)
              .sort();
            for (const l of lines) writeStdout(l + '\r\n');
          } else {
            for (const arg of cmdArgs) {
              if (arg === '-p' || arg === '-n') continue;
              const eqIdx = arg.indexOf('=');
              if (eqIdx !== -1) {
                const name = arg.slice(0, eqIdx);
                const val = arg.slice(eqIdx + 1);
                this.env[name] = val;
              }
              // In browser shell, all variables are effectively exported
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: set -- args (positional parameter assignment)
        if (!_builtinDisabled && effectiveCmdName === 'set') {
          // Check for -- to set positional parameters
          const ddIdx = cmdArgs.indexOf('--');
          if (ddIdx >= 0) {
            const newArgs = cmdArgs.slice(ddIdx + 1);
            // Clear old positional params
            const oldCount = parseInt(this.env['#'] || '0', 10);
            for (let si = 1; si <= oldCount; si++) delete this.env[String(si)];
            // Set new positional params
            for (let si = 0; si < newArgs.length; si++) this.env[String(si + 1)] = newArgs[si];
            this.env['#'] = String(newArgs.length);
            this.env['@'] = newArgs.join(' ');
            exitCode = 0;
          } else {
            // Handle set -e, -x, etc. inline
            for (let si = 0; si < cmdArgs.length; si++) {
              const arg = cmdArgs[si];
              if (arg === '-o' || arg === '+o') {
                const optName = cmdArgs[++si];
                if (!optName) {
                  const allOpts = ['errexit', 'nounset', 'xtrace', 'verbose', 'noexec', 'pipefail'];
                  for (const opt of allOpts) {
                    writeStdout(`${opt.padEnd(15)}\t${this.options.has(opt) ? 'on' : 'off'}\r\n`);
                  }
                } else {
                  const optMap: Record<string, string> = { errexit: 'errexit', nounset: 'nounset', xtrace: 'xtrace', verbose: 'verbose', noexec: 'noexec', pipefail: 'pipefail', hashall:'hashall' };
                  const mapped = optMap[optName];
                  if (mapped) {
                    if (arg === '-o') this.options.add(mapped);
                    else this.options.delete(mapped);
                  } else {
                    stderrWriter(`set: ${optName}: invalid option name\r\n`);
                    exitCode = 1;
                  }
                }
                continue;
              }
              const shortMap: Record<string, string> = { e: 'errexit', u: 'nounset', x: 'xtrace', v: 'verbose', n: 'noexec', h:'hashall' };
              if (arg.startsWith('-') && arg.length > 1 && arg[1] !== '-') {
                for (let j = 1; j < arg.length; j++) {
                  const mapped = shortMap[arg[j]];
                  if (mapped) this.options.add(mapped);
                }
              } else if (arg.startsWith('+') && arg.length > 1) {
                for (let j = 1; j < arg.length; j++) {
                  const mapped = shortMap[arg[j]];
                  if (mapped) this.options.delete(mapped);
                }
              }
            }
            exitCode = 0;
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: source / . — execute script in current shell scope
        if (!_builtinDisabled && effectiveCmdName === 'source') {
          if (cmdArgs.length === 0) {
            stderrWriter('source: filename argument required\r\n');
            exitCode = 1;
          } else {
            const scriptPath = this.fs.resolvePath(cmdArgs[0], this.cwd);
            try {
              const raw = await this.fs.readFile(scriptPath);
              const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
              // Save/restore LINENO across source calls
              const savedLine = this.currentLine;
              const savedArgs = this.getPositionalArgs();
              const suppliedArgs = cmdArgs.length > 1;
              const setArgs = (values: string[]) => {
                for (let n = 1; n <= Math.max(values.length, Number(this.env['#'] || 0)); n++) delete this.env[String(n)];
                this.env['#'] = String(values.length);
                values.forEach((value, n) => { this.env[String(n + 1)] = value; });
              };
              if (suppliedArgs) setArgs(cmdArgs.slice(1));
              this.currentLine = 1;
              try {
                exitCode = await this.execute(content, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
              } finally {
                if (suppliedArgs) setArgs(savedArgs);
                this.currentLine = savedLine;
                this.env['LINENO'] = String(this.currentLine);
              }
            } catch (e: any) {
              stderrWriter(`source: ${cmdArgs[0]}: ${e.message}\r\n`);
              exitCode = 1;
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // exec without a command changes descriptors; with argv it terminates this shell.
        if (!_builtinDisabled && effectiveCmdName === 'exec') {
          // Handle FD redirects: exec N< file, exec N> file, exec N<&-
          for (const redir of redirects) {
            if (redir.fd !== undefined && redir.type === '<') {
              try {
                const content = await this.fs.readFile(this.fs.resolvePath(redir.target, this.cwd), 'utf8') as string;
                this.fileDescriptors.set(redir.fd, { content, offset: 0 });
              } catch (e: any) {
                stderrWriter(`bash: line ${this.currentLine}: ${redir.target}: ${filesystemError(e)}\r\n`);
                exitCode = 1;
              }
            } else if (redir.fd !== undefined && redir.type === '>&-') {
              this.fileDescriptors.delete(redir.fd);
            }
          }
          if (cmdArgs.length > 0) {
            const result = await this.execArgv(cmdArgs, this.env['__PIPE_STDIN'] ?? lastOutput, true);
            writeStdout(result.stdout.replace(/\n/g, '\r\n'));
            stderrWriter(result.stderr.replace(/\n/g, '\r\n'));
            exitCode = result.exitCode;
            this.requestExit(exitCode);
          } else {
            const out = [...redirects].reverse().find(r => r.type === '>' || r.type === '>>');
            if (out) {
              this.stdoutFile = this.fs.resolvePath(out.target, this.cwd);
              if (out.type === '>') await this.fs.writeFile(this.stdoutFile, '');
              else await this.fs.appendFile(this.stdoutFile, '');
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: builtin — run builtin ignoring functions
        if (!_builtinDisabled && effectiveCmdName === 'builtin') {
          if (cmdArgs.length > 0) {
            if (!SHELL_BUILTINS.includes(cmdArgs[0]) || this.disabledBuiltins.has(cmdArgs[0])) {
              stderrWriter(`bash: builtin: ${cmdArgs[0]}: not a shell builtin\r\n`);
              exitCode = 1;
            } else {
              const result = await this.execArgv(cmdArgs,this.env['__PIPE_STDIN'] ?? lastOutput,true);
              writeStdout(result.stdout.replace(/\n/g,'\r\n'));
              stderrWriter(result.stderr.replace(/\n/g,'\r\n'));
              exitCode = result.exitCode;
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell stubs for commonly expected builtins (no-ops that scripts depend on)
        if (!_builtinDisabled && effectiveCmdName === 'ulimit') {
          stderrWriter(ULIMIT_UNAVAILABLE.replace(/\n/g, '\r\n'));
          exitCode = 2;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'umask') {
          const result = processUmask(this.umask,cmdArgs);
          this.umask = result.mask;
          if (result.stdout) writeStdout(result.stdout.replace(/\n/g,'\r\n'));
          if (result.stderr) stderrWriter(result.stderr.replace(/\n/g,'\r\n'));
          exitCode = result.status;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'compopt') {
          const add:string[] = [], remove:string[] = [], names:string[] = [];
          for (let n = 0; n < cmdArgs.length; n++) {
            if (cmdArgs[n] === '-o') add.push(cmdArgs[++n]);
            else if (cmdArgs[n] === '+o') remove.push(cmdArgs[++n]);
            else names.push(cmdArgs[n]);
          }
          for (const name of names) {
            const spec = this.completionSpecs.get(name);
            if (!spec) {stderrWriter(`bash: line ${this.currentLine}: compopt: ${name}: no completion specification\r\n`); exitCode = 1; continue;}
            spec.options = [...new Set([...(spec.options ?? []), ...add])].filter(o => !remove.includes(o));
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (effectiveCmdName === 'enable') {
          // enable [-n] [-a] [-p] [name ...]
          // -n: disable builtins, -a: print all (enabled+disabled), -p: print in reusable format
          let disableMode = false;
          let printAll = false;
          let printMode = false;
          const names: string[] = [];
          for (const a of cmdArgs) {
            if (a === '-n') disableMode = true;
            else if (a === '-a') printAll = true;
            else if (a === '-p') printMode = true;
            else if (!a.startsWith('-')) names.push(a);
          }
          // List of all shell builtins
          const allBuiltins = [
            '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller',
            'cd', 'command', 'compgen', 'complete', 'compopt', 'continue',
            'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec',
            'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help',
            'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile',
            'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly',
            'return', 'select', 'set', 'shift', 'shopt', 'source', 'test',
            'time', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask',
            'unalias', 'unset', 'wait',
          ];
          if (names.length === 0) {
            // Print mode
            if (printAll || printMode) {
              for (const b of allBuiltins) {
                const disabled = this.disabledBuiltins.has(b);
                if (printAll || !disabled) {
                  writeStdout(`enable ${disabled ? '-n ' : ''}${b}\r\n`);
                }
              }
            } else {
              // Default: show enabled builtins
              for (const b of allBuiltins) {
                if (!this.disabledBuiltins.has(b)) {
                  writeStdout(`enable ${b}\r\n`);
                }
              }
            }
          } else {
            // Enable or disable named builtins
            for (const name of names) {
              if (disableMode) {
                this.disabledBuiltins.add(name);
              } else {
                this.disabledBuiltins.delete(name);
              }
            }
          }
          exitCode = 0;
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'complete') {
          // Programmable completion: parse and store specs
          let spec: CompletionSpec = {};
          let printMode = false;
          let removeMode = false;
          const completeCmds: string[] = [];

          for (let ai = 0; ai < cmdArgs.length; ai++) {
            const a = cmdArgs[ai];
            if (a === '-o') {
              (spec.options ??= []).push(cmdArgs[++ai]);
            } else if (a === '-W') {
              const wordStr = cmdArgs[++ai] || '';
              spec.words = wordStr.split(/\s+/).filter(Boolean);
            } else if (a === '-F') {
              spec.funcName = cmdArgs[++ai] || '';
            } else if (a === '-A') {
              spec.action = cmdArgs[++ai] || '';
            } else if (a === '-P') {
              spec.prefix = cmdArgs[++ai] || '';
            } else if (a === '-S') {
              spec.suffix = cmdArgs[++ai] || '';
            } else if (a === '-p') {
              printMode = true;
            } else if (a === '-r') {
              removeMode = true;
            } else if (!a.startsWith('-')) {
              completeCmds.push(a);
            }
          }

          if (printMode) {
            if (completeCmds.length > 0) {
              for (const cmd of completeCmds) {
                const s = this.completionSpecs.get(cmd);
                if (s) writeStdout(this.formatCompleteSpec(cmd, s) + '\r\n');
                else {stderrWriter(`bash: line ${this.currentLine}: complete: ${cmd}: no completion specification\r\n`); exitCode = 1;}
              }
            } else {
              for (const [cmd, s] of this.completionSpecs) {
                writeStdout(this.formatCompleteSpec(cmd, s) + '\r\n');
              }
            }
          } else if (removeMode) {
            for (const cmd of completeCmds) {
              this.completionSpecs.delete(cmd);
            }
          } else {
            for (const cmd of completeCmds) {
              this.completionSpecs.set(cmd, spec);
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'compgen') {
          let words: string[] = [];
          let prefix = '';
          const builtinNames = ['cd', 'echo', 'read', 'eval', 'set', 'export', 'source', 'shift',
            'declare', 'local', 'typeset', 'true', 'false', 'break', 'continue', 'return',
            'trap', 'getopts', 'printf', 'type', 'command', 'hash', 'mapfile', 'readarray',
            'select', 'alias', 'unalias', 'pushd', 'popd', 'dirs', 'let', 'exec', 'builtin',
            'ulimit', 'umask', 'complete', 'compgen', 'enable', 'disown', 'unset', 'readonly',
            'time', 'caller', 'shopt', 'fc'];
          for (let ai = 0; ai < cmdArgs.length; ai++) {
            const a = cmdArgs[ai];
            if (a === '-W') {
              // Word list — next arg is the list (space-separated words)
              const wordStr = cmdArgs[++ai] || '';
              words.push(...wordStr.split(/\s+/).filter(Boolean));
            } else if (a === '-b') {
              words.push(...builtinNames);
            } else if (a === '-c') {
              // All commands: builtins + registered + functions
              words.push(...builtinNames);
              words.push(...this.commands.list().map((c: { name: string }) => c.name));
              words.push(...Object.keys(this.functions));
            } else if (a === '-a') {
              words.push(...this.aliases.keys());
            } else if (a === '-v') {
              words.push(...Object.keys(this.env));
              words.push(...this.arrays.keys());
              words.push(...this.assocArrays.keys());
            } else if (a === '-e' || a === '-f') {
              // File completion — list files in cwd
              try {
                const entries = await this.fs.readdir(this.cwd);
                words.push(...entries);
              } catch { /* ignore */ }
            } else if (a === '-d') {
              // Directory completion
              try {
                const entries = await this.fs.readdir(this.cwd);
                for (const e of entries) {
                  try {
                    const s = await this.fs.stat(this.fs.resolvePath(e, this.cwd));
                    if (s.type === 'dir') words.push(e);
                  } catch { /* skip */ }
                }
              } catch { /* ignore */ }
            } else if (a === '-A') {
              const action = cmdArgs[++ai] || '';
              if (action === 'function') words.push(...Object.keys(this.functions));
              else if (action === 'alias') words.push(...this.aliases.keys());
              else if (action === 'variable') { words.push(...Object.keys(this.env)); words.push(...this.arrays.keys()); }
              else if (action === 'builtin') words.push(...builtinNames);
              else if (action === 'command') { words.push(...builtinNames); words.push(...this.commands.list().map((c: { name: string }) => c.name)); }
            } else if (!a.startsWith('-')) {
              prefix = a;
            }
          }
          // Filter by prefix
          if (prefix) {
            words = words.filter(w => w.startsWith(prefix));
          }
          // De-duplicate
          words = [...new Set(words)];
          if (words.length > 0) {
            writeStdout(words.join('\r\n') + '\r\n');
          }
          exitCode = words.length > 0 ? 0 : 1;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'coproc') {
          stderrWriter('bash: coproc: process file descriptors are unsupported; select native execution\r\n');
          exitCode = 2;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'disown') {
          // disown: remove jobs from job table
          if (cmdArgs.length === 0 || cmdArgs.includes('-a')) {
            // Remove all jobs (or current job)
            if (cmdArgs.includes('-a')) {
              for (const [id, job] of this.backgroundJobs) {
                if (job.status !== 'running') this.backgroundJobs.delete(id);
              }
            }
            // With no args, remove most recent
            else {
              const ids = [...this.backgroundJobs.keys()];
              if (ids.length > 0) this.backgroundJobs.delete(ids[ids.length - 1]);
            }
          } else if (cmdArgs.includes('-r')) {
            // Remove only running jobs
            for (const [id, job] of this.backgroundJobs) {
              if (job.status === 'running') this.backgroundJobs.delete(id);
            }
          } else {
            // Remove specific job(s)
            for (const arg of cmdArgs) {
              if (arg.startsWith('-')) continue;
              const jobId = parseInt(arg.replace('%', ''), 10);
              if (this.backgroundJobs.has(jobId)) {
                this.backgroundJobs.delete(jobId);
              } else {
                stderrWriter(`disown: ${arg}: no such job\r\n`);
                exitCode = 1;
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Handle stdin redirect (<). The first command of a function, group or loop body
        // piped into reads that input (__PIPE_STDIN), unless it has a heredoc.
        let stdin = i > 0 ? lastOutput : (heredocStdin ? '' : (this.env['__PIPE_STDIN'] ?? ''));
        let inputFailed = false;
        for (const redir of redirects) {
          if (redir.type === '<') {
            if (redir.target === '/dev/null') {
              stdin = '';
              continue;
            }
            // /dev/stdin reads from pipe input
            if (redir.target === '/dev/stdin') {
              stdin = i > 0 ? lastOutput : (heredocStdin || '');
              continue;
            }
            const procSub = /^<\(([\s\S]*)\)$/.exec(redir.target);
            if (procSub) { stdin = (await this.exec(procSub[1])).stdout; continue; }   // < <(cmd)
            const targetPath = this.fs.resolvePath(redir.target, this.cwd);
            try {
              stdin = await this.fs.readFile(targetPath, 'utf8') as string;
            } catch (e: any) {
              stderrWriter(`bash: line ${this.currentLine}: ${redir.target}: ${filesystemError(e)}\r\n`);
              inputFailed = true;
              break;
            }
          }
        }
        // The command doesn't run and fails; in a pipeline the next command reads nothing and the
        // pipeline's status is the last command's, as in bash (`tr x < missing | cat` exits 0).
        if (inputFailed) {
          exitCode = 1; this.lastExitCode = 1; this.env['?'] = '1';
          pipeExitCodes.push(1);
          lastOutput = '';
          continue;
        }

        // Inject heredoc content as stdin if present and this is the first pipeline segment
        if (heredocStdin && i === 0 && !stdin) {
          stdin = heredocStdin;
        }

        // Here-string (<<<) overrides stdin
        if (hereString) {
          stdin = hereString;
        }

        const ctx: CommandContext = {
          args: cmdArgs,
          fs: this.fs,
          cwd: this.cwd,
          env: this.env,
          stdin,
          stdout: '',
          stderr: '',
          shell: this,
          terminal: terminalOverride || this.terminal,
        };

        // Shell functions (and hoisted groups) first. Their output is captured like a command's,
        // so the pipe and redirect handling below applies; piped or redirected input is
        // available to `read` inside through __PIPE_STDIN.
        const resolved = await this.resolveCommand(effectiveCmdName, invocation?.skipFunctions, !!invocation, {pathOverride:invocation?.pathOverride});
        if (resolved?.kind === 'file' && !resolved.hashed && !effectiveCmdName.includes('/') && this.options.has('hashall') && !this.temporaryPath) {
          this.commandHashes.set(effectiveCmdName,{path:resolved.hashPath ?? resolved.path ?? '/usr/bin/' + effectiveCmdName,hits:1});
        }
        const fn = resolved?.route === 'function' ? this.functions[effectiveCmdName] : undefined;
        const cmd = fn || resolved?.route === 'path' ? undefined : resolved?.command;
        if (fn) {
          let fout = '', ferr = '';
          const capOut = (s: string) => { fout += s; };
          const capErr = (s: string) => { ferr += s; };
          const feedsStdin = i > 0 || stdin !== '';
          const hadPipe = '__PIPE_STDIN' in this.env;
          const savedPipe = this.env['__PIPE_STDIN'];
          if (feedsStdin) this.env['__PIPE_STDIN'] = stdin;
          try {
            if (fn.group === 'brace') {
              exitCode = await this.execute(fn.body, capOut, capErr, false, terminalOverride || this.terminal, true);
            } else if (fn.group === 'subshell') {
              const r = await this.fork().exec(fn.body);
              fout = r.stdout; ferr = r.stderr; exitCode = r.exitCode;
            } else {
              exitCode = await this.execFunction(effectiveCmdName, cmdArgs, capOut, capErr);
            }
          } finally {
            if (feedsStdin) { if (hadPipe) this.env['__PIPE_STDIN'] = savedPipe!; else delete this.env['__PIPE_STDIN']; }
          }
          ctx.stdout = fout.replace(/\r\n/g, '\n');
          ctx.stderr = ferr.replace(/\r\n/g, '\n');
        } else if (cmd) {
          try {
            exitCode = await cmd.exec(ctx);
          } catch (e: any) {
            ctx.stderr += e.message + '\n';
            exitCode = 1;
          }
        } else {
          // Try to find executable in PATH
          const executable = resolved?.path;
          if (executable) {
            try {
              exitCode = await this.executeScript(executable, cmdArgs, ctx, writeStdout, stderrWriter);
            } catch (e: any) {
              ctx.stderr += e.message + '\n';
              exitCode = 1;
            }
          } else {
            // Check if a WASM package is available for this command
            const wasmPkg = isAvailableAsPackage(effectiveCmdName);
            if (wasmPkg) {
              try {
                exitCode = await runPackageCommand(ctx, effectiveCmdName);
              } catch (e: any) {
                const { WasiExit } = await loadWasiRuntime();
                if (e instanceof WasiExit) {
                  exitCode = e.code;
                  // Still write stubs on non-zero exit — package is installed
                  await writePackageStubs(this.fs, wasmPkg.name);
                } else {
                  stderrWriter(`shiro: failed to run ${wasmPkg.name}: ${e.message}\r\n`);
                  exitCode = 1;
                }
              }
            } else {
              stderrWriter(`shiro: command not found: ${effectiveCmdName}\r\n`);
              exitCode = 127;
              this.lastExitCode = exitCode;
              this.env['?'] = String(exitCode);
              break;
            }
          }
        }

        if (ctx.stderr) stderrWriter(ctx.stderr.replace(/\n/g, '\r\n'));
        if (ctx.stdout) writeStdout(ctx.stdout.replace(/\n/g, '\r\n'));
        lastOutput = ctx.stdout;
        pipeExitCodes.push(exitCode);

        // Update cwd from env
        this.cwd = this.env['PWD'] || this.cwd;
      }

      if (restorePrefix) { restorePrefix(); restorePrefix = null; }
      await this.redirectWrites;
      writeStdout = baseWriteStdout;
      stderrWriter = baseStderrWriter;

      // pipefail: use last non-zero exit code from any pipe segment
      if (this.options.has('pipefail') && pipeExitCodes.length > 1) {
        const lastNonZero = [...pipeExitCodes].reverse().find(c => c !== 0);
        if (lastNonZero !== undefined) exitCode = lastNonZero;
      }

      // Store PIPESTATUS array
      this.arrays.set('PIPESTATUS', pipeExitCodes.map(String));

      // Apply ! negation
      if (negateExit) {
        exitCode = exitCode === 0 ? 1 : 0;
      }

      this.lastExitCode = exitCode;
      this.env['?'] = String(exitCode);

      // Fire ERR trap on non-zero exit code
      if (exitCode !== 0 && this.traps.has('ERR')) {
        const errCmd = this.traps.get('ERR')!;
        await this.execute(errCmd, writeStdout, stderrWriter);
      }

      // errexit: abort on non-zero exit from commands NOT in && / || chains
      if (this.options.has('errexit') && exitCode !== 0 && !negateExit) {
        // Don't abort if this command is part of a && or || chain
        const compIdx = compounds.indexOf(compound);
        const thisOp = compound.operator;
        const nextOp = compIdx + 1 < compounds.length ? compounds[compIdx + 1].operator : '';
        const inChain = thisOp === '&&' || thisOp === '||' || nextOp === '&&' || nextOp === '||';
        if (!inChain) break;
      }
    }

    this.executeDepth--;
    if (isTopLevel) {
      this.abortController = null;
    }
    return this.requestedExit ?? exitCode;
  }

  /**
   * Expand brace expressions: {a,b,c} → a b c, {1..5} → 1 2 3 4 5
   * Handles prefix/suffix: pre{a,b}suf → preasuf prebsuf
   * Respects quoting: '{a,b}' is literal.
   */
  private expandBraces(input: string): string {
    // Quick check: no braces at all
    if (!input.includes('{')) return input;

    // Check if any { is unquoted — if all braces are inside quotes, skip expansion
    let hasUnquotedBrace = false;
    let bSQ = false, bDQ = false;
    for (let bi = 0; bi < input.length; bi++) {
      const bc = input[bi];
      if (bc === '\\' && !bSQ) { bi++; continue; }
      if (bc === "'" && !bDQ) { bSQ = !bSQ; continue; }
      if (bc === '"' && !bSQ) { bDQ = !bDQ; continue; }
      if (bc === '{' && !bSQ && !bDQ) {
        // Skip ${...} — parameter expansion, not brace expansion
        if (bi > 0 && input[bi - 1] === '$') continue;
        hasUnquotedBrace = true;
        break;
      }
    }
    if (!hasUnquotedBrace) return input;

    // Expand word by word on the raw text: quotes, escapes and the separators between words
    // stay as they were (tokenizing here dropped them for the whole command).
    let out = '';
    let word = '';
    let inSQ = false, inDQ = false;
    const flush = () => { if (word) { out += this.expandBraceToken(word).join(' '); word = ''; } };
    for (let k = 0; k < input.length; k++) {
      const c = input[k];
      if (c === '\\' && !inSQ) { word += c + (input[k + 1] ?? ''); k++; continue; }
      if (c === "'" && !inDQ) inSQ = !inSQ;
      else if (c === '"' && !inSQ) inDQ = !inDQ;
      if (!inSQ && !inDQ && /[\s;|&<>()]/.test(c)) { flush(); out += c; continue; }
      word += c;
    }
    flush();
    return out;
  }

  private expandBraceToken(token: string): string[] {
    // Don't expand if token contains sentinel-quoted braces or no braces
    if (token.includes('\x01') || !token.includes('{') || !token.includes('}')) return [token];

    // Find the first unquoted { and its matching }, skipping ${...} parameter expansions
    let braceStart = -1;
    let braceEnd = -1;
    let depth = 0;
    let inSQ = false, inDQ = false;
    for (let i = 0; i < token.length; i++) {
      const ch = token[i];
      if (ch === '\\') { i++; continue; }
      if (ch === "'" && !inDQ) { inSQ = !inSQ; continue; }
      if (ch === '"' && !inSQ) { inDQ = !inDQ; continue; }
      if (inSQ || inDQ) continue;
      // Skip ${...} — this is a parameter expansion, not brace expansion
      if (ch === '$' && token[i + 1] === '{') {
        let bd = 1;
        i += 2;
        while (i < token.length && bd > 0) {
          if (token[i] === '{') bd++;
          else if (token[i] === '}') bd--;
          i++;
        }
        i--; // will be incremented by the loop
        continue;
      }
      // Skip $((...)  — arithmetic
      if (ch === '$' && token[i + 1] === '(' && token[i + 2] === '(') {
        i += 2;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) braceStart = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) { braceEnd = i; break; }
      }
    }
    if (braceStart < 0 || braceEnd < 0) return [token];

    const prefix = token.slice(0, braceStart);
    const body = token.slice(braceStart + 1, braceEnd);
    const suffix = token.slice(braceEnd + 1);

    // Check for range: {a..z}, {1..5}, {01..10}
    const rangeMatch = body.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      // The step's sign is ignored: start and end give the direction ({5..1..2} → 5 3 1).
      const step = (rangeMatch[3] ? Math.abs(parseInt(rangeMatch[3])) || 1 : 1) * (start <= end ? 1 : -1);
      const padLen = Math.max(rangeMatch[1].length, rangeMatch[2].length);
      const shouldPad = rangeMatch[1].startsWith('0') || rangeMatch[2].startsWith('0');
      const items: string[] = [];
      if (step > 0) {
        for (let n = start; n <= end; n += step) {
          items.push(shouldPad ? String(n).padStart(padLen, '0') : String(n));
        }
      } else if (step < 0) {
        for (let n = start; n >= end; n += step) {
          items.push(shouldPad ? String(Math.abs(n)).padStart(padLen, '0') : String(n));
        }
      }
      const result: string[] = [];
      for (const item of items) {
        result.push(...this.expandBraceToken(prefix + item + suffix));
      }
      return result;
    }

    // Char range: {a..z}
    const charRange = body.match(/^([a-zA-Z])\.\.([a-zA-Z])$/);
    if (charRange) {
      const startCode = charRange[1].charCodeAt(0);
      const endCode = charRange[2].charCodeAt(0);
      const step = startCode <= endCode ? 1 : -1;
      const items: string[] = [];
      for (let c = startCode; step > 0 ? c <= endCode : c >= endCode; c += step) {
        items.push(String.fromCharCode(c));
      }
      const result: string[] = [];
      for (const item of items) {
        result.push(...this.expandBraceToken(prefix + item + suffix));
      }
      return result;
    }

    // Comma separated: {a,b,c}
    // Split on commas at depth 0
    const parts: string[] = [];
    let current = '';
    let partDepth = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '{') partDepth++;
      else if (ch === '}') partDepth--;
      else if (ch === ',' && partDepth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    parts.push(current);

    if (parts.length <= 1) return [token]; // No comma found, not a brace expansion

    const result: string[] = [];
    for (const part of parts) {
      result.push(...this.expandBraceToken(prefix + part + suffix));
    }
    return result;
  }

  private expandVars(line: string): string {
    // Walk through the string character by character, respecting quote context.
    // In single quotes: no expansion at all (bash behavior).
    // In double quotes: expand $VAR and ${VAR} but NOT ~ or $?.
    // Unquoted: expand everything.
    let result = '';
    let inSingle = false;
    let inDouble = false;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];

      // Track quotes
      if (ch === "'" && !inDouble) { inSingle = !inSingle; result += ch; i++; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; result += ch; i++; continue; }

      // Inside single quotes: everything is literal
      if (inSingle) { result += ch; i++; continue; }

      // Handle backslash (skip next char)
      if (ch === '\\' && i + 1 < line.length) { result += ch + line[i + 1]; i += 2; continue; }

      // Expand $$ (process ID)
      if (ch === '$' && line[i + 1] === '$') {
        result += '1';
        i += 2;
        continue;
      }

      // Expand $? (last exit code)
      if (ch === '$' && line[i + 1] === '?') {
        result += String(this.lastExitCode);
        i += 2;
        continue;
      }

      // Expand $@ and $* (all positional parameters)
      // Bash behavior: "$@" with no args expands to nothing (zero words)
      if (ch === '$' && (line[i + 1] === '@' || line[i + 1] === '*')) {
        const val = this.env['@'] ?? '';
        if (line[i + 1] === '@' && inDouble && val !== '') {
          // "$@" is one word per parameter, even with spaces in them.
          result += this.quotedWords(this.positionalParams());
          i += 2;
          continue;
        }
        if (line[i + 1] === '*' && inDouble) {
          // "$*" is one word: the parameters joined with the first character of IFS.
          const ifs = this.env['IFS'] ?? ' \t\n';
          result += this.positionalParams().join(ifs.slice(0, 1)).replace(/[\\"$`]/g, '\\$&');
          i += 2;
          continue;
        }
        if (val === '' && inDouble) {
          // Remove the opening quote already appended
          if (result.endsWith('"')) result = result.slice(0, -1);
          i += 2;
          // Consume the closing quote
          if (i < line.length && line[i] === '"') { inDouble = false; i++; }
        } else {
          result += val;
          i += 2;
        }
        continue;
      }

      // Expand $# (number of positional parameters)
      if (ch === '$' && line[i + 1] === '#') {
        result += this.env['#'] ?? '0';
        i += 2;
        continue;
      }

      // Expand $0-$9 (positional parameters)
      if (ch === '$' && line[i + 1] >= '0' && line[i + 1] <= '9') {
        result += this.env[line[i + 1]] ?? '';
        i += 2;
        continue;
      }

      // Expand ${VAR} and parameter expansion operators
      if (ch === '$' && line[i + 1] === '{') {
        // Count brace depth to find matching }
        let depth = 0;
        let j = i + 1;
        let braceInSQ = false, braceInDQ = false;
        while (j < line.length) {
          const bc = line[j];
          if (bc === "'" && !braceInDQ) braceInSQ = !braceInSQ;
          else if (bc === '"' && !braceInSQ) braceInDQ = !braceInDQ;
          else if (!braceInSQ && !braceInDQ) {
            if (bc === '{') depth++;
            else if (bc === '}') { depth--; if (depth === 0) break; }
          }
          j++;
        }
        if (depth === 0 && j < line.length) {
          const inner = line.slice(i + 2, j); // content between ${ and }
          // "${arr[@]}" is one word per element, even with spaces in them.
          // "${!arr[@]}" likewise, one word per key.
          const allElems = inDouble ? inner.match(/^(!?)([A-Za-z_][A-Za-z0-9_]*)\[@\]$/) : null;
          if (allElems) {
            const assoc = this.assocArrays.get(allElems[2]);
            const arr = this.arrays.get(allElems[2]) ?? [];
            const elems = allElems[1]
              ? (assoc ? Array.from(assoc.keys()) : arr.map((_, k) => String(k)))
              : (assoc ? Array.from(assoc.values()) : arr);
            if (elems.length) {
              result += this.quotedWords(elems);
              i = j + 1;
              continue;
            }
          }
          const expanded = this.expandParamExpression(inner);
          if (expanded !== null) {
            result += expanded;
            i = j + 1;
            continue;
          }
        }
      }

      // Expand $VAR (including special dynamic variables)
      if (ch === '$') {
        const m = line.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
        if (m) {
          const varName = m[1];
          // Dynamic special variables
          if (varName === 'RANDOM') { result += String(Math.floor(Math.random() * 32768)); i += m[0].length; continue; }
          if (varName === 'BASH_VERSION') { result += '5.0.0'; i += m[0].length; continue; }
          if (varName === 'HOSTNAME') { result += 'shiro'; i += m[0].length; continue; }
          if (varName === 'PPID') { result += '0'; i += m[0].length; continue; }
          if (varName === 'LINENO') { result += (this.env['LINENO'] || '1'); i += m[0].length; continue; }
          if (varName === 'SECONDS') { result += String(Math.floor(performance.now() / 1000)); i += m[0].length; continue; }
          if (varName === 'EPOCHSECONDS') { result += String(Math.floor(Date.now() / 1000)); i += m[0].length; continue; }
          if (varName === 'EPOCHREALTIME') { const now = Date.now(); result += `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, '0')}`; i += m[0].length; continue; }
          // Resolve namerefs: if varName is a nameref, follow it
          const resolved = this.namerefs.has(varName) ? this.namerefs.get(varName)! : varName;
          result += this.env[resolved] ?? '';
          i += m[0].length;
          continue;
        }
      }

      // Tilde expansion (only unquoted, not inside operators like =~)
      if (ch === '~' && !inDouble) {
        const before = i === 0 ? '' : line[i - 1];
        const after = line[i + 1] || '';
        // Only expand after = in assignment context (VAR=~), not in operators like =~
        const isAssignContext = before === '=' ? (i >= 2 && /[A-Za-z0-9_]/.test(line[i - 2])) : true;
        if ((i === 0 || /[\s=]/.test(before)) && isAssignContext) {
          // ~+ expands to $PWD, ~- expands to $OLDPWD
          if (after === '+' && (/[\/\s;|&>]/.test(line[i + 2] || '') || i + 2 >= line.length)) {
            result += this.env['PWD'] || this.cwd;
            i += 2;
            continue;
          }
          if (after === '-' && (/[\/\s;|&>]/.test(line[i + 2] || '') || i + 2 >= line.length)) {
            result += this.env['OLDPWD'] || this.cwd;
            i += 2;
            continue;
          }
          if (/[\/\s;|&>]/.test(after) || i + 1 >= line.length) {
            const home = this.env['HOME'] || '/home/user';
            result += home;
            i++;
            continue;
          }
        }
      }

      result += ch;
      i++;
    }
    return result;
  }

  /** The positional parameters $1..$N as a list ($@ keeps them only space-joined). */
  private positionalParams(): string[] {
    const count = parseInt(this.env['#'] ?? '0', 10) || 0;
    const out: string[] = [];
    for (let k = 1; k <= count; k++) out.push(this.env[String(k)] ?? '');
    return out;
  }

  /**
   * Words for "$@" / "${arr[@]}", written inside an open double quote: `a b" "c` — the
   * surrounding quotes close and reopen between words, so each stays one word.
   */
  private quotedWords(words: string[]): string {
    return words.map(w => w.replace(/[\\"$`]/g, '\\$&')).join('" "');
  }

  /**
   * Expand advanced ${...} parameter expressions.
   * Supports: ${#VAR}, ${VAR#pat}, ${VAR##pat}, ${VAR%pat}, ${VAR%%pat},
   * ${VAR/pat/rep}, ${VAR//pat/rep}, ${VAR:offset}, ${VAR:offset:length},
   * ${VAR^^}, ${VAR,,}, ${VAR:-default}, ${VAR:=default}, ${VAR:+alt}, ${VAR:?err}
   */
  private expandParamExpression(inner: string): string | null {
    // ${!arr[@]} or ${!arr[*]} — array indices/keys
    const arrKeysMatch = inner.match(/^!([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/);
    if (arrKeysMatch) {
      const name = arrKeysMatch[1];
      const assoc = this.assocArrays.get(name);
      if (assoc) return Array.from(assoc.keys()).join(' ');
      const arr = this.arrays.get(name);
      return arr ? arr.map((_, i) => String(i)).join(' ') : '';
    }

    // ${#arr[@]} or ${#arr[*]} — array length
    const arrLenMatch = inner.match(/^#([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/);
    if (arrLenMatch) {
      const name = arrLenMatch[1];
      const assoc = this.assocArrays.get(name);
      if (assoc) return String(assoc.size);
      const arr = this.arrays.get(name);
      return String(arr ? arr.length : 0);
    }
    // ${#arr[N]} — length of array element
    const arrElemLenMatch = inner.match(/^#([A-Za-z_][A-Za-z0-9_]*)\[(.+)\]$/);
    if (arrElemLenMatch) {
      const name = arrElemLenMatch[1];
      const key = arrElemLenMatch[2];
      const assoc = this.assocArrays.get(name);
      if (assoc) return String([...(assoc.get(key) ?? '')].length);
      const arr = this.arrays.get(name);
      if (arr) {
        const idx = parseInt(key, 10);
        return String([...(arr[idx] ?? '')].length);
      }
      return '0';
    }

    // ${arr[@]:start:len} or ${arr[@]:start} — array slicing
    const arrSliceMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]:\s*(-?\d+)(?::(-?\d+))?$/);
    if (arrSliceMatch) {
      const name = arrSliceMatch[1];
      const assoc = this.assocArrays.get(name);
      const values = assoc ? Array.from(assoc.values()) : (this.arrays.get(name) ?? []);
      let offset = parseInt(arrSliceMatch[2]);
      if (offset < 0) offset = Math.max(0, values.length + offset);
      if (arrSliceMatch[3] !== undefined) {
        const len = parseInt(arrSliceMatch[3]);
        return values.slice(offset, offset + len).join(' ');
      }
      return values.slice(offset).join(' ');
    }

    // ${arr[@]/pattern/replacement} — pattern replacement on all elements
    const arrPatMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\](\/\/?)(#?%?)(.*?)\/(.*)$/);
    if (arrPatMatch) {
      const name = arrPatMatch[1];
      const doubleSlash = arrPatMatch[2] === '//';
      const anchor = arrPatMatch[3]; // # for prefix, % for suffix
      const pattern = arrPatMatch[4];
      const replacement = arrPatMatch[5];
      const assoc = this.assocArrays.get(name);
      const values = assoc ? Array.from(assoc.values()) : (this.arrays.get(name) ?? []);
      const mapped = values.map(v => {
        if (anchor === '#') {
          // Prefix replacement
          const re = new RegExp('^' + this.globToRegex(pattern));
          return v.replace(re, replacement);
        } else if (anchor === '%') {
          // Suffix replacement
          const re = new RegExp(this.globToRegex(pattern) + '$');
          return v.replace(re, replacement);
        } else if (doubleSlash) {
          // Replace all
          const re = new RegExp(this.globToRegex(pattern), 'g');
          return v.replace(re, replacement);
        } else {
          // Replace first
          const re = new RegExp(this.globToRegex(pattern));
          return v.replace(re, replacement);
        }
      });
      return mapped.join(' ');
    }

    // ${arr[@]@Q} — quote all array elements
    const arrAtOpMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]@([QEUuLA])$/);
    if (arrAtOpMatch) {
      const name = arrAtOpMatch[1];
      const op = arrAtOpMatch[2];
      const assoc = this.assocArrays.get(name);
      const values = assoc ? Array.from(assoc.values()) : (this.arrays.get(name) ?? []);
      const mapped = values.map(v => {
        switch (op) {
          case 'Q': return `'${v.replace(/'/g, "'\\''")}'`;
          case 'E': return v.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
          case 'U': return v.toUpperCase();
          case 'u': return v.length > 0 ? v[0].toUpperCase() + v.slice(1) : '';
          case 'L': return v.toLowerCase();
          case 'A': return v;
          default: return v;
        }
      });
      return mapped.join(' ');
    }

    // ${arr[@]} or ${arr[*]} — all array elements (space-separated)
    const arrAllMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/);
    if (arrAllMatch) {
      const name = arrAllMatch[1];
      const assoc = this.assocArrays.get(name);
      if (assoc) return Array.from(assoc.values()).join(' ');
      const arr = this.arrays.get(name);
      return arr ? arr.join(' ') : '';
    }

    // ${arr[key]} — indexed or associative array access
    const arrIdxMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.+)\]$/);
    if (arrIdxMatch) {
      const name = arrIdxMatch[1];
      // The subscript is expanded (${m[$k]}); for an indexed array it is arithmetic (${a[i+1]}).
      const key = this.expandVars(arrIdxMatch[2]).replace(/^(["'])(.*)\1$/, '$2');
      // Associative array?
      const assoc = this.assocArrays.get(name);
      if (assoc) return assoc.get(key) ?? '';
      // Indexed array (support negative indices: arr[-1] = last element)
      const arr = this.arrays.get(name);
      let idx = /^-?\d+$/.test(key.trim()) ? parseInt(key, 10) : this.evalArithmetic(key);
      if (arr && !isNaN(idx)) {
        if (idx < 0) idx = arr.length + idx;
        if (idx >= 0 && idx < arr.length) return arr[idx];
      }
      return '';
    }

    // ${#VAR} — string length
    const lenMatch = inner.match(/^#([A-Za-z_][A-Za-z0-9_]*)$/);
    if (lenMatch) {
      return String([...(this.env[lenMatch[1]] ?? '')].length);
    }

    // ${!prefix*} or ${!prefix@} — list variable names matching prefix
    const prefixMatch = inner.match(/^!([A-Za-z_][A-Za-z0-9_]*)[*@]$/);
    if (prefixMatch) {
      const prefix = prefixMatch[1];
      const matching = Object.keys(this.env).filter(k => k.startsWith(prefix)).sort();
      return matching.join(' ');
    }

    // ${!VAR} — indirect expansion (value of variable named by VAR's value)
    const indirectMatch = inner.match(/^!([A-Za-z_][A-Za-z0-9_]*)$/);
    if (indirectMatch) {
      const ref = this.env[indirectMatch[1]] ?? '';
      return this.env[ref] ?? '';
    }

    // ${VAR^^pattern} — uppercase all (matching pattern, default: ?)
    const ucMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\^\^(.*)$/);
    if (ucMatch) {
      const val = this.env[ucMatch[1]] ?? '';
      const pat = ucMatch[2] || '?';
      const re = new RegExp('^' + this.globToRegex(pat) + '$');
      return val.split('').map(c => re.test(c) ? c.toUpperCase() : c).join('');
    }

    // ${VAR^pattern} — capitalize first matching character (default: ?)
    const ucFirstMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\^(.*)$/);
    if (ucFirstMatch) {
      const val = this.env[ucFirstMatch[1]] ?? '';
      if (val.length === 0) return '';
      const pat = ucFirstMatch[2] || '?';
      const re = new RegExp('^' + this.globToRegex(pat) + '$');
      return (re.test(val[0]) ? val[0].toUpperCase() : val[0]) + val.slice(1);
    }

    // ${VAR,,pattern} — lowercase all (matching pattern, default: ?)
    const lcMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*),,(.*)$/);
    if (lcMatch) {
      const val = this.env[lcMatch[1]] ?? '';
      const pat = lcMatch[2] || '?';
      const re = new RegExp('^' + this.globToRegex(pat) + '$');
      return val.split('').map(c => re.test(c) ? c.toLowerCase() : c).join('');
    }

    // ${VAR,pattern} — lowercase first matching character (default: ?)
    const lcFirstMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*),(.*)$/);
    if (lcFirstMatch) {
      const val = this.env[lcFirstMatch[1]] ?? '';
      if (val.length === 0) return '';
      const pat = lcFirstMatch[2] || '?';
      const re = new RegExp('^' + this.globToRegex(pat) + '$');
      return (re.test(val[0]) ? val[0].toLowerCase() : val[0]) + val.slice(1);
    }

    // ${VAR:offset} and ${VAR:offset:length} — substring
    // Offset and length are arithmetic (${s: -2}, ${s:(-2)}, ${s:i+1:n}); ":-" etc. are the
    // default-value forms, handled below.
    const subMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*):(?![-=+?])([^:]*)(?::([^:]*))?$/);
    if (subMatch) {
      const val = this.env[subMatch[1]] ?? '';
      let offset = this.evalArithmetic(subMatch[2]);
      if (offset < 0) offset = Math.max(0, val.length + offset);
      if (subMatch[3] !== undefined) {
        const len = this.evalArithmetic(subMatch[3]);
        return len < 0 ? val.slice(offset, Math.max(0, val.length + len)) : val.slice(offset, offset + len);
      }
      return val.slice(offset);
    }

    // ${VAR//pattern/replacement} — replace all
    const repAllMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\/\/((?:[^/]|\\\/)*)\/([\s\S]*)$/);
    if (repAllMatch) {
      const val = this.env[repAllMatch[1]] ?? '';
      const pat = repAllMatch[2].replace(/\\\//g, '/');
      const rep = this.expandVars(repAllMatch[3]);
      const re = new RegExp(this.globToRegex(pat), 'g');
      return val.replace(re, rep);
    }

    // ${VAR/pattern/replacement} — replace first
    const repMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\/((?:[^/]|\\\/)*)\/([\s\S]*)$/);
    if (repMatch) {
      const val = this.env[repMatch[1]] ?? '';
      const pat = repMatch[2].replace(/\\\//g, '/');
      const rep = this.expandVars(repMatch[3]);
      const re = new RegExp(this.globToRegex(pat));
      return val.replace(re, rep);
    }

    // ${VAR##pattern} — remove longest prefix
    const rmPrefLong = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)##(.+)$/);
    if (rmPrefLong) {
      const val = this.env[rmPrefLong[1]] ?? '';
      const reStr = this.globToRegex(rmPrefLong[2]);
      // Greedy: find longest prefix matching the pattern
      for (let len = val.length; len >= 0; len--) {
        const prefix = val.slice(0, len);
        if (new RegExp('^' + reStr + '$').test(prefix)) return val.slice(len);
      }
      return val;
    }

    // ${VAR#pattern} — remove shortest prefix
    const rmPrefShort = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)#(.+)$/);
    if (rmPrefShort) {
      const val = this.env[rmPrefShort[1]] ?? '';
      const reStr = this.globToRegex(rmPrefShort[2]);
      for (let len = 0; len <= val.length; len++) {
        const prefix = val.slice(0, len);
        if (new RegExp('^' + reStr + '$').test(prefix)) return val.slice(len);
      }
      return val;
    }

    // ${VAR%%pattern} — remove longest suffix
    const rmSufLong = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)%%(.+)$/);
    if (rmSufLong) {
      const val = this.env[rmSufLong[1]] ?? '';
      const reStr = this.globToRegex(rmSufLong[2]);
      for (let start = 0; start <= val.length; start++) {
        const suffix = val.slice(start);
        if (new RegExp('^' + reStr + '$').test(suffix)) return val.slice(0, start);
      }
      return val;
    }

    // ${VAR%pattern} — remove shortest suffix
    const rmSufShort = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)%(.+)$/);
    if (rmSufShort) {
      const val = this.env[rmSufShort[1]] ?? '';
      const reStr = this.globToRegex(rmSufShort[2]);
      for (let start = val.length; start >= 0; start--) {
        const suffix = val.slice(start);
        if (new RegExp('^' + reStr + '$').test(suffix)) return val.slice(0, start);
      }
      return val;
    }

    // ${VAR:-default}, ${VAR:=default}, ${VAR:+alt}, ${VAR:?err}
    const opMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)(:?)([-=+?])(.*)$/s);
    if (opMatch) {
      const [, varName, colon, op, operand] = opMatch;
      const val = this.env[varName];
      const isUnset = val === undefined;
      const isEmpty = val === '';
      const check = colon ? (isUnset || isEmpty) : isUnset;
      const expandedOperand = this.expandVars(operand);
      switch (op) {
        case '-': return check ? expandedOperand : (val ?? '');
        case '=':
          if (check) { this.env[varName] = expandedOperand; return expandedOperand; }
          return val ?? '';
        case '+': return check ? '' : expandedOperand;
        case '?':
          if (check) throw new Error(`${varName}: ${expandedOperand || 'parameter not set'}`);
          return val ?? '';
      }
    }

    // ${VAR@op} — variable transformations
    const atMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)@([QEUuLaAK])$/);
    if (atMatch) {
      const val = this.env[atMatch[1]] ?? '';
      switch (atMatch[2]) {
        case 'Q': return `'${val.replace(/'/g, "'\\''")}'`; // quote for reuse
        case 'E': return val.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\\\/g, '\\'); // interpret escapes
        case 'U': return val.toUpperCase();
        case 'u': return val.length > 0 ? val[0].toUpperCase() + val.slice(1) : '';
        case 'L': return val.toLowerCase();
        case 'a': {
          // Return actual variable attributes
          const vname = atMatch[1];
          let attrs = '';
          if (this.readonlyVars.has(vname)) attrs += 'r';
          if (this.namerefs.has(vname)) attrs += 'n';
          if (this.arrays.has(vname)) attrs += 'a';
          if (this.assocArrays.has(vname)) attrs += 'A';
          return attrs;
        }
        case 'A': return `declare -- ${atMatch[1]}="${val}"`; // assignment form
        case 'K': return val; // display as key-value (stub)
        default: return val;
      }
    }

    // Simple ${VAR}
    const simpleMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
    if (simpleMatch) {
      return this.env[simpleMatch[1]] ?? '';
    }

    return null; // not recognized
  }

  /** Convert a shell glob pattern to a regex string (supports extglob when enabled) */
  private globToRegex(pattern: string): string {
    const extglob = this.shoptopts.has('extglob');
    let result = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      // Extended glob: ?(pat|pat), *(pat|pat), +(pat|pat), @(pat|pat), !(pat|pat)
      if (extglob && '?*+@!'.includes(ch) && pattern[i + 1] === '(') {
        const close = this.findMatchingParen(pattern, i + 1);
        if (close >= 0) {
          const inner = pattern.slice(i + 2, close);
          // Recursively convert each alternative
          const alts = this.splitExtglobAlts(inner).map(a => this.globToRegex(a)).join('|');
          switch (ch) {
            case '?': result += `(?:${alts})?`; break;  // zero or one
            case '*': result += `(?:${alts})*`; break;   // zero or more
            case '+': result += `(?:${alts})+`; break;   // one or more
            case '@': result += `(?:${alts})`; break;    // exactly one
            case '!': result += `(?!(?:${alts})$).*`; break; // none of
          }
          i = close;
          continue;
        }
      }
      if (ch === '*') { result += '.*'; continue; }
      if (ch === '?') { result += '.'; continue; }
      if (ch === '[') {
        // Character class: pass through until ]
        let j = i + 1;
        if (j < pattern.length && pattern[j] === '!') { result += '[^'; j++; }
        else if (j < pattern.length && pattern[j] === '^') { result += '[^'; j++; }
        else { result += '['; }
        while (j < pattern.length && pattern[j] !== ']') { result += pattern[j]; j++; }
        result += ']';
        i = j;
        continue;
      }
      // Escape regex special characters
      if ('.+^${}()|\\'.includes(ch)) { result += '\\' + ch; continue; }
      result += ch;
    }
    return result;
  }

  /** Find an unquoted closing parenthesis, shared by nested word constructs. */
  private findMatchingParen(s: string, openPos: number): number {
    let depth = 1, single = false, double = false;
    for (let i = openPos + 1; i < s.length; i++) {
      if (s[i] === '\\' && !single) { i++; continue; }
      if (s[i] === "'" && !double) { single = !single; continue; }
      if (s[i] === '"' && !single) { double = !double; continue; }
      if (single || double) continue;
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  /** Split extglob alternatives on top-level | (not inside nested parens) */
  private splitExtglobAlts(s: string): string[] {
    const alts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      else if (s[i] === '|' && depth === 0) {
        alts.push(s.slice(start, i));
        start = i + 1;
      }
    }
    alts.push(s.slice(start));
    return alts;
  }

  /** Split multi-line input into statements, keeping heredoc blocks and quoted strings intact. */
  /**
   * True while text has an unclosed command substitution — $( … ) or ` … ` — or, with quotes,
   * an unclosed quote: the statement goes on to the next line. Plain ( … ) groups don't count.
   */
  static openConstruct(text: string, quotes = true): boolean {
    let depth = 0, q = '', back = false;
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (c === '\\' && q !== "'") { k++; continue; }
      if (q === "'") { if (c === "'") q = ''; continue; }
      if (c === '`') { back = !back; continue; }
      if (c === '$' && text[k + 1] === '(') { depth++; k++; continue; }
      if (depth > 0 && c === '(') { depth++; continue; }
      if (depth > 0 && c === ')') { depth--; continue; }
      if (c === '"') { q = q === '"' ? '' : '"'; continue; }
      if (c === "'" && !q) q = "'";
    }
    return depth > 0 || back || (quotes && q !== '');
  }

  private splitStatements(input: string): string[] {
    const lines = input.split(/\r?\n/);
    if (lines.length <= 1) return [input];

    const statements: string[] = [];
    let i = 0;
    let accumulator = '';
    let quoteChar: string | null = null; // track open quote across lines

    while (i < lines.length) {
      const line = lines[i];

      // If we're inside an open quote from a previous line, accumulate
      if (quoteChar) {
        accumulator += '\n' + line;
        // Check if this line closes the quote
        if (this.lineClosesQuote(line, quoteChar)) {
          quoteChar = null;
          // Check if MORE quotes open after the close on this line
          const afterClose = this.unclosedQuote(accumulator);
          if (afterClose) quoteChar = afterClose;
        }
        if (!quoteChar) {
          statements.push(accumulator);
          accumulator = '';
        }
        i++;
        continue;
      }

      // Check if this line starts a heredoc
      // `<<` starts a heredoc; `<<<` is a here-string on this line only.
      const heredocMatch = line.match(/(?:^|[^<])<<(?!<)-?\s*(?:'([^']+)'|"([^"]+)"|(\S+))/);
      if (heredocMatch) {
        const delimiter = heredocMatch[1] || heredocMatch[2] || heredocMatch[3];
        let block = line;
        i++;
        while (i < lines.length) {
          block += '\n' + lines[i];
          if (lines[i].trim() === delimiter) break;
          i++;
        }
        i++;
        // A heredoc inside $( … ) or quotes: the statement goes on after the terminator until
        // they close (x="$(cat <<'E' … E\n)"). Checked without the heredoc body, which is data.
        let code = line;
        while (i < lines.length && Shell.openConstruct(code)) {
          block += '\n' + lines[i];
          code += '\n' + lines[i];
          i++;
        }
        statements.push(block);
        continue;
      }

      // A command substitution over several lines is one statement: echo $(cmd1\ncmd2).
      if (Shell.openConstruct(line, false)) {
        let acc = line;
        i++;
        while (i < lines.length && Shell.openConstruct(acc, false)) { acc += '\n' + lines[i]; i++; }
        statements.push(acc);
        continue;
      }

      // Check if this line has an unclosed quote
      const openQuote = this.unclosedQuote(line);
      if (openQuote) {
        accumulator = line;
        quoteChar = openQuote;
        i++;
        continue;
      }

      statements.push(line);
      i++;
    }

    // Flush any remaining accumulated content
    if (accumulator) statements.push(accumulator);

    return this.groupBlocks(statements);
  }

  /**
   * Joins the lines of a multi-line compound command — if/case/for/while/until/select,
   * { } groups and function bodies, ( ) subshells — into the one-line form the rest of the
   * interpreter runs, e.g. "if x; then\n  y\nfi" → "if x; then y; fi". Line breaks become
   * "; " except where the line already ends in a separator or a word that takes a command
   * next (then, do, else, {, |, &&, …) or a case pattern. A block that contains a heredoc or
   * a multi-line quoted string can't be joined onto one line; its lines stay separate.
   */
  private groupBlocks(statements: string[]): string[] {
    const OPEN = new Set(['if', 'case', 'for', 'while', 'until', 'select', '{', '(']);
    const CLOSE: Record<string, string[]> = {
      fi: ['if'], esac: ['case'], done: ['for', 'while', 'until', 'select'], '}': ['{'], ')': ['('],
    };
    const out: string[] = [];
    let stack: string[] = [];
    let parts: string[] = [];          // original statements of the open block
    let joined = '';
    let joinable = true;
    let prev: ReturnType<Shell['lexBlockLine']> | null = null;

    for (const stmt of statements) {
      const info = this.lexBlockLine(stmt);
      if (!stack.length) {
        const top = [...stack];
        for (const t of info.tokens) this.applyBlockToken(top, t, OPEN, CLOSE);
        if (!top.length) { out.push(stmt); continue; }
        // Opens a block: start collecting.
        stack = top; parts = [stmt]; joined = info.code; joinable = !stmt.includes('\n'); prev = info;
        continue;
      }
      parts.push(stmt);
      if (stmt.includes('\n')) {
        // A heredoc inside the block becomes a here-string, so the block can be one line.
        const hereString = this.heredocToHereString(stmt);
        if (hereString) Object.assign(info, this.lexBlockLine(hereString));
        else joinable = false;
      }
      if (info.code) {
        const caseTop = stack[stack.length - 1] === 'case';
        const sep = prev && (prev.joinsNext || (caseTop && prev.last === ')')) || /^;;/.test(info.code) ? ' ' : '; ';
        joined += (joined ? sep : '') + info.code;
        prev = info;
      }
      for (const t of info.tokens) this.applyBlockToken(stack, t, OPEN, CLOSE);
      if (!stack.length) {
        if (joinable) out.push(joined); else out.push(...parts);
        parts = []; joined = ''; prev = null;
      }
    }
    // Unterminated block: run what there is and let the parser report the error.
    if (parts.length) { if (joinable) out.push(joined); else out.push(...parts); }
    return out;
  }

  /** Index just past the if/for/while/until/case/select that `text` starts with, or -1. */
  private controlStructureEnd(text: string): number {
    const OPEN = new Set(['if', 'case', 'for', 'while', 'until', 'select', '{', '(']);
    const CLOSE: Record<string, string[]> = {
      fi: ['if'], esac: ['case'], done: ['for', 'while', 'until', 'select'], '}': ['{'], ')': ['('],
    };
    const stack: string[] = [];
    let end = -1;
    this.lexBlockLine(text, (t, pos) => {
      if (end >= 0) return;
      this.applyBlockToken(stack, t, OPEN, CLOSE);
      if (!stack.length && !OPEN.has(t)) end = pos;
    });
    return end;
  }

  /**
   * `cmd <<EOF` + body lines + `EOF` → `cmd <<< __shiro_heredoc_N` (here-strings add the final
   * newline a heredoc body has). The body is kept aside and put back as a quoted string when
   * the command runs (inlineHeredocs), after the block has been joined and split. A quoted
   * delimiter keeps it literal; otherwise $var, $( ) and $(( )) expand then, as in a heredoc.
   * Null if stmt is not a heredoc.
   */
  private heredocToHereString(stmt: string): string | null {
    const lines = stmt.split('\n');
    const m = lines[0].match(/(?:^|[^<])<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|(\S+))/);
    if (!m) return null;
    const delim = m[2] ?? m[3] ?? m[4];
    const stripTabs = m[1] === '-';
    const end = lines.findIndex((l, k) => k > 0 && (stripTabs ? l.replace(/^\t+/, '') : l).trim() === delim);
    if (end < 0 || end !== lines.length - 1) return null;
    const body = lines.slice(1, end).map(l => stripTabs ? l.replace(/^\t+/, '') : l).join('\n');
    const literal = m[2] !== undefined || m[3] !== undefined;
    const quoted = literal
      ? `'${body.replace(/'/g, `'\\''`)}'`
      : `"${body.replace(/\\(?=")/g, '\\\\').replace(/"/g, '\\"')}"`;
    let name = this.heredocNames.get(quoted);
    if (!name) {
      name = `__shiro_heredoc_${this.heredocNames.size + 1}`;
      this.heredocNames.set(quoted, name);
      this.heredocBodies.set(name, quoted);
    }
    return lines[0].replace(m[0], `<<< ${name}`);
  }

  /** Puts heredoc bodies moved aside by heredocToHereString back into a command. */
  private inlineHeredocs(cmd: string): string {
    if (!cmd.includes('__shiro_heredoc_')) return cmd;
    return cmd.replace(/__shiro_heredoc_\d+/g, name => this.heredocBodies.get(name) ?? name);
  }

  private applyBlockToken(stack: string[], t: string, open: Set<string>, close: Record<string, string[]>): void {
    if (open.has(t)) { stack.push(t); return; }
    const opens = close[t];
    if (!opens) return;
    const top = stack[stack.length - 1];
    if (top && opens.includes(top)) stack.pop();
    // ')' inside a case body ends a pattern, not a subshell — ignored.
  }

  /**
   * Lexes one line for block structure: the block keywords and brackets it contains, in order
   * (only in command position, so `echo done` is not a keyword), the line without a trailing
   * comment, and whether its last token lets the next line follow after a space instead of "; ".
   */
  private lexBlockLine(line: string, onToken?: (token: string, end: number) => void): { tokens: string[]; code: string; last: string; joinsNext: boolean } {
    const tokens: string[] = [];
    // Records a block token; onToken also gets the index just past it.
    const emit = (t: string) => { tokens.push(t); onToken?.(t, i); };
    let cmdPos = true;
    let afterCase = false;        // between `case` and its `in`
    let funcName = 0;             // after `function`: 2 = expect name, 1 = name seen
    let last = '';
    let lastIsWord = false;
    let lastCaseIn = false;
    let code = line;
    let i = 0;
    const n = line.length;
    const skipQuoted = (q: string, from: number) => {
      let j = from + 1;
      while (j < n && line[j] !== q) j += (q === '"' && line[j] === '\\') ? 2 : 1;
      return j + 1;
    };
    const skipBalanced = (from: number, openCh: string, closeCh: string) => {
      let depth = 0, j = from;
      while (j < n) {
        const c = line[j];
        if (c === "'" || c === '"') { j = skipQuoted(c, j); continue; }
        if (c === '\\') { j += 2; continue; }
        if (c === openCh) depth++;
        else if (c === closeCh) { depth--; if (depth === 0) return j + 1; }
        j++;
      }
      return n;
    };
    while (i < n) {
      const c = line[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '#') { code = line.slice(0, i); break; }
      // Operators
      const two = line.slice(i, i + 2);
      if (two === ';;' || two === '&&' || two === '||') {
        last = line.slice(i, i + (line.slice(i, i + 3) === ';;&' ? 3 : 2)); i += last.length;
        cmdPos = true; lastIsWord = false; lastCaseIn = false; continue;
      }
      if (c === ';' || c === '|' || c === '&') {
        last = c; i++; cmdPos = true; lastIsWord = false; lastCaseIn = false; continue;
      }
      if (c === '(') {
        if (line[i + 1] === ')') { i += 2; cmdPos = true; last = ')'; lastIsWord = false; continue; }  // name() {
        i++;
        if (cmdPos) emit('(');
        last = '('; cmdPos = true; lastIsWord = false; continue;
      }
      if (c === ')') { i++; emit(')'); last = ')'; cmdPos = true; lastIsWord = false; continue; }
      if (c === '[' && line[i + 1] === '[' && /\s/.test(line[i + 2] ?? '')) {
        const end = this.doubleBracketEnd(line, i);
        if (end > 0) { i = end; last = ']]'; lastIsWord = true; lastCaseIn = false; cmdPos = false; continue; }
      }
      // A word (quotes, $( ), ${ }, `…` and escapes are part of it)
      const start = i;
      while (i < n && !/[\s;&|()]/.test(line[i])) {
        const d = line[i];
        if (d === '\\') { i += 2; continue; }
        if (d === "'" || d === '"') { i = skipQuoted(d, i); continue; }
        if (d === '`') { i = skipQuoted('`', i); continue; }
        if (d === '$' && line[i + 1] === '(') { i = skipBalanced(i + 1, '(', ')'); continue; }
        if (d === '$' && line[i + 1] === '{') { i = skipBalanced(i + 1, '{', '}'); continue; }
        i++;
      }
      // `(`/`)` right after `=` belong to an array assignment: arr=(a b)
      if (i < n && line[i] === '(' && line[i - 1] === '=') { i = skipBalanced(i, '(', ')'); }
      const w = line.slice(start, i);
      last = w; lastIsWord = true; lastCaseIn = false;
      if (funcName === 2) { funcName = 1; cmdPos = true; continue; }
      if (afterCase) { if (w === 'in') { afterCase = false; cmdPos = true; lastCaseIn = true; } continue; }
      if (!cmdPos) continue;
      if (w === 'if' || w === 'while' || w === 'until') { emit(w); cmdPos = true; continue; }
      if (w === 'for' || w === 'select') { emit(w); cmdPos = false; continue; }
      if (w === 'case') { emit(w); afterCase = true; cmdPos = false; continue; }
      if (w === 'fi' || w === 'done' || w === 'esac' || w === '}') { emit(w); cmdPos = false; continue; }
      if (w === '{') { emit('{'); cmdPos = true; continue; }
      if (w === 'then' || w === 'do' || w === 'else' || w === 'elif' || w === '!') { cmdPos = true; continue; }
      if (w === 'function') { funcName = 2; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w)) continue;   // assignment: a command may follow
      cmdPos = false;
    }
    code = code.trim();
    const joinsNext = !lastIsWord
      ? [';', ';;', ';&', ';;&', '|', '&&', '||', '&', '('].includes(last)
      : lastCaseIn || ['then', 'do', 'else', '{'].includes(last);
    return { tokens, code, last, joinsNext };
  }

  /** Check if a line has an unclosed quote. Returns the quote char or null. */
  private unclosedQuote(line: string): string | null {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\' && inDouble) { i++; continue; }
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
    }
    if (inSingle) return "'";
    if (inDouble) return '"';
    return null;
  }

  /** Check if a line closes a specific quote character. */
  private lineClosesQuote(line: string, quote: string): boolean {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\' && quote === '"') { i++; continue; }
      if (ch === quote) return true;
    }
    return false;
  }

  private parseHeredoc(input: string): { command: string; body: string } | null {
    // Match <<DELIM, <<'DELIM', <<"DELIM", or <<-DELIM patterns
    const lines = input.split(/\r?\n/);
    if (lines.length < 2) return null;

    // Find <<DELIM on the first line (could be anywhere in the command)
    const heredocMatch = lines[0].match(/(?:^|[^<])<<(?!<)-?\s*(?:'([^']+)'|"([^"]+)"|(\S+))/);
    if (!heredocMatch) return null;
    // A heredoc inside $( … ) belongs to the command in there, not to this one.
    if (Shell.openConstruct(lines[0].slice(0, heredocMatch.index! + (heredocMatch[0].startsWith('<<') ? 0 : 1)), false)) return null;

    const delimiter = heredocMatch[1] || heredocMatch[2] || heredocMatch[3];
    const quoted = !!(heredocMatch[1] || heredocMatch[2]);
    const stripTabs = lines[0].match(/<<-/) !== null;

    // Remove the <<DELIM token from the command line
    const command = lines[0].replace(/(^|[^<])<<(?!<)-?\s*(?:'[^']+'|"[^"]+"|\S+)/, '$1').trim();

    // Collect body lines until we find the delimiter on its own line
    const bodyLines: string[] = [];
    let found = false;
    let delimiterIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
      if (line.trim() === delimiter) {
        found = true;
        delimiterIndex = i;
        break;
      }
      bodyLines.push(line);
    }

    if (!found) return null;

    // Capture any commands after the closing delimiter line
    let finalCommand = command;
    const remaining = lines.slice(delimiterIndex + 1).map(l => l.trim()).filter(Boolean);
    if (remaining.length > 0) {
      finalCommand = finalCommand + ' && ' + remaining.join(' && ');
    }

    let body = bodyLines.join('\n');
    // If delimiter was not quoted, expand variables
    if (!quoted) {
      body = this.expandVars(body);
    }
    // Add trailing newline (standard heredoc behavior)
    body += '\n';

    return { command: finalCommand, body };
  }

  private parseCompound(line: string): { operator: '' | '&&' | '||' | ';'; command: string }[] {
    const result: { operator: '' | '&&' | '||' | ';'; command: string }[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let currentOp: '' | '&&' | '||' | ';' = '';
    let depth = 0; // track control structure nesting (do/done, then/fi, {/})
    let braceDepth = 0; // track only { } brace groups (not ${VAR})
    let parenDepth = 0; // track subshell ( ... ) nesting separately
    let i = 0;

    while (i < line.length) {
      const ch = line[i];

      if (ch === '\\' && !inSingle && i + 1 < line.length) {
        current += ch + line[i + 1];
        i += 2;
        continue;
      }

      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }

      if (!inSingle && !inDouble) {
        // [[ … ]] stays whole: its && || < > are its own.
        if (ch === '[' && line[i + 1] === '[' && (i === 0 || /[\s;&|(!]/.test(line[i - 1])) && /\s/.test(line[i + 2] ?? '')) {
          const end = this.doubleBracketEnd(line, i);
          if (end > 0) { current += line.slice(i, end); i = end; continue; }
        }
        // Track subshell parenthesized groups: ( ... )
        // Only count '(' at operator positions (after whitespace/;/start), not after $ or word chars
        const prevCh = i > 0 ? line[i - 1] : ' ';
        if (ch === '(' && !/\w/.test(prevCh) && prevCh !== '$') {
          parenDepth++;
          current += ch; i++; continue;
        }
        if (ch === ')' && parenDepth > 0) {
          parenDepth--;
          current += ch; i++; continue;
        }

        // Track {/} brace groups and function bodies
        if (ch === '{') {
          // Only count as depth if preceded by whitespace/; (not in ${VAR})
          const prevBrace = i > 0 ? line[i - 1] : ' ';
          if (/[\s;)]/.test(prevBrace) || i === 0) { depth++; braceDepth++; }
          current += ch; i++; continue;
        }
        if (ch === '}') {
          // Only decrement if we have a matching brace-group { (not ${VAR})
          if (braceDepth > 0) { depth--; braceDepth--; }
          current += ch; i++; continue;
        }

        // Track control structure keywords to avoid splitting inside them
        // Only match at word boundary: beginning of string or after whitespace/;
        // A keyword only in command position: `echo if` and `type -t done` are plain words.
        const before = current.trimEnd();
        const cmdPos = !before || /[;&|({]$/.test(before) || /(?:^|[\s;])(?:then|do|else|elif|!)$/.test(before);
        if ((/[\s;]/.test(prevCh) || i === 0) && cmdPos) {
          const rest = line.slice(i);
          const wordMatch = rest.match(/^(for|while|until|select|if|case|do|then|done|fi|esac)\b/);
          if (wordMatch) {
            const word = wordMatch[1];
            if (word === 'for' || word === 'while' || word === 'until' || word === 'select' || word === 'if' || word === 'case') depth++;
            else if (word === 'done' || word === 'fi' || word === 'esac') depth--;
          }
        }

        if (depth <= 0 && parenDepth <= 0) {
          if (ch === '&' && line[i + 1] === '&') {
            if (current.trim()) result.push({ operator: currentOp, command: current.trim() });
            currentOp = '&&';
            current = '';
            i += 2;
            continue;
          }
          if (ch === '|' && line[i + 1] === '|') {
            if (current.trim()) result.push({ operator: currentOp, command: current.trim() });
            currentOp = '||';
            current = '';
            i += 2;
            continue;
          }
          if (ch === ';') {
            if (current.trim()) result.push({ operator: currentOp, command: current.trim() });
            currentOp = ';';
            current = '';
            i++;
            continue;
          }
          // A lone & ends a background command, like ; ends one (`sleep 1 & echo after`).
          // Not &&, |&, >&, &>, 2>&1.
          if (ch === '&' && line[i + 1] !== '&' && line[i + 1] !== '>' && !/[>|&<]/.test(prevCh)) {
            if (current.trim()) result.push({ operator: currentOp, command: current.trim() + ' &' });
            currentOp = ';';
            current = '';
            i++;
            continue;
          }
        }
      }

      current += ch;
      i++;
    }

    if (current.trim()) result.push({ operator: currentOp, command: current.trim() });
    return result;
  }

  private parsePipeline(line: string): string[] {
    const segments: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    // Parentheses outside quotes — <( ) and >( ) process substitution, $( ), extglob — keep
    // their pipes inside them.
    let parenDepth = 0;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\' && !inSingle && i + 1 < line.length) { current += ch + line[++i]; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
      if (!inSingle && !inDouble) {
        if (ch === '(') parenDepth++;
        else if (ch === ')' && parenDepth > 0) parenDepth--;
      }
      // Single | but not || and not >| (clobber redirect), outside quotes and parentheses
      if (ch === '|' && line[i + 1] !== '|' && line[i - 1] !== '>' && !inSingle && !inDouble && parenDepth === 0) {
        segments.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    segments.push(current);
    return segments;
  }

  private parseSegment(segment: string): { args: string[], redirects: Redirect[], hereString?: string } {
    const tokens = this.tokenize(segment);
    const args: string[] = [];
    const redirects: Redirect[] = [];
    let hereString: string | undefined;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '2>&1') {
        redirects.push({ type: '2>&1', target: '' });
      } else if (tokens[i] === '1>&2') {
        redirects.push({ type: '>&2', target: '' });
      } else if (/^\d>&\d$/.test(tokens[i])) {
        // other descriptor duplications (2>&2, 3>&1, …) have no effect here
      } else if ((tokens[i] === '&>' || tokens[i] === '&>>') && i + 1 < tokens.length) {
        redirects.push({ type: tokens[i] === '&>' ? '>' : '>>', target: tokens[i + 1].replace(/\x01/g, '') });
        redirects.push({ type: '2>&1', target: '' });
        i++;
      } else if (tokens[i] === '<<<' && i + 1 < tokens.length) {
        // Here-string: <<< "string" — set as stdin
        hereString = tokens[i + 1].replace(/\x01/g, '') + '\n';
        i++;
      } else if ((tokens[i] === '>' || tokens[i] === '>>' || tokens[i] === '<' || tokens[i] === '2>' || tokens[i] === '2>>') && i + 1 < tokens.length) {
        redirects.push({ type: tokens[i] as Redirect['type'], target: tokens[i + 1].replace(/\x01/g, '') });
        i++;
      } else if (/^\d+<$/.test(tokens[i]) && i + 1 < tokens.length) {
        // FD redirect: N< file
        const fd = parseInt(tokens[i], 10);
        redirects.push({ type: '<', target: tokens[i + 1].replace(/\x01/g, ''), fd });
        i++;
      } else if (/^\d+>&-$/.test(tokens[i])) {
        // Close FD: N>&-
        const fd = parseInt(tokens[i], 10);
        redirects.push({ type: '>&-', target: '', fd });
      } else {
        args.push(tokens[i]);
      }
    }

    return { args, redirects, hereString };
  }

  private tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    // A word with quotes in it is kept even when empty ('' and "" are empty arguments).
    let quoted = false;
    // An operator-looking word here was quoted or escaped (\> '<'): the redirect branches below
    // emit real operators as their own tokens. The \x01 prefix keeps parseSegment from taking it
    // for a redirect; glob expansion strips it.
    const flush = () => {
      if (current || quoted) tokens.push(/^(?:\d*[<>]+&?\d*|<<<)$/.test(current) ? '\x01' + current : current);
      current = ''; quoted = false;
    };
    let i = 0;

    while (i < input.length) {
      const ch = input[i];

      // Skip ${...} parameter expansions verbatim (don't sentinel-mark glob chars inside)
      if (!inSingle && ch === '$' && input[i + 1] === '{') {
        current += '${';
        let depth = 1;
        let j = i + 2;
        while (j < input.length && depth > 0) {
          if (input[j] === '{') depth++;
          else if (input[j] === '}') depth--;
          if (depth > 0) current += input[j];
          j++;
        }
        current += '}';
        i = j;
        continue;
      }

      if (ch === '\\' && !inSingle && i + 1 < input.length) {
        const next = input[i + 1];
        if (inDouble) {
          // Inside double quotes: only \$ \" \\ \` are escapes; keep backslash for others
          if (next === '$' || next === '"' || next === '\\' || next === '`') {
            current += next;
          } else if (next === '*' || next === '?' || next === '[') {
            current += '\\' + '\x01' + next; // quoted glob char, with literal backslash
          } else {
            current += '\\' + next; // keep backslash literally
          }
        } else {
          // Outside quotes: backslash escapes the next character
          if (next === '*' || next === '?' || next === '[') {
            current += '\x01' + next; // sentinel: quoted glob char
          } else {
            current += next;
          }
        }
        i += 2;
        continue;
      }

      // $'...' ANSI-C quoting: process escape sequences
      if (ch === '$' && input[i + 1] === "'" && !inSingle && !inDouble) {
        quoted = true;
        i += 2; // skip $'
        while (i < input.length && input[i] !== "'") {
          if (input[i] === '\\' && i + 1 < input.length) {
            const esc = input[i + 1];
            switch (esc) {
              case 'n': current += '\n'; i += 2; break;
              case 't': current += '\t'; i += 2; break;
              case 'r': current += '\r'; i += 2; break;
              case '\\': current += '\\'; i += 2; break;
              case "'": current += "'"; i += 2; break;
              case '"': current += '"'; i += 2; break;
              case 'a': current += '\x07'; i += 2; break;
              case 'b': current += '\b'; i += 2; break;
              case 'e': case 'E': current += '\x1b'; i += 2; break;
              case 'f': current += '\f'; i += 2; break;
              case 'v': current += '\v'; i += 2; break;
              case 'x': {
                const hex = input.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{1,2}/);
                if (hex) { current += byteChar(parseInt(hex[0], 16)); i += 2 + hex[0].length; }
                else { current += '\\x'; i += 2; }
                break;
              }
              case 'u': {
                const uni = input.slice(i + 2, i + 6).match(/^[0-9a-fA-F]{1,4}/);
                if (uni) { current += String.fromCodePoint(parseInt(uni[0], 16)); i += 2 + uni[0].length; }
                else { current += '\\u'; i += 2; }
                break;
              }
              default:
                if (esc >= '0' && esc <= '7') {
                  const oct = input.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
                  if (oct) { current += byteChar(parseInt(oct[0], 8) & 255); i += 1 + oct[0].length; }
                  else { current += '\\'; i++; }
                } else {
                  current += '\\' + esc; i += 2;
                }
            }
          } else {
            current += input[i]; i++;
          }
        }
        if (i < input.length) i++; // skip closing '
        current = normalizeBytes(current);   // $'\xc3\xa9' is "é"; $'\xe9' stays the byte E9
        continue;
      }

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        quoted = true;
        i++;
        continue;
      }

      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        quoted = true;
        i++;
        continue;
      }

      if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
        flush();
        i++;
        continue;
      }

      // Mark glob chars inside quotes so they won't be expanded
      if ((inSingle || inDouble) && (ch === '*' || ch === '?' || ch === '[')) {
        current += '\x01' + ch;
        i++;
        continue;
      }

      // Handle 2>&1, 2>>, and 2> stderr redirects
      if (ch === '2' && !inSingle && !inDouble && (input[i + 1] === '>')) {
        flush();
        if (input[i + 2] === '&' && input[i + 3] === '1') {
          tokens.push('2>&1');
          i += 4;
        } else if (input[i + 2] === '>') {
          tokens.push('2>>');
          i += 3;
        } else {
          tokens.push('2>');
          i += 2;
        }
        continue;
      }

      // Handle >>, >| and > redirects (>| is zsh clobber, treated as >)
      if (ch === '>' && !inSingle && !inDouble) {
        // FD close: N>&- (current is digits)
        if (current && /^\d+$/.test(current) && input[i + 1] === '&' && input[i + 2] === '-') {
          tokens.push(current + '>&-');
          current = '';
          i += 3;
          continue;
        }
        // >&N / N>&M: duplicate a descriptor (>&2 sends stdout to stderr)
        if (input[i + 1] === '&' && /\d/.test(input[i + 2] ?? '') && (!current || /^\d$/.test(current))) {
          const fd = current || '1';
          current = ''; quoted = false;
          tokens.push(`${fd}>&${input[i + 2]}`);
          i += 3;
          continue;
        }
        // &> / &>> FILE: stdout and stderr to FILE
        if (current === '&' && !quoted) {
          current = '';
          tokens.push(input[i + 1] === '>' ? '&>>' : '&>');
          i += input[i + 1] === '>' ? 2 : 1;
          continue;
        }
        flush();
        if (input[i + 1] === '>') {
          tokens.push('>>');
          i += 2;
        } else if (input[i + 1] === '|') {
          tokens.push('>');
          i += 2;
        } else {
          tokens.push('>');
          i++;
        }
        continue;
      }

      // Handle <<< here-string, << heredoc (already handled elsewhere), < stdin redirect
      // But NOT <( which is process substitution
      if (ch === '<' && !inSingle && !inDouble) {
        if (input[i + 1] === '<' && input[i + 2] === '<') {
          flush();
          tokens.push('<<<');
          i += 3;
          continue;
        }
        // <( is process substitution — keep as part of arg, find matching )
        if (input[i + 1] === '(') {
          let depth = 1;
          let j = i + 2;
          while (j < input.length && depth > 0) {
            if (input[j] === '(') depth++;
            else if (input[j] === ')') depth--;
            j++;
          }
          const procSub = input.slice(i, j);
          flush();
          tokens.push(procSub);
          i = j;
          continue;
        }
        // FD redirect: N< file (current is digits)
        if (current && /^\d+$/.test(current)) {
          tokens.push(current + '<');
          current = '';
          i++;
          continue;
        }
        flush();
        tokens.push('<');
        i++;
        continue;
      }

      current += ch;
      i++;
    }

    flush();
    return tokens;
  }

  // ─── COMMAND SUBSTITUTION ─────────────────────────────────────────────────

  /**
   * $(cmd) and `cmd`: the output (trailing newlines removed) goes in as literal text, never parsed
   * as shell syntax. Inside double quotes it is escaped for them; as an assignment's value it is
   * one quoted word; otherwise it splits on whitespace into single-quoted words. Inside single
   * quotes nothing is substituted.
   */
  private async expandCommandSubstitution(input: string, stderrWriter: (s: string) => void): Promise<string> {
    const result: string[] = [];
    let inSingle = false, inDouble = false;
    const dq = (t: string) => t.replace(/[\\"$`]/g, '\\$&');
    const sq = (t: string) => `'${t.replace(/'/g, `'\\''`)}'`;
    // Inside $(( … )) the output goes in as it is: it is part of the expression.
    const arith: number[] = [];   // open-paren counts of enclosing $(( … ))
    const insert = (out: string) => {
      const preceding = result.join('');
      if (arith.length) result.push(out);
      else if (inDouble) result.push(dq(out));
      else if (/[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(preceding)) result.push(`"${dq(out)}"`);
      else result.push(out.split(/[ \t\n]+/).filter(Boolean).map(sq).join(' '));
    };
    const run = async (subCmd: string) => {
      const r = await this.fork().exec(subCmd);
      if (r.stderr) stderrWriter(r.stderr.replace(/\n/g, '\r\n'));
      return r.stdout.replace(/\n+$/, '');
    };
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\\' && !inSingle) { result.push(input.slice(i, i + 2)); i += 2; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; result.push(ch); i++; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; result.push(ch); i++; continue; }
      if (inSingle) { result.push(ch); i++; continue; }
      if (ch === '$' && input[i + 1] === '(' && input[i + 2] === '(') {
        // $(( … )) stays for expandArithmetic; command substitutions inside it are expanded.
        arith.push(2);
        result.push('$((');
        i += 3;
      } else if (arith.length && (ch === '(' || ch === ')')) {
        arith[arith.length - 1] += ch === '(' ? 1 : -1;
        if (arith[arith.length - 1] === 0) arith.pop();
        result.push(ch);
        i++;
      } else if (ch === '$' && input[i + 1] === '(') {
        let depth = 1;
        let j = i + 2;
        let subSQ = false, subDQ = false;
        while (j < input.length && depth > 0) {
          const sc = input[j];
          if (sc === '\\' && !subSQ) { j += 2; continue; }
          if (sc === "'" && !subDQ) { subSQ = !subSQ; j++; continue; }
          if (sc === '"' && !subSQ) { subDQ = !subDQ; j++; continue; }
          if (!subSQ && !subDQ) {
            if (sc === '(') depth++;
            if (sc === ')') depth--;
          }
          j++;
        }
        const subCmd = input.slice(i + 2, j - 1);
        // $(< file) shorthand: read file contents directly
        const fileReadMatch = subCmd.trim().match(/^<\s*(.+)$/);
        if (fileReadMatch) {
          const filePath = this.expandVars(fileReadMatch[1].trim()).replace(/^["']|["']$/g, '');
          try {
            insert((await this.fs.readFile(this.fs.resolvePath(filePath, this.cwd), 'utf8') as string).replace(/\n+$/, ''));
          } catch {
            stderrWriter(`${filePath}: No such file or directory\r\n`);
            insert('');
          }
        } else {
          insert(await run(subCmd));
        }
        i = j;
      } else if (ch === '`') {
        const j = input.indexOf('`', i + 1);
        if (j === -1) { result.push(input.slice(i)); break; }
        insert(await run(input.slice(i + 1, j)));
        i = j + 1;
      } else {
        result.push(ch);
        i++;
      }
    }
    return result.join('');
  }


  // ─── GLOB EXPANSION ──────────────────────────────────────────────────────

  /**
   * Expand glob patterns in args. Tokens containing \x01-prefixed glob chars
   * Process substitution: <(cmd) runs cmd, writes output to a temp file, replaces with path.
   * >(cmd) creates a temp file, runs cmd with stdin from that file after main command writes it.
   * For simplicity, we only implement <(cmd) (input process substitution).
   */
  private async expandProcessSubstitution(args: string[], writeStderr: (s: string) => void): Promise<string[]> {
    const result: string[] = [];
    for (const arg of args) {
      // Match <(command) — must be the entire arg or standalone
      const match = arg.match(/^<\(([\s\S]+)\)$/);
      if (match) {
        const subcmd = match[1];
        try {
          const { stdout, stderr } = await this.fork().exec(subcmd);
          if (stderr) writeStderr(stderr.replace(/\n/g, '\r\n'));
          const tmpPath = `/tmp/.procsub_${Date.now()}_${Shell.processSubstitutionSequence++}`;
          await this.fs.writeFile(tmpPath, stdout);
          result.push(tmpPath);
        } catch (e: any) {
          writeStderr(`shiro: process substitution failed: ${e.message}\r\n`);
          result.push(arg);
        }
      } else {
        result.push(arg);
      }
    }
    return result;
  }

  /** Expand child scripts before the parent's variable/command expansions can alter them. */
  private async expandProcessSubstitutionText(input: string, writeStderr: (text:string) => void): Promise<string> {
    let output = '', single = false, double = false;
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (char === '\\' && !single) { output += input.slice(i,i+2); i++; continue; }
      if (char === "'" && !double) single = !single;
      else if (char === '"' && !single) double = !double;
      if (!single && !double && char === '<' && input[i+1] === '(') {
        const close = this.findMatchingParen(input,i+1);
        if (close >= 0) {
          const end = close+1;
          const [path] = await this.expandProcessSubstitution([input.slice(i,end)],writeStderr);
          output += path;
          i = end-1;
          continue;
        }
      }
      output += char;
    }
    return output;
  }

  /**
   * (from quoted strings) are NOT expanded — the sentinel is stripped instead.
   * Follows bash behavior: no matches = keep the literal pattern.
   */
  private async expandGlobs(args: string[], writeStderr?: (s: string) => void): Promise<string[] | null> {
    const result: string[] = [];
    for (const arg of args) {
      // Check for sentinel-marked (quoted) glob chars
      const hasSentinel = arg.includes('\x01');
      // Check for real (unquoted) glob chars (including extglob patterns)
      const hasGlob = !hasSentinel && (/[*?[]/.test(arg) ||
        (this.shoptopts.has('extglob') && /[?*+@!]\(/.test(arg)));

      if (hasGlob) {
        try {
          // If globstar is not set, collapse ** to * so it won't recurse directories
          let globPattern = arg;
          if (!this.shoptopts.has('globstar')) {
            globPattern = globPattern.replace(/\*\*/g, '*');
          }
          // A trailing "/" matches directories only, which keep the "/" (ls -d */).
          const dirsOnly = globPattern.endsWith('/');
          if (dirsOnly) globPattern = globPattern.replace(/\/+$/, '');
          let matches = await this.fs.glob(globPattern, this.cwd, {
            caseInsensitive: this.shoptopts.has('nocaseglob'),
            dotglob: this.shoptopts.has('dotglob'),
          });
          if (dirsOnly) {
            const dirs: string[] = [];
            for (const m of matches) { try { if ((await this.fs.stat(m)).isDirectory()) dirs.push(m + '/'); } catch { /* gone */ } }
            matches = dirs;
            globPattern += '/';
          }
          if (matches.length > 0) {
            // fs.glob returns absolute paths; a relative pattern expands to relative names, as
            // in bash ("*.txt" → "a.txt", "./*.txt" → "./a.txt").
            const cwdPrefix = this.cwd.endsWith('/') ? this.cwd : this.cwd + '/';
            const relPrefix = globPattern.startsWith('./') ? './' : '';
            result.push(...(globPattern.startsWith('/') || globPattern.startsWith('../') ? matches
              : matches.map(m => m.startsWith(cwdPrefix) ? relPrefix + m.slice(cwdPrefix.length) : m)));
          } else {
            if (this.shoptopts.has('failglob')) {
              if (writeStderr) writeStderr(`-bash: no match: ${arg}\r\n`);
              return null;
            }
            // nullglob: return nothing; default: keep literal
            if (!this.shoptopts.has('nullglob')) {
              result.push(arg);
            }
          }
        } catch {
          result.push(arg);
        }
      } else {
        // Strip sentinel markers and keep literal
        result.push(arg.replace(/\x01/g, ''));
      }
    }
    return result;
  }

  // ─── ARITHMETIC EXPANSION ─────────────────────────────────────────────────

  /** $(( … )): the expression's value (parentheses inside it are counted one by one). */
  private expandArithmetic(input: string): string {
    let result = '';
    let i = 0;
    let inSingle = false, inDouble = false;   // as in bash: literal inside '…', expanded inside "…"
    while (i < input.length) {
      const c = input[i];
      if (c === "'" && !inDouble) { inSingle = !inSingle; result += c; i++; continue; }
      if (c === '"' && !inSingle) { inDouble = !inDouble; result += c; i++; continue; }
      if (inSingle) { result += c; i++; continue; }
      if (c === '\\' && i + 1 < input.length) { result += c + input[i + 1]; i += 2; continue; }
      if (input[i] === '$' && input[i + 1] === '(' && input[i + 2] === '(') {
        let depth = 2;
        let j = i + 3;
        while (j < input.length && depth > 0) {
          if (input[j] === '(') depth++;
          else if (input[j] === ')') depth--;
          j++;
        }
        const expr = input.slice(i + 3, j - 2);
        let v: string;
        try { v = this.arithBig(expr).toString(); } catch { v = '0'; }
        result += v;
        i = j;
      } else {
        result += input[i];
        i++;
      }
    }
    return result;
  }

  /** Arithmetic as a number ((( )), [[ -eq ]], let, …); see arithBig. */
  private evalArithmetic(expr: string): number {
    try { return Number(this.arithBig(expr)); } catch { return 0; }
  }

  /**
   * Bash arithmetic on 64-bit integers: all operators at bash precedence (, = op= ?: || && | ^ &
   * == != < <= > >= << >> + - * / % ** unary + - ! ~, ++/--), variables (whose values are
   * themselves evaluated), and 0x / 0 (octal) / base#digits literals. Throws on errors
   * ("division by 0", syntax errors).
   */
  private arithBig(src: string): bigint {
    const wrap = (v: bigint) => BigInt.asIntN(64, v);
    const toks: string[] = [];
    const re = /\s*(0[xX][0-9a-fA-F]+|\d+#[0-9A-Za-z@_]+|\d+|[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?|\*\*=?|<<=|>>=|\+\+|--|&&|\|\||[<>=!]=|<<|>>|[-+*\/%&^|]=|[-+*\/%^&|~!<>=?:,()])/y;
    let text = src.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*|\d+|#)\}?/g, (_m, n) => n === '#' ? (this.env['#'] ?? '0') : (this.env[n] ?? ''));
    text = text.trim();
    re.lastIndex = 0;
    while (re.lastIndex < text.length) {
      const m = re.exec(text);
      if (!m) throw new Error(`syntax error in expression (error token is "${text.slice(re.lastIndex).trim()}")`);
      toks.push(m[1]);
      if (/^\s*$/.test(text.slice(re.lastIndex))) break;
    }
    let p = 0;
    const peek = () => toks[p];
    const literal = (t: string): bigint => {
      const b = /^(\d+)#([0-9A-Za-z@_]+)$/.exec(t);
      if (b) {
        const base = parseInt(b[1], 10);
        const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ@_';
        let v = 0n;
        for (const ch of b[2]) {
          const d = base <= 36 ? digits.indexOf(ch.toLowerCase()) : digits.indexOf(ch);
          if (d < 0 || d >= base) throw new Error('value too great for base');
          v = v * BigInt(base) + BigInt(d);
        }
        return v;
      }
      if (/^0[xX]/.test(t)) return BigInt(t);
      if (/^0[0-7]+$/.test(t)) return BigInt('0o' + t.slice(1));
      if (/^0\d+$/.test(t)) throw new Error('value too great for base');
      return BigInt(t);
    };
    const depth = { n: 0 };
    const varValue = (name: string): bigint => {
      const idx = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(name);
      let raw: string;
      if (idx) {
        const assoc = this.assocArrays.get(idx[1]);
        raw = assoc ? assoc.get(this.expandVars(idx[2])) ?? '' : (this.arrays.get(idx[1]) ?? [])[Number(this.arithBig(idx[2]))] ?? '';
      } else raw = this.env[name] ?? '';
      raw = raw.trim();
      if (raw === '') return 0n;
      if (/^-?\d+$/.test(raw)) return BigInt(raw);
      if (depth.n > 64) throw new Error('expression recursion level exceeded');
      depth.n++;
      try { return this.arithBig(raw); } finally { depth.n--; }
    };
    const setVar = (name: string, v: bigint) => {
      const idx = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(name);
      if (idx) {
        const assoc = this.assocArrays.get(idx[1]);
        if (assoc) assoc.set(this.expandVars(idx[2]), v.toString());
        else { const arr = this.arrays.get(idx[1]) ?? []; arr[Number(this.arithBig(idx[2]))] = v.toString(); this.arrays.set(idx[1], arr); }
      } else this.env[name] = v.toString();
    };
    const isName = (t: string | undefined) => !!t && /^[A-Za-z_]/.test(t);
    const comma = (): bigint => { let v = assign(); while (peek() === ',') { p++; v = assign(); } return v; };
    const assign = (): bigint => {
      if (isName(peek()) && /^(=|\*\*=|[-+*\/%&^|]=|<<=|>>=)$/.test(toks[p + 1] ?? '')) {
        const name = toks[p], op = toks[p + 1];
        p += 2;
        const r = assign();
        let v: bigint;
        if (op === '=') v = r;
        else {
          const cur = varValue(name);
          const bop = op.slice(0, -1);
          v = binop(bop, cur, r);
        }
        v = wrap(v);
        setVar(name, v);
        return v;
      }
      return ternary();
    };
    const ternary = (): bigint => {
      const c = lor();
      if (peek() === '?') { p++; const a = assign(); if (toks[p++] !== ':') throw new Error("expected `:'"); const b = assign(); return c !== 0n ? a : b; }
      return c;
    };
    const binop = (op: string, a: bigint, b: bigint): bigint => {
      switch (op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': if (b === 0n) throw new Error('division by 0 (error token is "0")'); return a / b;
        case '%': if (b === 0n) throw new Error('division by 0 (error token is "0")'); return a % b;
        case '**': if (b < 0n) throw new Error('exponent less than 0'); return a ** b;
        case '<<': return a << b; case '>>': return a >> b;
        case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
      }
      throw new Error(`bad operator ${op}`);
    };
    const level = (ops: string[], next: () => bigint, f: (op: string, a: bigint, b: bigint) => bigint) => (): bigint => {
      let v = next();
      while (ops.includes(peek())) { const op = toks[p++]; const r = next(); v = wrap(f(op, v, r)); }
      return v;
    };
    const unary = (): bigint => {
      const t = peek();
      if (t === '+') { p++; return unary(); }
      if (t === '-') { p++; return wrap(-unary()); }
      if (t === '!') { p++; return unary() === 0n ? 1n : 0n; }
      if (t === '~') { p++; return wrap(~unary()); }
      if ((t === '++' || t === '--') && isName(toks[p + 1])) {
        p++;
        const name = toks[p++];
        const v = wrap(varValue(name) + (t === '++' ? 1n : -1n));
        setVar(name, v);
        return v;
      }
      return postfix();
    };
    const power = (): bigint => { const b = unary(); if (peek() === '**') { p++; return wrap(binop('**', b, power())); } return b; };
    const postfix = (): bigint => {
      const t = toks[p++];
      if (t === undefined) throw new Error('syntax error: operand expected');
      if (t === '(') { const v = comma(); if (toks[p++] !== ')') throw new Error("missing `)'"); return v; }
      if (isName(t)) {
        if (peek() === '++' || peek() === '--') { const op = toks[p++]; const v = varValue(t); setVar(t, wrap(v + (op === '++' ? 1n : -1n))); return v; }
        return varValue(t);
      }
      if (/^\d/.test(t)) return literal(t);
      throw new Error(`syntax error: operand expected (error token is "${t}")`);
    };
    const mul = level(['*', '/', '%'], power, binop);
    const add = level(['+', '-'], mul, binop);
    const shift = level(['<<', '>>'], add, binop);
    const rel = level(['<', '<=', '>', '>='], shift, (op, a, b) => ((op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b) ? 1n : 0n));
    const eq = level(['==', '!='], rel, (op, a, b) => ((op === '==' ? a === b : a !== b) ? 1n : 0n));
    const band = level(['&'], eq, binop);
    const bxor = level(['^'], band, binop);
    const bor = level(['|'], bxor, binop);
    const land = (): bigint => { let v = bor(); while (peek() === '&&') { p++; const r = bor(); v = v !== 0n && r !== 0n ? 1n : 0n; } return v; };
    const lor = (): bigint => { let v = land(); while (peek() === '||') { p++; const r = land(); v = v !== 0n || r !== 0n ? 1n : 0n; } return v; };
    if (!toks.length) return 0n;
    const v = comma();
    if (p < toks.length) throw new Error(`syntax error in expression (error token is "${toks.slice(p).join(' ')}")`);
    return v;
  }


  // ─── SHELL FUNCTIONS ──────────────────────────────────────────────────────

  /**
   * Replaces `{ list; }` and `( list )` groups that start a command (at the start, or after a
   * pipe) with calls to hidden functions holding their bodies. Text inside quotes, $( ), ${ }
   * and (( )) is left alone. The same group text always maps to the same function.
   */
  private hoistGroups(cmd: string): string {
    let out = '';
    let i = 0;
    let cmdStart = true;
    const n = cmd.length;
    const skipQuoted = (q: string, from: number) => {
      let j = from + 1;
      while (j < n && cmd[j] !== q) j += (q === '"' && cmd[j] === '\\') ? 2 : 1;
      return Math.min(j + 1, n);
    };
    const matchClose = (from: number, openCh: string, closeCh: string) => {
      let depth = 0, j = from;
      while (j < n) {
        const c = cmd[j];
        if (c === "'" || c === '"' || c === '`') { j = skipQuoted(c, j); continue; }
        if (c === '\\') { j += 2; continue; }
        if (c === '$' && (cmd[j + 1] === '(' || cmd[j + 1] === '{')) {
          j = matchClose(j + 1, cmd[j + 1], cmd[j + 1] === '(' ? ')' : '}'); continue;
        }
        if (c === openCh) depth++;
        else if (c === closeCh) { depth--; if (depth === 0) return j; }
        j++;
      }
      return -1;
    };
    while (i < n) {
      const c = cmd[i];
      if (cmdStart && /\s/.test(c)) { out += c; i++; continue; }
      // A control structure that is piped into, or followed by a pipe or redirect, runs as a
      // group too: its body is then expanded when it runs (not with the rest of the command,
      // before `read` has set anything) and gets the pipe's or redirect's input.
      if (cmdStart && /^(while|until|for|if|case|select)\b/.test(cmd.slice(i))) {
        const len = this.controlStructureEnd(cmd.slice(i));
        if (len > 0 && (i > 0 && out.trim() !== '' || cmd.slice(i + len).trim() !== '')) {
          const body = cmd.slice(i, i + len);
          const key = `{${body}`;
          let name = this.groupFunctions.get(key);
          if (!name) { name = `__shiro_group_${this.groupFunctions.size + 1}`; this.groupFunctions.set(key, name); }
          this.functions[name] = { body, group: 'brace' };
          out += name;
          i += len;
          cmdStart = false;
          continue;
        }
      }
      if (c === '[' && cmd[i + 1] === '[' && /\s/.test(cmd[i + 2] ?? '')) {
        const end = this.doubleBracketEnd(cmd, i);
        if (end > 0) { out += cmd.slice(i, end); i = end; cmdStart = false; continue; }
      }
      const brace = c === '{' && /\s/.test(cmd[i + 1] ?? '');
      const paren = c === '(' && cmd[i + 1] !== '(';
      if (cmdStart && (brace || paren)) {
        const end = matchClose(i, c, brace ? '}' : ')');
        if (end > 0) {
          const inner = cmd.slice(i + 1, end).trim().replace(/;\s*$/, '');
          const key = `${c}${inner}`;
          let name = this.groupFunctions.get(key);
          if (!name) {
            name = `__shiro_group_${this.groupFunctions.size + 1}`;
            this.groupFunctions.set(key, name);
          }
          this.functions[name] = { body: inner, group: brace ? 'brace' : 'subshell' };
          out += name;
          i = end + 1;
          cmdStart = false;
          continue;
        }
      }
      cmdStart = false;
      if (c === "'" || c === '"' || c === '`') { const j = skipQuoted(c, i); out += cmd.slice(i, j); i = j; continue; }
      if (c === '\\') { out += cmd.slice(i, i + 2); i += 2; continue; }
      if (c === '$' && (cmd[i + 1] === '(' || cmd[i + 1] === '{')) {
        const j = matchClose(i + 1, cmd[i + 1], cmd[i + 1] === '(' ? ')' : '}');
        const end = j < 0 ? n : j + 1;
        out += cmd.slice(i, end); i = end; continue;
      }
      if (c === '(' && cmd[i + 1] === '(') {       // (( arithmetic ))
        const j = matchClose(i, '(', ')');
        const end = j < 0 ? n : j + 1;
        out += cmd.slice(i, end); i = end; continue;
      }
      if (c === '|' && cmd[i + 1] !== '|' && cmd[i - 1] !== '|') { out += c; i++; cmdStart = true; continue; }
      out += c;
      i++;
    }
    return out;
  }

  private parseFunctionDef(input: string): { name: string; body: string } | null {
    let match = input.match(/^(\w+)\s*\(\)\s*\{([\s\S]*)\}$/);
    if (!match) match = input.match(/^function\s+(\w+)\s*(?:\(\))?\s*\{([\s\S]*)\}$/);
    if (match) return { name: match[1], body: match[2].trim() };
    return null;
  }

  private async execFunction(
    name: string, args: string[],
    writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const func = this.functions[name];
    if (!func) return 127;

    // Save and set positional parameters
    const saved: Record<string, string | undefined> = {};
    for (let i = 0; i <= args.length; i++) saved[String(i)] = this.env[String(i)];
    saved['#'] = this.env['#'];
    saved['@'] = this.env['@'];

    this.env['0'] = name;
    for (let i = 0; i < args.length; i++) this.env[String(i + 1)] = args[i];
    this.env['#'] = String(args.length);
    this.env['@'] = args.join(' ');

    // Track FUNCNAME and BASH_SOURCE stacks
    const prevFuncname = this.arrays.get('FUNCNAME') || [];
    this.arrays.set('FUNCNAME', [name, ...prevFuncname]);
    const prevBashSource = this.arrays.get('BASH_SOURCE') || [];
    this.arrays.set('BASH_SOURCE', ['main', ...prevBashSource]);
    this.callStack.push({ funcName: name, source: 'main' });

    // Push local variable frame for `local` declarations
    this.localVarStack.push(new Map());

    // Execute body — catch ReturnSignal for `return [N]`
    let exitCode = 0;
    try {
      exitCode = await this.execute(func.body, writeStdout, writeStderr);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        exitCode = e.code;
      } else {
        // Restore before re-throwing
        this.restoreLocalVars();
        this.arrays.set('FUNCNAME', prevFuncname);
        this.arrays.set('BASH_SOURCE', prevBashSource);
        this.callStack.pop();
        for (const key of Object.keys(saved)) {
          if (saved[key] === undefined) delete this.env[key];
          else this.env[key] = saved[key]!;
        }
        throw e;
      }
    }

    // Pop local variable frame — restore saved values
    this.restoreLocalVars();

    // Restore FUNCNAME and BASH_SOURCE stacks
    this.arrays.set('FUNCNAME', prevFuncname);
    this.arrays.set('BASH_SOURCE', prevBashSource);
    this.callStack.pop();

    // Restore positional params
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete this.env[key];
      else this.env[key] = saved[key]!;
    }

    return exitCode;
  }

  // ─── CONTROL STRUCTURES ───────────────────────────────────────────────────

  private isControlStructure(input: string): boolean {
    return /^if\s+/.test(input) || /^while\s+/.test(input) || /^until\s+/.test(input) || /^for\s+/.test(input) || /^case\s+/.test(input) || /^select\s+/.test(input);
  }

  private async execControlStructure(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    if (/^if\s+/.test(input)) return this.execIf(input, writeStdout, writeStderr);
    if (/^while\s+/.test(input)) return this.execWhile(input, writeStdout, writeStderr);
    if (/^until\s+/.test(input)) return this.execUntil(input, writeStdout, writeStderr);
    if (/^for\s+/.test(input)) return this.execFor(input, writeStdout, writeStderr);
    if (/^case\s+/.test(input)) return this.execCase(input, writeStdout, writeStderr);
    if (/^select\s+/.test(input)) return this.execSelect(input, writeStdout, writeStderr);
    return 0;
  }

  /**
   * Execute a control structure as a pipeline segment with piped stdin.
   * Used for patterns like: echo "data" | while read line; do ...; done
   */
  private async execControlStructurePiped(
    input: string, pipeStdin: string,
    writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    if (/^while\s+/.test(input)) return this.execWhile(input, writeStdout, writeStderr, pipeStdin);
    // For other control structures, set __PIPE_STDIN env and delegate
    const saved = this.env['__PIPE_STDIN'];
    this.env['__PIPE_STDIN'] = pipeStdin;
    const result = await this.execControlStructure(input, writeStdout, writeStderr);
    if (saved === undefined) delete this.env['__PIPE_STDIN'];
    else this.env['__PIPE_STDIN'] = saved;
    return result;
  }

  /** Discovery and execution share function/builtin/PATH/catalog/package precedence. */
  private commandHashes = new Map<string,{path:string; hits:number}>();

  /** Hash state belongs to the shell; the registered command delegates here. */
  async processHash(args:string[]): Promise<{stdout:string; stderr:string; exitCode:number}> {
    let stdout = '', stderr = '', exitCode = 0;
    const error = (message:string) => { stderr += `bash: line ${this.currentLine}: hash: ${message}\n`; exitCode = 1; };
    const usage = 'hash: usage: hash [-lr] [-p pathname] [-dt] [name ...]\n';
    if (!this.options.has('hashall')) { error('hashing disabled'); return {stdout,stderr,exitCode}; }
    let reset = false, remove = false, portable = false, targets = false, pathname:string|undefined;
    let index = 0;
    for (; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--') { index++; break; }
      if (!arg.startsWith('-') || arg === '-') break;
      for (let offset = 1; offset < arg.length; offset++) {
        const option = arg[offset];
        if (option === 'r') reset = true;
        else if (option === 'd') remove = true;
        else if (option === 'l') portable = true;
        else if (option === 't') targets = true;
        else if (option === 'p') {
          pathname = arg.slice(offset+1) || args[++index];
          if (pathname === undefined) {
            error('-p: option requires an argument'); stderr += usage;
            return {stdout,stderr,exitCode:2};
          }
          break;
        } else {
          error(`-${option}: invalid option`); stderr += usage;
          return {stdout,stderr,exitCode:2};
        }
      }
    }
    const names = args.slice(index);
    if (!names.length && (remove || targets)) {
      error(`${remove ? '-d' : '-t'}: option requires an argument`);
      return {stdout,stderr,exitCode};
    }
    if (reset) this.commandHashes.clear();
    const quote = (value:string) => /^[a-zA-Z0-9_./-]+$/.test(value) ? value : "'" + value.replace(/'/g,"'\\''") + "'";
    const line = (name:string,entry:{path:string; hits:number}) => portable
      ? `builtin hash -p ${quote(entry.path)} ${quote(name)}\n`
      : String(entry.hits).padStart(4) + '\t' + entry.path + '\n';
    if (!names.length) {
      if (!this.commandHashes.size) { if (!portable && !reset) stdout = 'hash: hash table empty\n'; }
      else {
        if (!portable) stdout = 'hits\tcommand\n';
        // Bash displays its filename table by FNV-1 bucket, newest collisions first.
        const bucket = (name:string) => {
          let hash = 2166136261;
          for (const byte of textToBytes(name)) hash = (Math.imul(hash,16777619) ^ (byte < 128 ? byte : byte-256)) >>> 0;
          return hash & 255;
        };
        const entries = [...this.commandHashes].reverse().sort(([a],[b]) => bucket(a)-bucket(b));
        for (const [name,entry] of entries) stdout += line(name,entry);
      }
      return {stdout,stderr,exitCode};
    }
    for (const name of names) {
      if (targets) {
        const entry = this.commandHashes.get(name);
        if (!entry) error(`${name}: not found`);
        else {
          entry.hits++;
          const path = entry.path.startsWith('/') || entry.path.startsWith('./') ? entry.path : './'+entry.path;
          stdout += portable ? `builtin hash -p ${path} ${name}\n` : (names.length > 1 ? name+'\t' : '') + path+'\n';
        }
      } else if (name.includes('/')) continue;
      else if (pathname !== undefined) {
        const stat = await this.fs.stat(this.fs.resolvePath(pathname,this.cwd)).catch(() => null);
        if (stat?.isDirectory()) error(`${pathname}: Is a directory`);
        else this.commandHashes.set(name,{path:pathname,hits:0});
      } else if (remove) {
        if (!this.commandHashes.delete(name)) error(`${name}: not found`);
      } else if (!(name in this.functions) && !(SHELL_BUILTINS.includes(name) && !this.disabledBuiltins.has(name))) {
        this.commandHashes.delete(name);
        const resolution = await this.resolveCommand(name,true,true,{ignoreHash:true});
        if (resolution?.kind === 'file') this.commandHashes.set(name,{path:resolution.hashPath ?? resolution.path ?? '/usr/bin/'+name,hits:0});
        else error(`${name}: not found`);
      }
    }
    return {stdout,stderr,exitCode};
  }

  /** Shared discovery formatting; catalog entries model external programs. */
  private describeCommand(name:string, resolution:NonNullable<Awaited<ReturnType<Shell['resolveCommand']>>>):string {
    if (resolution.kind === 'keyword') return `${name} is a shell keyword\n`;
    if (resolution.kind === 'alias') return `${name} is aliased to \`${this.aliases.get(name)}'\n`;
    if (resolution.kind === 'function') return `${name} is a function\n`;
    if (resolution.kind === 'builtin') return `${name} is a shell builtin\n`;
    return resolution.hashed ? `${name} is hashed (${resolution.path ?? '/usr/bin/'+name})\n`
      : `${name} is ${resolution.path ?? '/usr/bin/'+name}\n`;
  }

  /** Bash type modes share the execution resolver and the PATH iterator. */
  async processType(args:string[]):Promise<{stdout:string; stderr:string; exitCode:number}> {
    let stdout = '', stderr = '', exitCode = 0;
    let all = false, skipFunctions = false, terse = false, pathOnly = false, forcePath = false, index = 0;
    for (; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--') { index++; break; }
      if (!arg.startsWith('-') || arg === '-') break;
      for (const flag of arg.slice(1)) {
        if (flag === 'a') all = true;
        else if (flag === 'f') skipFunctions = true;
        else if (flag === 't') { terse = true; pathOnly = false; }
        else if (flag === 'p') { pathOnly = true; terse = false; }
        else if (flag === 'P') { forcePath = true; pathOnly = true; terse = false; }
        else return {stdout,stderr:`bash: line ${this.currentLine}: type: -${flag}: invalid option\ntype: usage: type [-afptP] name [name ...]\n`,exitCode:2};
      }
    }
    for (const name of args.slice(index)) {
      const matches:NonNullable<Awaited<ReturnType<Shell['resolveCommand']>>>[] = [];
      const first = await this.resolveCommand(name,skipFunctions,false,{ignoreHash:all&&!forcePath,pathOnly:forcePath});
      if (all && !(forcePath && first?.hashed)) {
        if (!forcePath) {
          if (this.shoptopts.has('expand_aliases') && this.aliases.has(name)) matches.push({kind:'alias',route:'parser'});
          if (SHELL_KEYWORDS.includes(name)) matches.push({kind:'keyword',route:'parser'});
          if (!skipFunctions && name in this.functions) matches.push({kind:'function',route:'function'});
          if (SHELL_BUILTINS.includes(name) && !this.disabledBuiltins.has(name)) matches.push({kind:'builtin',route:'parser'});
        }
        const paths = await this.findExecutablePaths(name,undefined,true);
        for (const path of paths) matches.push({kind:'file',route:'path',path});
        if (!paths.length) {
          const external = await this.resolveCommand(name,true,true,{ignoreHash:true,pathOnly:true});
          if (external?.kind === 'file') matches.push(external);
        }
      } else if (first) matches.push(first);
      if (!matches.length) {
        exitCode = 1;
        if (!terse && !pathOnly) stderr += `bash: line ${this.currentLine}: type: ${name}: not found\n`;
      }
      for (const match of matches) {
        if (pathOnly && match.kind !== 'file') continue;
        stdout += terse ? match.kind+'\n' : pathOnly ? (match.path ?? '/usr/bin/'+name)+'\n' : this.describeCommand(name,match);
      }
    }
    return {stdout,stderr,exitCode};
  }

  /** command bypasses functions for execution, but discovery still describes them. */
  async processCommand(args:string[], stdin=''):Promise<{stdout:string; stderr:string; exitCode:number}> {
    let mode = '', defaultPath = false, index = 0;
    for (; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--') { index++; break; }
      if (!arg.startsWith('-') || arg === '-') break;
      for (const flag of arg.slice(1)) {
        if (flag === 'p') defaultPath = true;
        else if (flag === 'v' || flag === 'V') mode = flag;
        else return {stdout:'',stderr:`bash: line ${this.currentLine}: command: -${flag}: invalid option\ncommand: usage: command [-pVv] command [arg ...]\n`,exitCode:2};
      }
    }
    const names = args.slice(index), pathOverride = defaultPath ? '/bin:/usr/bin' : undefined;
    if (!mode) return this.execArgv(names,stdin,true,pathOverride);
    let stdout = '', stderr = '', found = !names.length;
    for (const name of names) {
      const resolution = await this.resolveCommand(name,false,false,{pathOverride});
      if (!resolution) {
        if (mode === 'V') stderr += `bash: line ${this.currentLine}: command: ${name}: not found\n`;
        continue;
      }
      found = true;
      if (mode === 'V') stdout += this.describeCommand(name,resolution);
      else if (resolution.kind === 'file') stdout += (resolution.path ?? '/usr/bin/'+name)+'\n';
      else if (resolution.kind === 'alias') stdout += `alias ${name}='${(this.aliases.get(name) ?? '').replace(/'/g,"'\\''")}'\n`;
      else stdout += name+'\n';
    }
    return {stdout,stderr,exitCode:found?0:1};
  }

  async resolveCommand(name:string, skipFunctions=false, skipAliases=false, options:{ignoreHash?:boolean; pathOnly?:boolean; pathOverride?:string}={}): Promise<{
    kind:'keyword'|'alias'|'function'|'builtin'|'file';
    route:'parser'|'function'|'registry'|'path'|'package';
    path?:string; hashPath?:string; command?:import('./commands/index').Command; hashed?:boolean;
  } | null> {
    if (!options.pathOnly) {
      if (SHELL_KEYWORDS.includes(name)) return {kind:'keyword',route:'parser'};
      if (!skipAliases && this.shoptopts.has('expand_aliases') && this.aliases.has(name)) return {kind:'alias',route:'parser'};
      if (!skipFunctions && name in this.functions) return {kind:'function',route:'function'};
      if (SHELL_BUILTINS.includes(name) && !this.disabledBuiltins.has(name)) return {kind:'builtin',route:'parser',command:this.commands.get(name)};
    }
    if (!name.includes('/') && !options.ignoreHash && !this.temporaryPath && this.options.has('hashall')) {
      const entry = this.commandHashes.get(name);
      if (entry) {
        entry.hits++;
        const command = this.commands.get(name);
        if (command && (entry.path === '/usr/bin/'+name || entry.path === '/bin/'+name) && !await this.fs.exists(entry.path)) {
          return {kind:'file',route:'registry',path:entry.path,command,hashed:true};
        }
        if (!command && entry.path === '/usr/bin/'+name && resolvePackageCommand(name)) return {kind:'file',route:'package',hashed:true};
        return {kind:'file',route:'path',path:entry.path.startsWith('/') || entry.path.startsWith('./') ? entry.path : './'+entry.path,hashed:true};
      }
    }
    const path = await this.findExecutableInPath(name,options.pathOverride);
    if (path) return this.env.PATH === '' && path.startsWith('./')
      ? {kind:'file',route:'path',path:this.fs.resolvePath(path,this.cwd),hashPath:path.slice(2)}
      : {kind:'file',route:'path',path};
    const command = this.commands.get(name);
    if (command) return {kind:'file',route:'registry',command,...(options.pathOverride ? {path:options.pathOverride.split(':')[0]+'/'+name} : {})};
    if (resolvePackageCommand(name)) return {kind:'file',route:'package'};
    return null;
  }

  /** Index just past the "]]" closing a "[[" at line[i], or -1. Quotes are respected. */
  private doubleBracketEnd(line: string, i: number): number {
    let inS = false, inD = false;
    for (let k = i + 2; k < line.length; k++) {
      const c = line[k];
      if (c === '\\' && !inS) { k++; continue; }
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (!inS && !inD && c === ']' && line[k + 1] === ']' && /\s/.test(line[k - 1]) && (k + 2 >= line.length || /[\s;&|)]/.test(line[k + 2]))) return k + 2;
    }
    return -1;
  }

  /**
   * [[ … ]]: && || ! ( ) over tests; words are expanded without word splitting. == != match a
   * glob (quoted text literal), =~ an ERE (sets BASH_REMATCH), < > compare strings, -eq etc.
   * compare arithmetic values, plus the unary file and string tests.
   */
  private async evalDoubleBracket(inner: string): Promise<number> {
    // Words with their quoting; && || ( ) ! as operators when unquoted.
    const words: { raw: string; op?: string }[] = [];
    let cur = '', inS = false, inD = false;
    const flush = () => { if (cur) { words.push({ raw: cur }); cur = ''; } };
    for (let k = 0; k < inner.length; k++) {
      const c = inner[k];
      if (c === '\\' && !inS && k + 1 < inner.length) { cur += c + inner[++k]; continue; }
      if (c === "'" && !inD) { inS = !inS; cur += c; continue; }
      if (c === '"' && !inS) { inD = !inD; cur += c; continue; }
      // $( … ), ${ … } and ` … ` are one word, spaces inside included ([[ $(cmd arg) == x ]]).
      if (!inS && ((c === '$' && (inner[k + 1] === '(' || inner[k + 1] === '{')) || c === '`')) {
        const open = c === '`' ? '`' : inner[k + 1], close = open === '(' ? ')' : open === '{' ? '}' : '`';
        let j = c === '`' ? k + 1 : k + 2, depth = 1;
        while (j < inner.length && depth > 0) {
          const d = inner[j];
          if (d === '\\') { j += 2; continue; }
          if (close !== '`' && d === open) depth++;
          else if (d === close) depth--;
          j++;
        }
        cur += inner.slice(k, j); k = j - 1; continue;
      }
      if (!inS && !inD) {
        if (/\s/.test(c)) { flush(); continue; }
        const two = inner.slice(k, k + 2);
        if (two === '&&' || two === '||') { flush(); words.push({ raw: two, op: two }); k++; continue; }
        if ((c === '(' || c === ')') && !cur) { words.push({ raw: c, op: c }); continue; }
      }
      cur += c;
    }
    flush();
    const quotedParts = (raw: string) => /['"\\]/.test(raw);
    const expand = async (raw: string): Promise<string> => {
      const e = this.expandVars(this.expandArithmetic(await this.expandCommandSubstitution(raw, () => {})));
      // Remove quotes (no word splitting in [[ ]]).
      let out = '', q: string | null = null;
      for (let k = 0; k < e.length; k++) {
        const c = e[k];
        if (q === "'") { if (c === "'") q = null; else out += c; continue; }
        if (c === '\\' && k + 1 < e.length && (q === null || '$`"\\'.includes(e[k + 1]))) { out += e[++k]; continue; }
        if (q === '"') { if (c === '"') q = null; else out += c; continue; }
        if (c === "'" || c === '"') { q = c; continue; }
        out += c;
      }
      return out;
    };
    const statOf = async (f: string) => { try { return await this.fs.stat(this.fs.resolvePath(f, this.cwd)); } catch { return null; } };
    const UNARY = new Set(['-z', '-n', '-e', '-a', '-f', '-d', '-s', '-r', '-w', '-x', '-L', '-h', '-v', '-R', '-b', '-c', '-p', '-S', '-t', '-g', '-u', '-k', '-O', '-G', '-N']);
    const BINARY = new Set(['==', '=', '!=', '=~', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);
    let p = 0;
    const orE = async (): Promise<boolean> => { let v = await andE(); while (words[p]?.op === '||') { p++; const r = await andE(); v = v || r; } return v; };
    const andE = async (): Promise<boolean> => { let v = await notE(); while (words[p]?.op === '&&') { p++; const r = await notE(); v = v && r; } return v; };
    const notE = async (): Promise<boolean> => {
      if (words[p]?.raw === '!' && !words[p].op) { p++; return !(await notE()); }
      if (words[p]?.op === '(') { p++; const v = await orE(); if (words[p]?.op === ')') p++; return v; }
      return test();
    };
    const test = async (): Promise<boolean> => {
      const w0 = words[p], w1 = words[p + 1], w2 = words[p + 2];
      if (w1 && !w1.op && BINARY.has(w1.raw) && w2) {
        p += 3;
        const l = await expand(w0.raw), op = w1.raw;
        const r = await expand(w2.raw);
        const nocase = this.shoptopts.has('nocasematch');
        switch (op) {
          case '==': case '=': case '!=': {
            let hit: boolean;
            if (quotedParts(w2.raw)) hit = nocase ? l.toLowerCase() === r.toLowerCase() : l === r;
            else hit = new RegExp('^' + this.globToRegex(r) + '$', nocase ? 'is' : 's').test(l);
            return op === '!=' ? !hit : hit;
          }
          case '=~': {
            let m: RegExpExecArray | null = null;
            try { m = new RegExp(quotedParts(w2.raw) ? r.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') : ereToJs(r), nocase ? 'i' : '').exec(l); } catch { return false; }
            this.arrays.set('BASH_REMATCH', m ? m.map(x => x ?? '') : []);
            return !!m;
          }
          case '<': return l < r;
          case '>': return l > r;
          case '-nt': case '-ot': { const a = await statOf(l), b = await statOf(r); if (!a || !b) return op === '-nt' ? !!a : !!b; return op === '-nt' ? +a.mtime > +b.mtime : +a.mtime < +b.mtime; }
          case '-ef': return this.fs.resolvePath(l, this.cwd) === this.fs.resolvePath(r, this.cwd);
          default: {
            const a = this.evalArithmetic(l), b = this.evalArithmetic(r);
            return op === '-eq' ? a === b : op === '-ne' ? a !== b : op === '-lt' ? a < b : op === '-le' ? a <= b : op === '-gt' ? a > b : a >= b;
          }
        }
      }
      if (w0 && !w0.op && UNARY.has(w0.raw) && w1 && !w1.op) {
        p += 2;
        const v = await expand(w1.raw);
        switch (w0.raw) {
          case '-z': return v === '';
          case '-n': return v !== '';
          case '-v': return v in this.env || this.arrays.has(v);
          case '-R': return this.namerefs.has(v);
          case '-f': { const st = await statOf(v); return !!st && st.type === 'file'; }
          case '-d': { const st = await statOf(v); return !!st && st.type === 'dir'; }
          case '-s': { const st = await statOf(v); return !!st && st.type === 'file' && (st.size ?? 0) > 0; }
          case '-L': case '-h': { const st = await statOf(v); return !!st && st.type === 'symlink'; }
          case '-t': return false;
          default: return !!(await statOf(v));
        }
      }
      if (!w0 || w0.op) return false;
      p++;
      return (await expand(w0.raw)) !== '';
    };
    const ok = await orE();
    return ok ? 0 : 1;
  }

  /**
   * An if / while / until condition ready for evalCondition. [[ … ]] expands its own words (an empty
   * or unset $x stays an empty operand); expanding the text first made `[[ $x =~ re ]]` with x
   * unset a one-word test, always true.
   */
  private async conditionText(condition: string, writeStderr: (s: string) => void): Promise<string> {
    const t = condition.trim();
    if (t.startsWith('[[') && this.doubleBracketEnd(t, 0) === t.length) return t;
    return this.expandVars(this.expandArithmetic(await this.expandCommandSubstitution(condition, writeStderr)));
  }

  private async evalCondition(
    condition: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const trimmed = condition.trim();
    // [[ ... ]] syntax (bash double-bracket test)
    if (trimmed.startsWith('[[') && this.doubleBracketEnd(trimmed, 0) === trimmed.length) {
      return this.evalDoubleBracket(trimmed.slice(2, -2));
    }
    // [ … ] and test run as commands: normal expansion and quoting ([ "$x" = "a b" ]).
    // (( expr )) — arithmetic condition
    if (trimmed.startsWith('((') && trimmed.endsWith('))')) {
      const expr = this.expandVars(trimmed.slice(2, -2).trim());
      return this.evalArithmetic(expr) !== 0 ? 0 : 1;
    }
    // Execute as command
    const result = await this.exec(trimmed);
    if (result.stderr) writeStderr(result.stderr.replace(/\n/g, '\r\n'));
    if (result.stdout) writeStdout(result.stdout.replace(/\n/g, '\r\n'));
    return result.exitCode;
  }

  private async evalTest(args: string): Promise<number> {
    const tokens = args.split(/\s+/);
    if (tokens.length === 0) return 1;

    // Strip surrounding quotes from each token (vars already expanded by caller)
    const strip = (t: string) => {
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    };

    // Handle compound expressions with -a (AND) and -o (OR)
    const oIdx = tokens.indexOf('-o');
    if (oIdx > 0 && oIdx < tokens.length - 1) {
      const left = await this.evalTest(tokens.slice(0, oIdx).join(' '));
      const right = await this.evalTest(tokens.slice(oIdx + 1).join(' '));
      return (left === 0 || right === 0) ? 0 : 1;
    }
    const aIdx = tokens.indexOf('-a');
    if (aIdx > 0 && aIdx < tokens.length - 1) {
      const left = await this.evalTest(tokens.slice(0, aIdx).join(' '));
      const right = await this.evalTest(tokens.slice(aIdx + 1).join(' '));
      return (left === 0 && right === 0) ? 0 : 1;
    }

    // Single arg: true if non-empty string
    if (tokens.length === 1) {
      return strip(tokens[0]) !== '' ? 0 : 1;
    }

    if (tokens.length === 2) {
      const op = tokens[0];
      const expanded = strip(tokens[1]);
      switch (op) {
        case '-z': return expanded === '' ? 0 : 1;
        case '-n': return expanded !== '' ? 0 : 1;
        case '-e': case '-r': case '-w': case '-x':
          try { await this.fs.stat(this.fs.resolvePath(expanded, this.cwd)); return 0; } catch { return 1; }
        case '-f':
          try { const s = await this.fs.stat(this.fs.resolvePath(expanded, this.cwd)); return s.type === 'file' ? 0 : 1; } catch { return 1; }
        case '-d':
          try { const s = await this.fs.stat(this.fs.resolvePath(expanded, this.cwd)); return s.type === 'dir' ? 0 : 1; } catch { return 1; }
        case '-s':
          try {
            const s = await this.fs.stat(this.fs.resolvePath(expanded, this.cwd));
            return s.type === 'file' && (s.size ?? 0) > 0 ? 0 : 1;
          } catch { return 1; }
        case '-L': case '-h':
          try {
            const s = await this.fs.stat(this.fs.resolvePath(expanded, this.cwd));
            return s.type === 'symlink' ? 0 : 1;
          } catch { return 1; }
        case '-v': return (expanded in this.env) ? 0 : 1;
        case '-R': return this.namerefs.has(expanded) ? 0 : 1;
        case '!': return (await this.evalTest(tokens.slice(1).join(' '))) === 0 ? 1 : 0;
      }
    }

    if (tokens.length === 3) {
      const left = strip(tokens[0]);
      const op = tokens[1];
      const right = strip(tokens[2]);
      switch (op) {
        case '=': case '==': {
          // Support glob patterns (and extglob) in [[ ]] (*, ?, [...], ?()|*()...)
          const hasGlob = right.includes('*') || right.includes('?') || right.includes('[') ||
            (this.shoptopts.has('extglob') && /[?*+@!]\(/.test(right));
          if (hasGlob) {
            const re = new RegExp('^' + this.globToRegex(right) + '$');
            return re.test(left) ? 0 : 1;
          }
          return left === right ? 0 : 1;
        }
        case '!=': {
          const hasGlob2 = right.includes('*') || right.includes('?') || right.includes('[') ||
            (this.shoptopts.has('extglob') && /[?*+@!]\(/.test(right));
          if (hasGlob2) {
            const re = new RegExp('^' + this.globToRegex(right) + '$');
            return re.test(left) ? 1 : 0;
          }
          return left !== right ? 0 : 1;
        }
        case '-eq': return parseInt(left) === parseInt(right) ? 0 : 1;
        case '-ne': return parseInt(left) !== parseInt(right) ? 0 : 1;
        case '-lt': return parseInt(left) < parseInt(right) ? 0 : 1;
        case '-le': return parseInt(left) <= parseInt(right) ? 0 : 1;
        case '-gt': return parseInt(left) > parseInt(right) ? 0 : 1;
        case '-ge': return parseInt(left) >= parseInt(right) ? 0 : 1;
        case '=~': {
          // Regex match (bash [[ =~ ]])
          try {
            const re = new RegExp(right);
            const match = left.match(re);
            if (match) {
              // Set BASH_REMATCH array
              this.arrays.set('BASH_REMATCH', match.map(m => m ?? ''));
              return 0;
            }
            return 1;
          } catch { return 1; }
        }
        case '<': return left < right ? 0 : 1;
        case '>': return left > right ? 0 : 1;
      }
    }

    return args.trim() !== '' ? 0 : 1;
  }

  private async execIf(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    // Normalize to semicolons for easier parsing
    const joined = input.replace(/\r?\n/g, '; ').replace(/;\s*;/g, ';');

    // Parse if/elif/else/fi with depth tracking for nested if blocks
    interface IfBranch { condition: string; body: string; }
    const branches: IfBranch[] = [];
    let elseBody = '';

    const tokens = this.shellTokenScan(joined);
    // Find the structure at depth 0
    type Marker = { word: string; pos: number };
    const depth0: Marker[] = [];
    let ifDepth = 0;
    for (const tok of tokens) {
      if (tok.word === 'if') {
        if (ifDepth === 0) depth0.push(tok);
        ifDepth++;
      } else if (tok.word === 'fi') {
        ifDepth--;
        if (ifDepth === 0) depth0.push(tok);
      } else if (ifDepth === 1 && (tok.word === 'then' || tok.word === 'elif' || tok.word === 'else')) {
        depth0.push(tok);
      }
    }

    // Parse structure: if COND then BODY [elif COND then BODY]* [else BODY] fi
    let i = 0;
    while (i < depth0.length) {
      const cur = depth0[i];
      if (cur.word === 'if' || cur.word === 'elif') {
        // Find the 'then' after this
        const thenMarker = depth0[i + 1];
        if (!thenMarker || thenMarker.word !== 'then') { writeStderr('if: syntax error\r\n'); return 1; }
        const condStr = joined.slice(cur.pos + cur.word.length, thenMarker.pos).trim().replace(/^;\s*/, '').replace(/;\s*$/, '').trim();
        // Find the next elif/else/fi
        const nextMarker = depth0[i + 2];
        const bodyEnd = nextMarker ? nextMarker.pos : joined.length;
        const bodyStr = joined.slice(thenMarker.pos + 4, bodyEnd).trim().replace(/^;\s*/, '').replace(/;\s*$/, '').trim();
        branches.push({ condition: condStr, body: bodyStr });
        i += 2;
      } else if (cur.word === 'else') {
        const nextMarker = depth0[i + 1]; // should be fi
        const bodyEnd = nextMarker ? nextMarker.pos : joined.length;
        elseBody = joined.slice(cur.pos + 4, bodyEnd).trim().replace(/^;\s*/, '').replace(/;\s*$/, '').trim();
        i++;
      } else if (cur.word === 'fi') {
        break;
      } else {
        i++;
      }
    }

    if (branches.length === 0) { writeStderr('if: syntax error\r\n'); return 1; }

    // Evaluate branches in order
    for (const branch of branches) {
      const condResult = await this.evalCondition(await this.conditionText(branch.condition, writeStderr), writeStdout, writeStderr);
      if (condResult === 0) {
        return branch.body.trim() ? this.execute(branch.body, writeStdout, writeStderr) : 0;
      }
    }

    // No branch matched, try else
    if (elseBody) {
      return this.execute(elseBody, writeStdout, writeStderr);
    }
    return 0;
  }

  /**
   * Parse a loop construct (while/until/for) extracting condition and body.
   * Handles nested loops by tracking do/done depth.
   */
  private parseLoopConstruct(input: string, keyword: string): { condition: string; body: string } | null {
    // Find '; do ' or standalone 'do' with depth tracking
    const joined = input.replace(/\r?\n/g, '; ');
    // Scan for 'do' at depth 0 (not inside nested for/while/until)
    let depth = 0;
    let doPos = -1;
    let donePos = -1;
    const tokens = this.shellTokenScan(joined);
    for (const tok of tokens) {
      if (tok.word === 'for' || tok.word === 'while' || tok.word === 'until' || tok.word === 'select') {
        if (tok.pos > 0) depth++; // nested loop (skip the outermost keyword)
      } else if (tok.word === 'do') {
        if (depth === 0) { doPos = tok.pos; }
        else depth--; // absorb do for the nested loop
      } else if (tok.word === 'done') {
        if (doPos >= 0 && depth === 0) { donePos = tok.pos; break; }
        else if (depth > 0) depth--; // nested done
      }
    }
    if (doPos < 0) return null;

    // Condition: between keyword and 'do'
    let condStart = keyword.length;
    let condEnd = doPos;
    // Handle "; do" — strip trailing semicolons
    let condStr = joined.slice(condStart, condEnd).trim().replace(/;\s*$/, '').trim();

    // Body: between 'do' and last 'done'
    let bodyStart = doPos + 2; // length of 'do'
    let bodyEnd = donePos >= 0 ? donePos : joined.length;
    let bodyStr = joined.slice(bodyStart, bodyEnd).trim().replace(/^;\s*/, '').replace(/;\s*$/, '').trim();

    return { condition: condStr, body: bodyStr };
  }

  /**
   * Scan input for shell keywords at word boundaries, respecting quotes.
   */
  private shellTokenScan(input: string): { word: string; pos: number }[] {
    const results: { word: string; pos: number }[] = [];
    let inSQ = false, inDQ = false;
    let i = 0;
    const keywords = ['for', 'while', 'until', 'select', 'do', 'done', 'if', 'then', 'elif', 'else', 'fi', 'case', 'esac', 'in'];
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\\' && !inSQ) { i += 2; continue; }
      if (ch === "'" && !inDQ) { inSQ = !inSQ; i++; continue; }
      if (ch === '"' && !inSQ) { inDQ = !inDQ; i++; continue; }
      if (inSQ || inDQ) { i++; continue; }
      // Check word boundary
      const prevCh = i > 0 ? input[i - 1] : ' ';
      if (/[\s;]/.test(prevCh) || i === 0) {
        for (const kw of keywords) {
          if (input.slice(i, i + kw.length) === kw) {
            const after = input[i + kw.length];
            if (after === undefined || /[\s;]/.test(after)) {
              results.push({ word: kw, pos: i });
              i += kw.length;
              break;
            }
          }
        }
      }
      i++;
    }
    return results;
  }

  private async execWhile(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void,
    pipeStdin?: string,
  ): Promise<number> {
    // A loop’s status is its body’s last command’s (0 when the body never ran or ended in break).
    let loopStatus = 0;
    const parsed = this.parseLoopConstruct(input, 'while');
    if (!parsed) { writeStderr('while: syntax error\r\n'); return 1; }

    // If piped stdin is provided, store remaining lines for `read` to consume
    const savedPipeStdin = this.env['__PIPE_STDIN'];
    if (pipeStdin !== undefined) {
      this.env['__PIPE_STDIN'] = pipeStdin;
    }

    let iter = 0;
    while (this.requestedExit === null && iter++ < 10000) {
      // Expand vars in condition each iteration (loop vars like $X change)
      const expandedCond = await this.conditionText(parsed.condition, writeStderr);
      if ((await this.evalCondition(expandedCond, writeStdout, writeStderr)) !== 0) break;
      try {
        loopStatus = parsed.body.trim() ? await this.execute(parsed.body, writeStdout, writeStderr) : 0;
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); loopStatus = 0; break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); continue; }
        throw e;
      }
    }

    // Restore
    if (pipeStdin !== undefined) {
      if (savedPipeStdin === undefined) delete this.env['__PIPE_STDIN'];
      else this.env['__PIPE_STDIN'] = savedPipeStdin;
    }
    return loopStatus;
  }

  private async execUntil(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    // A loop’s status is its body’s last command’s (0 when the body never ran or ended in break).
    let loopStatus = 0;
    const parsed = this.parseLoopConstruct(input, 'until');
    if (!parsed) { writeStderr('until: syntax error\r\n'); return 1; }

    let iter = 0;
    while (this.requestedExit === null && iter++ < 10000) {
      const expandedCond = await this.conditionText(parsed.condition, writeStderr);
      if ((await this.evalCondition(expandedCond, writeStdout, writeStderr)) === 0) break;
      try {
        loopStatus = parsed.body.trim() ? await this.execute(parsed.body, writeStdout, writeStderr) : 0;
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); loopStatus = 0; break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); continue; }
        throw e;
      }
    }
    return loopStatus;
  }

  private async execFor(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    // A loop’s status is its body’s last command’s (0 when the body never ran or ended in break).
    let loopStatus = 0;
    const parsed = this.parseLoopConstruct(input, 'for');
    if (!parsed) { writeStderr('for: syntax error\r\n'); return 1; }

    // C-style for loop: for ((init; test; update))
    const cStyleMatch = parsed.condition.match(/^\(\((.+)\)\)$/s);
    if (cStyleMatch) {
      const parts = cStyleMatch[1].split(';').map(s => s.trim());
      if (parts.length !== 3) { writeStderr('for: syntax error in arithmetic\r\n'); return 1; }
      const [init, test, update] = parts;
      // Execute init expression
      this.evalArithmetic(init);
      // Loop
      let iter = 0;
      while (this.requestedExit === null && iter++ < 10000) {
        // Evaluate test — 0 means false (stop)
        if (test && this.evalArithmetic(test) === 0) break;
        // Execute body
        try {
          loopStatus = parsed.body.trim() ? await this.execute(parsed.body, writeStdout, writeStderr) : 0;
        } catch (e) {
          if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); loopStatus = 0; break; }
          if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); /* fall through to update */ }
          else throw e;
        }
        // Execute update
        if (update) this.evalArithmetic(update);
      }
      return loopStatus;
    }

    // Parse "VAR in item1 item2 item3" from condition
    // for NAME [in WORDS]: without "in", the positional parameters ("$@").
    const bare = /^(\w+)\s*;?$/.exec(parsed.condition.trim());
    const forMatch = bare ? null : parsed.condition.match(/^(\w+)\s+in(?:\s+([\s\S]*))?$/);
    if (!bare && !forMatch) { writeStderr('for: syntax error\r\n'); return 1; }

    const varName = bare ? bare[1] : forMatch![1];
    const items = bare ? this.positionalParams() : await this.expandWordList(forMatch![2] ?? '', writeStderr);
    for (const item of items) {
      if (this.requestedExit !== null) break;
      this.env[varName] = item;
      try {
        loopStatus = parsed.body.trim() ? await this.execute(parsed.body, writeStdout, writeStderr) : 0;
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); loopStatus = 0; break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); continue; }
        throw e;
      }
    }
    return loopStatus;
  }

  /**
   * Expands a for/select word list like a command's arguments: quotes keep words together
   * ("a b", "$@", "${arr[@]}"), unquoted globs expand to matching names.
   */
  private async expandWordList(words: string, writeStderr: (s: string) => void): Promise<string[]> {
    const expanded = this.expandVars(this.expandArithmetic(await this.expandCommandSubstitution(words, writeStderr)));
    const tokens = this.tokenize(expanded).flatMap(t => this.expandBraces(t) === t ? [t] : this.tokenize(this.expandBraces(t)));
    return (await this.expandGlobs(tokens, writeStderr)) ?? [];
  }

  private async execSelect(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    // A loop’s status is its body’s last command’s (0 when the body never ran or ended in break).
    let loopStatus = 0;
    const parsed = this.parseLoopConstruct(input, 'select');
    if (!parsed) { writeStderr('select: syntax error\r\n'); return 1; }

    // Parse "VAR in item1 item2 item3" from condition
    const selMatch = parsed.condition.match(/^(\w+)\s+in\s+(.+)$/);
    if (!selMatch) { writeStderr('select: syntax error\r\n'); return 1; }

    const varName = selMatch[1];
    const items = await this.expandWordList(selMatch[2], writeStderr);

    // Display menu
    for (let idx = 0; idx < items.length; idx++) {
      writeStdout(`${idx + 1}) ${items[idx]}\r\n`);
    }

    // Read selection from stdin (__PIPE_STDIN or REPLY)
    const ps3 = this.env['PS3'] || '#? ';
    const hasPipeStdin = '__PIPE_STDIN' in this.env;
    let readInput = hasPipeStdin ? this.env['__PIPE_STDIN'] : '';

    let iter = 0;
    while (this.requestedExit === null && iter++ < 100) {
      // Get one line of input
      const firstNewline = readInput.indexOf('\n');
      let choice: string;
      if (firstNewline >= 0) {
        choice = readInput.slice(0, firstNewline).trim();
        readInput = readInput.slice(firstNewline + 1);
        if (hasPipeStdin) this.env['__PIPE_STDIN'] = readInput;
      } else if (readInput.trim()) {
        choice = readInput.trim();
        readInput = '';
        if (hasPipeStdin) delete this.env['__PIPE_STDIN'];
      } else {
        break; // no more input
      }

      this.env['REPLY'] = choice;
      const num = parseInt(choice, 10);
      if (num >= 1 && num <= items.length) {
        this.env[varName] = items[num - 1];
      } else {
        this.env[varName] = '';
      }

      try {
        loopStatus = parsed.body.trim() ? await this.execute(parsed.body, writeStdout, writeStderr) : 0;
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); loopStatus = 0; break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); continue; }
        throw e;
      }

      // In non-interactive (piped) mode, process one selection then stop
      if (!hasPipeStdin) break;
    }

    return loopStatus;
  }

  private async execCase(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    // Normalize newlines to semicolons (preserve ;; clause separators)
    const joined = input.replace(/\r?\n/g, '; ');

    // Parse: case WORD in ... esac
    const caseMatch = joined.match(/^case\s+(.+?)\s+in\b/);
    if (!caseMatch) { writeStderr('case: syntax error\r\n'); return 1; }

    const rawWord = caseMatch[1].trim();
    const word = this.expandVars(await this.expandCommandSubstitution(rawWord, writeStderr)).replace(/^["']|["']$/g, '');

    // Get the body between 'in' and 'esac'
    const inPos = joined.indexOf(' in', caseMatch.index! + 4) + 3;
    const tokens = this.shellTokenScan(joined);
    const esacTok = tokens.find(t => t.word === 'esac');
    const body = joined.slice(inPos, esacTok ? esacTok.pos : joined.length).trim();

    // Split body into clauses, tracking separator type (;;, ;&, ;;&)
    const clauseParts: { text: string; separator: string }[] = [];
    let remaining = body;
    while (remaining) {
      // Find next separator: ;;&, ;&, or ;;
      const sepMatch = remaining.match(/(;;&|;&|;;)/);
      if (sepMatch) {
        clauseParts.push({ text: remaining.slice(0, sepMatch.index!).trim(), separator: sepMatch[1] });
        remaining = remaining.slice(sepMatch.index! + sepMatch[1].length).trim();
      } else {
        if (remaining.trim()) clauseParts.push({ text: remaining.trim(), separator: ';;' });
        break;
      }
    }

    let fallthrough = false;
    for (let ci = 0; ci < clauseParts.length; ci++) {
      const clause = clauseParts[ci].text;
      if (!clause) continue;
      // Parse: pattern[|pattern]) commands — extglob-aware: don't split on ) inside ?()/*()/etc.
      let clausePatterns = '';
      let clauseCommands = '';
      let parenDepth = 0;
      let foundClauseSplit = false;
      for (let ci2 = 0; ci2 < clause.length; ci2++) {
        const c = clause[ci2];
        if (this.shoptopts.has('extglob') && '?*+@!'.includes(c) && clause[ci2 + 1] === '(') {
          parenDepth++;
          clausePatterns += c + '(';
          ci2++; // skip the '(' — handled as unit with prefix
          continue;
        }
        if (parenDepth > 0 && c === '(') { parenDepth++; clausePatterns += c; continue; }
        if (parenDepth > 0 && c === ')') { parenDepth--; clausePatterns += c; continue; }
        if (c === ')' && parenDepth === 0) {
          clauseCommands = clause.slice(ci2 + 1);
          foundClauseSplit = true;
          break;
        }
        clausePatterns += c;
      }
      if (!foundClauseSplit) continue;
      // Split patterns on top-level | (not inside extglob parens)
      const patterns: string[] = [];
      let patBuf = '';
      let patParenDepth = 0;
      for (let pi = 0; pi < clausePatterns.length; pi++) {
        const pc = clausePatterns[pi];
        if (this.shoptopts.has('extglob') && '?*+@!'.includes(pc) && clausePatterns[pi + 1] === '(') {
          patParenDepth++;
          patBuf += pc + '(';
          pi++; // skip the '(' — handled as unit with prefix
          continue;
        }
        if (patParenDepth > 0 && pc === '(') { patParenDepth++; patBuf += pc; continue; }
        if (patParenDepth > 0 && pc === ')') { patParenDepth--; patBuf += pc; continue; }
        if (pc === '|' && patParenDepth === 0) {
          patterns.push(patBuf.trim().replace(/^\(/, ''));
          patBuf = '';
          continue;
        }
        patBuf += pc;
      }
      patterns.push(patBuf.trim().replace(/^\(/, ''));
      const commands = clauseCommands.trim().replace(/^;\s*/, '').replace(/;\s*$/, '');

      let matched = fallthrough;
      if (!matched) {
        for (const p of patterns) {
          if (p === '*') { matched = true; break; }
          if (word === p) { matched = true; break; }
          const re = new RegExp('^' + this.globToRegex(p) + '$');
          if (re.test(word)) { matched = true; break; }
        }
      }
      if (matched) {
        let exitCode = 0;
        if (commands) exitCode = await this.execute(commands, writeStdout, writeStderr);
        const sep = clauseParts[ci].separator;
        if (sep === ';&') { fallthrough = true; continue; } // fallthrough: execute next body without checking
        if (sep === ';;&') { fallthrough = false; continue; } // continue checking remaining patterns
        return exitCode; // ;; — done
      }
      fallthrough = false;
    }
    return 0;
  }

  // ─── PATH EXECUTION ─────────────────────────────────────────────────────────

  /**
   * Search PATH directories for an executable file.
   * Also checks node_modules/.bin relative to cwd.
   */
  async findExecutableInPath(name: string, pathOverride?:string): Promise<string | null> {
    return (await this.findExecutablePaths(name,pathOverride))[0] ?? null;
  }

  /** The same iterator supports dispatch and type's all-path modes. */
  private async findExecutablePaths(name:string, pathOverride?:string, all=false):Promise<string[]> {
    const matches:string[] = [];
    // If name contains '/', treat it as a path
    if (name.includes('/')) {
      const resolved = this.fs.resolvePath(name, this.cwd);
      try {
        const stat = await this.fs.stat(resolved);
        if (stat.type === 'file') return [resolved];
      } catch {
        return [];
      }
      return [];
    }

    // Build search path: node_modules/.bin first, then PATH
    const pathDirs: string[] = [];

    // Add node_modules/.bin from cwd (most specific first)
    let dir = pathOverride === undefined ? this.cwd : '/';
    while (dir !== '/') {
      pathDirs.push(`${dir}/node_modules/.bin`);
      const parent = dir.substring(0, dir.lastIndexOf('/')) || '/';
      if (parent === dir) break;
      dir = parent;
    }
    if (pathOverride === undefined) pathDirs.push('/node_modules/.bin');

    // Add PATH directories
    const envPath = pathOverride ?? this.env['PATH'] ?? '';
    if (envPath) {
      pathDirs.push(...envPath.split(':'));
    } else if ('PATH' in this.env) {
      pathDirs.push('');
    }

    // Search each directory (also check for .wasm extension)
    for (const pathDir of pathDirs) {
      for (const suffix of ['', '.wasm']) {
        const candidate = `${pathDir || '.'}/${name}${suffix}`;
        try {
          const absolute = this.fs.resolvePath(candidate,this.cwd);
          const stat = await this.fs.stat(absolute);
          if ((stat.type === 'file' || stat.type === 'symlink') && (stat.mode & 0o111)) {
            const owner = this.commands.get(name);
            if (owner && owner.route !== 'wasm' && stat.size <= 1024) {
              const text = await this.fs.readFile(absolute,'utf8');
              // Installing an explicit alternative must not change a catalog command's
              // default owner. The managed executable remains callable by its full path.
              if (typeof text === 'string' && text.startsWith('#!wasi-pkg ')) continue;
            }
            matches.push(candidate);
            if (!all) return matches;
            break;
          }
        } catch {
          // Not found, continue
        }
      }
    }

    return matches;
  }

  /**
   * Execute a script file, following symlinks and handling shebangs.
   */
  private async executeScript(
    filePath: string,
    args: string[],
    ctx: CommandContext,
    writeStdout: (s: string) => void,
    writeStderr: (s: string) => void,
  ): Promise<number> {
    const invokedPath = filePath;
    filePath = this.fs.resolvePath(filePath,this.cwd);
    // Resolve symlinks
    let resolvedPath = filePath;
    try {
      const stat = await this.fs.stat(filePath);
      if (!(stat.mode & 0o111)) {
        ctx.stderr += `bash: line ${this.currentLine}: ${invokedPath}: Permission denied\n`;
        return 126;
      }
      if (stat.type === 'symlink') {
        const linkTarget = await this.fs.readlink(filePath);
        // Resolve relative symlink targets
        if (!linkTarget.startsWith('/')) {
          const linkDir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
          resolvedPath = this.fs.resolvePath(linkTarget, linkDir);
        } else {
          resolvedPath = linkTarget;
        }
      }
    } catch (e: any) {
      ctx.stderr += `bash: line ${this.currentLine}: ${invokedPath}: ${filesystemError(e)}\n`;
      return e.code === 'ENOENT' ? 127 : 126;
    }

    // Read script content
    let content: string;
    try {
      content = await this.fs.readFile(resolvedPath, 'utf8') as string;
    } catch (e: any) {
      writeStderr(`shiro: ${resolvedPath}: ${e.message}\r\n`);
      return 1;
    }

    // Check if this is a WASM binary — run through WASI runtime
    if (content.charCodeAt(0) === 0x00 && content.charCodeAt(1) === 0x61 &&
        content.charCodeAt(2) === 0x73 && content.charCodeAt(3) === 0x6d) {
      return this.executeWasmBinary(resolvedPath, args, ctx, writeStdout, writeStderr);
    }

    // Check for #!wasi-pkg stub — load from package cache
    if (content.startsWith('#!wasi-pkg ')) {
      const [pkgName, ...stubArgs] = content.split('\n')[0].substring('#!wasi-pkg '.length).trim().split(/\s+/);
      try {
        return await runPackageCommand(ctx,pkgName,[...stubArgs,...args]);
      } catch (e: any) {
        const { WasiExit } = await loadWasiRuntime();
        if (e instanceof WasiExit) return e.code;
        writeStderr(`shiro: ${pkgName}: ${e.message}\r\n`);
        return 1;
      }
    }

    // Check for #!x86-pkg stub — load from x86 ELF package cache
    if (content.startsWith('#!x86-pkg ')) {
      const parts = content.split('\n')[0].substring('#!x86-pkg '.length).trim().split(/\s+/);
      const pkgName = parts[0];
      const appletName = parts[1]; // undefined if not a multi-call binary
      try {
        const { getX86Binary } = await import('./x86-packages');
        const elfData = await getX86Binary(pkgName, (msg) => {
          this.onProgress?.(msg);
        });
        const { executeElfFromBytes } = await import('./x86/runtime');
        const argv0 = appletName || pkgName;
        return executeElfFromBytes(elfData, argv0, args, {
          fs: this.fs, cwd: this.cwd, args, env: this.env,
          // into ctx like every other command, so that pipes and redirects see the output
          stdin: ctx.stdin || '', writeStdout: t => { ctx.stdout += t; }, writeStderr: t => { ctx.stderr += t; },
        });
      } catch (e: any) {
        writeStderr(`shiro: ${pkgName}: ${e.message}\r\n`);
        return 1;
      }
    }

    // Detect ELF binaries → run in x86-64 emulator
    if (content.charCodeAt(0) === 0x7f && content.charCodeAt(1) === 0x45 /* E */ &&
        content.charCodeAt(2) === 0x4c /* L */ && content.charCodeAt(3) === 0x46 /* F */) {
      const { executeElf } = await import('./x86/runtime');
      return executeElf(resolvedPath, args, {
        fs: this.fs, cwd: this.cwd, args, env: this.env,
        stdin: ctx.stdin || '', writeStdout: t => { ctx.stdout += t; }, writeStderr: t => { ctx.stderr += t; },
      });
    }

    // Reject other binary files (Mach-O, etc.) that can't be interpreted
    if (content.charCodeAt(0) === 0x7f || content.includes('\0')) {
      writeStderr(`shiro: ${resolvedPath}: cannot execute binary file\n`);
      return 126;
    }

    // Check for shebang
    const firstLine = content.split('\n')[0];
    if (firstLine.startsWith('#!')) {
      const shebang = firstLine.substring(2).trim();
      const [interpreter, ...interpArgs] = shebang.split(/\s+/);

      // Handle common interpreters
      if (interpreter === '/usr/bin/env' || interpreter === '/bin/env') {
        // env node script.js -> node script.js
        const realInterp = interpArgs[0];
        if (realInterp === 'node' || realInterp === 'nodejs') {
          return this.executeNodeScript(resolvedPath, content, args, ctx, writeStdout, writeStderr);
        } else if (realInterp === 'sh' || realInterp === 'bash') {
          return this.executeShellScript(content, args, ctx, writeStdout, writeStderr);
        }
        // Unknown interpreter via env
        writeStderr(`shiro: cannot execute ${realInterp} scripts\r\n`);
        return 126;
      } else if (interpreter.endsWith('/node') || interpreter.endsWith('/nodejs')) {
        return this.executeNodeScript(resolvedPath, content, args, ctx, writeStdout, writeStderr);
      } else if (interpreter.endsWith('/sh') || interpreter.endsWith('/bash')) {
        return this.executeShellScript(content, args, ctx, writeStdout, writeStderr);
      }

      // Unknown shebang interpreter
      writeStderr(`shiro: cannot execute ${interpreter} scripts\r\n`);
      return 126;
    }

    // No shebang - try to detect file type
    // Check if content is just a path to another file (npm bin stubs)
    const trimmedContent = content.trim();
    if (!trimmedContent.includes('\n') && !trimmedContent.includes(' ') &&
        (trimmedContent.endsWith('.js') || trimmedContent.endsWith('.mjs') || trimmedContent.endsWith('.ts'))) {
      try {
        const targetContent = await this.fs.readFile(trimmedContent, 'utf8') as string;
        return this.executeNodeScript(trimmedContent, targetContent, args, ctx, writeStdout, writeStderr);
      } catch (e: any) {
        // Target doesn't exist, fall through
      }
    }

    // If it looks like JavaScript, run with node
    if (resolvedPath.endsWith('.js') || resolvedPath.endsWith('.mjs') ||
        content.trimStart().startsWith('const ') ||
        content.trimStart().startsWith('import ') ||
        content.trimStart().startsWith('var ') ||
        content.trimStart().startsWith('let ')) {
      return this.executeNodeScript(resolvedPath, content, args, ctx, writeStdout, writeStderr);
    }

    // Default to shell script
    return this.executeShellScript(content, args, ctx, writeStdout, writeStderr);
  }

  /**
   * Abort scopes: `timeout` runs its command inside one and aborts it when the time is up, which
   * stops the command's remaining statements and wakes a pending `sleep`, without touching the
   * enclosing script (the top-level abortController is Ctrl+C for the whole line).
   */
  private abortScopes: AbortController[] = [];
  private inheritedSignals: AbortSignal[] = [];
  pushAbortScope(): AbortController { const c = new AbortController(); this.abortScopes.push(c); return c; }
  popAbortScope(c: AbortController): void { const i = this.abortScopes.indexOf(c); if (i >= 0) this.abortScopes.splice(i, 1); }
  /** True when Ctrl+C was pressed or an enclosing `timeout` expired. */
  isAborted(): boolean {
    return !!this.abortController?.signal.aborted || this.abortScopes.some(c => c.signal.aborted) || this.inheritedSignals.some(s => s.aborted);
  }
  /** One signal that fires on either of those, for commands that wait (sleep, watch). */
  abortSignal(): AbortSignal | undefined {
    const sigs = [this.abortController?.signal, ...this.abortScopes.map(c => c.signal), ...this.inheritedSignals].filter((x): x is AbortSignal => !!x);
    if (sigs.length === 0) return undefined;
    if (sigs.length === 1) return sigs[0];
    const any = (AbortSignal as any).any as ((s: AbortSignal[]) => AbortSignal) | undefined;
    if (any) return any(sigs);
    const merged = new AbortController();
    for (const sg of sigs) sg.addEventListener('abort', () => merged.abort(), { once: true });
    return merged.signal;
  }

  /**
   * Absolute deadlines (Date.now() values) of the enclosing `timeout` commands. A program started
   * under one is killed when the earliest passes (see wasi-host.ts).
   */
  private deadlines: number[] = [];
  pushDeadline(at: number): void { this.deadlines.push(at); }
  popDeadline(): void { this.deadlines.pop(); }
  /** Milliseconds until the earliest enclosing deadline, or undefined when there is none. */
  remainingDeadlineMs(): number | undefined {
    if (this.deadlines.length === 0) return undefined;
    return Math.max(1, Math.min(...this.deadlines) - Date.now());
  }

  /** Run a compiled WASM module (in a Worker with a deadline when one is available). */
  async execWasmModule(wasmModule: WebAssembly.Module, config: import('./wasi-runtime').WasiConfig): Promise<number> {
    const { execWasi } = await import('./wasi-host');
    // the program may fork and exec: it can run any command of this shell (see execForWasm)
    const withProcs = { ...config, exec: (req: import('./wasi-runtime').ExecRequest) => this.execForWasm(req), commands: this.commands.list().map(c => c.name) };
    return execWasi(withProcs, wasmModule, { deadlineMs: this.remainingDeadlineMs(), signal:this.abortSignal() });
  }

  /** exec() from a WASM program: run argv as a command of this shell, under the program's environment. */
  private async execForWasm(req: import('./wasi-runtime').ExecRequest): Promise<import('./wasi-runtime').ExecResult> {
    const child = this.fork();
    if (req.signal) child.inheritedSignals.push(req.signal);
    child.env = { ...req.env, PWD:req.cwd };
    child.cwd = req.cwd;
    const result = await child.execArgv(req.argv, req.stdin);
    return { stdout:result.stdout, stderr:result.stderr, code:result.exitCode };
  }

  /**
   * Execute a WASM+WASI binary through the WasiRT.
   */
  private async executeWasmBinary(
    filePath: string,
    args: string[],
    ctx: CommandContext,
    writeStdout: (s: string) => void,
    writeStderr: (s: string) => void,
  ): Promise<number> {
    try {
      const data = await this.fs.readFile(filePath) as Uint8Array;
      const wasmBytes = new Uint8Array(data).buffer;
      const { compileWasm } = await import('./wasm-module');
      const wasmModule = await compileWasm(wasmBytes);

      const programName = filePath.split('/').pop() || filePath;
      const config = {
        fs: this.fs,
        cwd: this.cwd,
        args: [programName, ...args],
        env: { ...this.env },
        stdin: ctx.stdin || '',
        onStdout: (text: string) => { ctx.stdout += text; },
        onStderr: (text: string) => { ctx.stderr += text; },
        preopens: { '/': '/', '.': this.cwd },
      };

      return await this.execWasmModule(wasmModule, config);
    } catch (e: any) {
      const { WasiExit } = await loadWasiRuntime();
      if (e instanceof WasiExit) {
        return e.code;
      }
      writeStderr(`shiro: ${filePath}: ${e.message}\n`);
      return 1;
    }
  }

  /**
   * Execute content as a Node.js script using the 'node' command.
   */
  private async executeNodeScript(
    filePath: string,
    content: string,
    args: string[],
    ctx: CommandContext,
    writeStdout: (s: string) => void,
    writeStderr: (s: string) => void,
  ): Promise<number> {
    // Use the existing 'node' command with the script path
    const nodeCmd = this.commands.get('node');
    if (!nodeCmd) {
      writeStderr('shiro: node command not available\r\n');
      return 127;
    }

    const nodeCtx: CommandContext = {
      args: [filePath, ...args],
      fs: ctx.fs,
      cwd: ctx.cwd,
      env: ctx.env,
      stdin: ctx.stdin,
      stdout: '',
      stderr: '',
      shell: ctx.shell,
      terminal: ctx.terminal,
    };

    const exitCode = await nodeCmd.exec(nodeCtx);
    if (nodeCtx.stdout) writeStdout(nodeCtx.stdout.replace(/\n/g, '\r\n'));
    if (nodeCtx.stderr) writeStderr(nodeCtx.stderr.replace(/\n/g, '\r\n'));
    return exitCode;
  }

  /**
   * Execute content as a shell script.
   */
  async executeShellScript(
    content: string,
    args: string[],
    ctx: CommandContext,
    writeStdout: (s: string) => void,
    writeStderr: (s: string) => void,
  ): Promise<number> {
    // Set positional parameters
    const savedParams: Record<string, string | undefined> = {};
    for (let i = 0; i <= args.length; i++) {
      savedParams[String(i)] = this.env[String(i)];
    }
    savedParams['#'] = this.env['#'];
    savedParams['@'] = this.env['@'];

    for (let i = 0; i < args.length; i++) {
      this.env[String(i + 1)] = args[i];
    }
    this.env['#'] = String(args.length);
    this.env['@'] = args.join(' ');

    // Execute script with multi-line compound statement accumulation
    const lines = content.split('\n');
    let exitCode = 0;
    let buffer = '';
    let depth = 0; // track nesting: for/while/until/if/case increment, done/fi/esac decrement

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Count opening/closing keywords (quote-aware)
      const keywords = this.shellTokenScan(trimmed);
      for (const kw of keywords) {
        if (['for', 'while', 'until', 'select', 'if', 'case'].includes(kw.word)) depth++;
        if (['done', 'fi', 'esac'].includes(kw.word)) depth--;
      }

      if (buffer) {
        buffer += '; ' + trimmed;
      } else {
        buffer = trimmed;
      }

      // If depth is 0, we have a complete statement — execute it
      if (depth <= 0) {
        depth = 0;
        exitCode = await this.execute(buffer, writeStdout, writeStderr, false, ctx.terminal, true);
        buffer = '';
      }
    }

    // Execute any remaining buffer
    if (buffer.trim()) {
      exitCode = await this.execute(buffer, writeStdout, writeStderr, false, ctx.terminal, true);
    }

    // Fire EXIT trap at end of script
    if (this.traps.has('EXIT')) {
      const exitCmd = this.traps.get('EXIT')!;
      this.traps.delete('EXIT'); // prevent re-entry
      await this.execute(exitCmd, writeStdout, writeStderr, false, ctx.terminal, true);
    }

    // Restore positional parameters
    for (const key of Object.keys(savedParams)) {
      if (savedParams[key] === undefined) {
        delete this.env[key];
      } else {
        this.env[key] = savedParams[key]!;
      }
    }

    return exitCode;
  }

  /** Format a completion spec for `complete -p` output */
  private formatCompleteSpec(cmd: string, spec: CompletionSpec): string {
    let parts = ['complete'];
    for (const option of spec.options ?? []) parts.push(`-o ${option}`);
    if (spec.words) parts.push(`-W '${spec.words.join(' ')}'`);
    if (spec.funcName) parts.push(`-F ${spec.funcName}`);
    if (spec.action) parts.push(`-A ${spec.action}`);
    if (spec.prefix) parts.push(`-P '${spec.prefix}'`);
    if (spec.suffix) parts.push(`-S '${spec.suffix}'`);
    parts.push(cmd);
    return parts.join(' ');
  }

  /** Resolve fc history reference: number (1-based abs or negative relative) or string prefix */
  private fcResolveRef(ref: string, hist: string[]): number {
    const num = parseInt(ref, 10);
    if (!isNaN(num)) {
      return num > 0 ? num - 1 : num; // 1-based → 0-based for positive; negative stays as-is
    }
    // String prefix search — find most recent matching entry
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].startsWith(ref)) return i;
    }
    return hist.length - 1;
  }
}

/**
 * Removes shell comments: a `#` that starts a word, outside quotes, to the end of its line. Not a
 * `#` inside a word (a#b, $#, ${#x}, *#*), in quotes, after a backslash, or in a heredoc body,
 * which is data. Lines and their order stay, so line numbers in messages do too.
 */
export function stripComments(src: string): string {
  if (!src.includes('#')) return src;
  let out = '';
  let i = 0;
  const n = src.length;
  let quote: '' | "'" | '"' | '`' = '';
  const heredocs: { tag: string; dash: boolean }[] = [];
  while (i < n) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === '\\' && quote !== "'" && i + 1 < n) { out += src[i + 1]; i += 2; continue; }
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < n) { out += c + src[i + 1]; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/.exec(src.slice(i));
      if (m) { heredocs.push({ tag: m[3], dash: m[1] === '-' }); out += m[0]; i += m[0].length; continue; }
    }
    if (c === '#') {
      const prev = i === 0 ? '\n' : src[i - 1];
      if (/[\s;&|()<>]/.test(prev)) {   // starts a word: a comment to the end of the line
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
    }
    out += c;
    i++;
    if (c === '\n' && heredocs.length) {
      // Heredoc bodies follow the line that opened them, verbatim up to each terminator.
      for (const h of heredocs.splice(0)) {
        while (i < n) {
          const end = src.indexOf('\n', i);
          const lineText = src.slice(i, end < 0 ? n : end);
          out += lineText + (end < 0 ? '' : '\n');
          i = end < 0 ? n : end + 1;
          if ((h.dash ? lineText.replace(/^\t+/, '') : lineText) === h.tag) break;
        }
      }
    }
  }
  return out;
}
