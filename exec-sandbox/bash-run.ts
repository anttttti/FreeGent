// exec-sandbox/bash-run.ts — execute_code in bash: one call on the WASM shell (shiro).
//
// Every call starts fresh, as a new bash process does headless (native-exec.ts): in /workspace,
// with no variables, functions, aliases or options from earlier calls. A `cd` or `export` in one
// call deciding what the next did was a difference between the backends (after `cd /tmp`, later
// relative writes landed outside the workspace and never synced). Files persist: the workspace,
// /tmp and folders made with mkdir. Each call has its own shell, so parallel workers' calls
// don't disturb each other.
import { newShell } from '../shiro/shell-singleton';
import { toDisplayText } from '../shiro/utils/bytes';

export async function runBash(code: string, onProgress?: (message: string) => void): Promise<{ stdout: string; stderr: string; exit_code: number }> {
    const shell = await newShell();
    shell.onProgress = onProgress;
    // shell.exec already returns plain text (\n, not the terminal's \r\n): a \r left in it is the
    // data's own (CRLF files). Bytes that aren't UTF-8 show as U+FFFD.
    const { stdout, stderr, exitCode } = await shell.exec(code);
    return { stdout: toDisplayText(stdout), stderr: toDisplayText(stderr), exit_code: exitCode ?? 0 };
}
