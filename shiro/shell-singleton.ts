/**
 * shell-singleton.ts — Lazy-initialized Shell backed by FreeGent workspace
 *
 * Provides a single Shell instance per page load. The shell is initialized on
 * first use (lazy) so WASM packages are not fetched until actually needed.
 *
 * Usage:
 *   import { getShell } from './shiro/shell-singleton';
 *   const shell = await getShell();
 *   const result = await shell.execute('ls /workspace');
 */

import { Shell } from './shell';
import { CommandRegistry } from './commands/index';
import { unixCommands } from './commands/unix';
import { shellBuiltins } from './commands/shell-builtins';
import { shiroCmds } from './commands/shiro-cmds';
import { grepCmd } from './commands/grep';
import { sedCmd } from './commands/sed';
import { globCmd } from './commands/glob';
import { jsEvalCmd } from './commands/jseval';
import { nodeCmd } from './commands/jseval/node-cmd';
import { pythonCmd, python3Cmd, pipCmd, pip3Cmd } from './commands/python';
import { curlCmd, wgetCmd } from './commands/curl';
import { npmCmd } from './commands/npm';
import { npxCmd } from './commands/npx';
import { diffCmd } from './commands/diff';
import { jqCmd } from './commands/jq';
import { rgCmd } from './commands/rg';
import { gzipCmd, gunzipCmd } from './commands/gzip';
import { mkTempCmd } from './commands/mktemp';
import { FWFileSystem, WORKSPACE_MOUNT } from './fg-filesystem';

let _shell: Shell | null = null;
let _initPromise: Promise<Shell> | null = null;

async function createShell(): Promise<Shell> {
    // Build command registry
    const commands = new CommandRegistry();
    commands.registerAll(unixCommands);
    commands.registerAll(shellBuiltins);
    commands.registerAll(shiroCmds);
    // Individual commands registered with priority (override builtins)
    commands.registerAll([grepCmd, sedCmd, globCmd, jsEvalCmd, nodeCmd, pythonCmd, python3Cmd, pipCmd, pip3Cmd, curlCmd, wgetCmd]);
    // Shiro commands the agent expects on a shell. Not registered: vi, tput, stty (interactive
    // terminal only) and pgrep/pkill (shiro's process table isn't used here).
    commands.registerAll([npmCmd, npxCmd, diffCmd, jqCmd, rgCmd, gzipCmd, gunzipCmd, mkTempCmd]);

    // Create FreeGent-backed filesystem
    const fs = new FWFileSystem();
    await fs.init();

    // Create shell; set CWD to workspace root
    const shell = new Shell(fs, commands);
    shell.cwd = WORKSPACE_MOUNT;
    // Sync env['PWD'] so the shell doesn't revert cwd to '/home/user'
    // after the first command (shell.ts line: this.cwd = this.env['PWD'] || this.cwd)
    shell.env['PWD'] = WORKSPACE_MOUNT;

    return shell;
}

/**
 * Get the singleton Shell, initializing it on first call.
 * Subsequent calls return the cached instance immediately.
 */
export async function getShell(): Promise<Shell> {
    if (_shell) return _shell;
    if (_initPromise) return _initPromise;

    _initPromise = createShell().then(s => {
        _shell = s;
        _initPromise = null;
        return s;
    });
    return _initPromise;
}

/**
 * A new shell on the singleton's filesystem and commands, starting in /workspace — for a run
 * that should start fresh, like a new bash process: no variables, functions, aliases, options or
 * traps from earlier runs. Files (the workspace, /tmp, folders made with mkdir) are shared.
 */
export async function newShell(): Promise<Shell> {
    const base = await getShell();
    const shell = new Shell(base.fs, base.commands);
    shell.cwd = WORKSPACE_MOUNT;
    shell.env['PWD'] = WORKSPACE_MOUNT;
    return shell;
}

/**
 * Reset the singleton (e.g. after a workspace switch).
 * The next call to getShell() creates a fresh instance.
 */
export function resetShell(): void {
    _shell = null;
    _initPromise = null;
}
