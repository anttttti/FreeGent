
import type { Command } from './index';
import { parseArgs } from './flags';
export const xargs: Command = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(ctx) {
    // -0 / --null: parseArgs doesn't take digit flags, so pick it out first.
    const nullFlag = ctx.args.some(a => a === '-0' || a === '--null');
    const args = ctx.args.filter(a => a !== '-0' && a !== '--null');
    const { flags, positional, values } = parseArgs(args, ["n", "I", "i", "d", "delimiter"]);
    const onePerLine = flags.I || flags.L || flags.l;
    const replaceStr = values.I || values.i; // -I{} or -i
    const maxArgs = values.n ? parseInt(values.n) : undefined;
    const nullDelim = nullFlag;
    const delimiter = nullDelim ? '\0' : (values.d || values.delimiter || /\s+/);
    const verbose = flags.t || flags.verbose;
    const noRunIfEmpty = flags.r;

    // Arguments are re-quoted so words with spaces stay single arguments when run.
    const cmdTemplate = positional.length > 0 ? positional : ["echo"];
    const command = cmdTemplate.map(escapeArg).join(" ");

    // Parse input items — when -I is used, split on newlines (POSIX behavior)
    let inputItems: string[];
    const effectiveDelimiter = replaceStr ? '\n' : delimiter;
    if (typeof effectiveDelimiter === "string") {
      inputItems = ctx.stdin.split(effectiveDelimiter).filter(Boolean);
    } else {
      inputItems = ctx.stdin.trim().split(effectiveDelimiter).filter(Boolean);
    }

    if (inputItems.length === 0) {
      // GNU xargs runs the command once without arguments (an empty `xargs md5sum` hashes empty
      // input); -r and -I don't.
      if (noRunIfEmpty || replaceStr || !ctx.shell) return 0;
      let out = "", err = "";
      const exitCode = await ctx.shell.execute(`${command} < /dev/null`, (t: string) => { out += t; }, (t: string) => { err += t; });
      ctx.stdout += out.replace(/\r\n/g, "\n");
      ctx.stderr += err.replace(/\r\n/g, "\n");
      return exitCode === 0 ? 0 : 123;
    }

    // Runs one command line; shell.execute writes terminal output (\r\n), turned back into \n.
    const run = async (cmd: string) => {
      let out = "", err = "";
      const exitCode = await ctx.shell.execute(cmd, (t: string) => { out += t; }, (t: string) => { err += t; });
      return { stdout: out.replace(/\r\n/g, "\n"), stderr: err.replace(/\r\n/g, "\n"), exitCode };
    };

    // If we have an exec function (provided by the host shell), use it to actually run commands
    if (ctx.shell) {
      let stdout = "";
      let stderr = "";
      let lastExit = 0;

      // Handle -I (replace string) mode
      if (replaceStr) {
        const placeholder = typeof replaceStr === "string" ? replaceStr : "{}";
        for (const item of inputItems) {
          // The item replaces the placeholder inside each argument, which stays one argument.
          const cmd = cmdTemplate.map(a => escapeArg(a.split(placeholder).join(item))).join(" ");
          if (verbose) stdout += `+ ${cmd}\n`;
          const result = await run(cmd);
          if (result.stdout) stdout += result.stdout;
          if (result.stderr) stderr += result.stderr;
          lastExit = result.exitCode;
        }
      }
      // Handle -n (max args per command) mode
      else if (maxArgs) {
        for (let i = 0; i < inputItems.length; i += maxArgs) {
          const batch = inputItems.slice(i, i + maxArgs);
          const cmd = `${command} ${batch.map(escapeArg).join(" ")}`;
          if (verbose) stdout += `+ ${cmd}\n`;
          const result = await run(cmd);
          if (result.stdout) stdout += result.stdout;
          if (result.stderr) stderr += result.stderr;
          lastExit = result.exitCode;
        }
      }
      // Handle one-per-line mode
      else if (onePerLine) {
        for (const item of inputItems) {
          const cmd = `${command} ${escapeArg(item)}`;
          if (verbose) stdout += `+ ${cmd}\n`;
          const result = await run(cmd);
          if (result.stdout) stdout += result.stdout;
          if (result.stderr) stderr += result.stderr;
          lastExit = result.exitCode;
        }
      }
      // Default: all items in one command
      else {
        const cmd = command === "echo"
          ? `echo ${inputItems.map(escapeArg).join(" ")}`
          : `${command} ${inputItems.map(escapeArg).join(" ")}`;
        if (verbose) stdout += `+ ${cmd}\n`;
        const result = await run(cmd);
        if (result.stdout) stdout += result.stdout;
        if (result.stderr) stderr += result.stderr;
        lastExit = result.exitCode;
      }

      ctx.stdout += stdout;
      ctx.stderr += stderr;
      return lastExit;
    }

    // Fallback: no exec function available, output constructed command lines
    const outputs: string[] = [];
    const commands: string[] = [];

    // Handle -I (replace string) mode
    if (replaceStr) {
      const placeholder = typeof replaceStr === "string" ? replaceStr : "{}";
      for (const item of inputItems) {
        const cmd = command.replace(new RegExp(escapeRegex(placeholder), "g"), item);
        commands.push(cmd);
        if (verbose) {
          outputs.push(`+ ${cmd}`);
        }
      }
    }
    // Handle -n (max args per command) mode
    else if (maxArgs) {
      for (let i = 0; i < inputItems.length; i += maxArgs) {
        const batch = inputItems.slice(i, i + maxArgs);
        const cmd = `${command} ${batch.map(escapeArg).join(" ")}`;
        commands.push(cmd);
        if (verbose) {
          outputs.push(`+ ${cmd}`);
        }
      }
    }
    // Handle one-per-line mode
    else if (onePerLine) {
      for (const item of inputItems) {
        const cmd = `${command} ${escapeArg(item)}`;
        commands.push(cmd);
        if (verbose) {
          outputs.push(`+ ${cmd}`);
        }
      }
    }
    // Default: all items in one command
    else {
      const cmd = command === "echo"
        ? inputItems.join(" ")
        : `${command} ${inputItems.map(escapeArg).join(" ")}`;
      commands.push(cmd);
      if (verbose) {
        outputs.push(`+ ${cmd}`);
      }
    }

    // Output constructed command lines for execution
    if (command === "echo" && !replaceStr && !maxArgs && !onePerLine) {
      // Special case: echo just outputs the items
      outputs.push(...inputItems);
    } else {
      outputs.push(...commands);
    }

    ctx.stdout += outputs.join("\n") + (outputs.length > 0 ? "\n" : "");
    return 0;
  },
};

function escapeArg(s: string): string {
  if (/[^a-zA-Z0-9._\-/=]/.test(s)) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  return s;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
