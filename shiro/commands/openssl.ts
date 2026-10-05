import type { Command } from './index';
import { runPackageCommand } from '../wasi-packages';

/** Reuse existing Shiro base64/digest owners for common OpenSSL CLI forms. */
export const openssl:Command = {
  name:'openssl',
  description:'Cryptographic toolkit; common base64 and digest commands use shared Shiro implementations',
  route:'adapter',
  async exec(ctx) {
    const [subcommand,...args] = ctx.args;
    if (subcommand === 'base64') {
      let decode = false, singleLine = false, input:string|undefined;
      for (let i=0;i<args.length;i++) {
        const arg=args[i];
        if (arg === '-d' || arg === '-D') decode=true;
        else if (arg === '-A') singleLine = true;
        else if (arg === '-e' || arg === '-a') continue;
        else if (arg === '-in' && args[i+1]) input=args[++i];
        else return runPackageCommand(ctx,'openssl',ctx.args);
      }
      const result=await ctx.shell.execArgv(['base64',...(!decode?['-w',singleLine?'0':'64']:[]),...(decode?['-d']:[]),...(input?[input]:[])],ctx.stdin,true);
      ctx.stdout += result.stdout;
      ctx.stderr += result.stderr;
      return result.exitCode;
    }
    if (subcommand === 'dgst' && args.length === 2 && args[0] === '-sha256') {
      const file=args[1];
      const result=await ctx.shell.execArgv(['sha256sum',file],ctx.stdin,true);
      if (result.exitCode !== 0) { ctx.stderr += result.stderr; return result.exitCode; }
      const match=result.stdout.match(/^([0-9a-f]+)  .*\n?$/);
      if (!match) { ctx.stderr += result.stderr; return 1; }
      ctx.stdout += `SHA2-256(${file === '-' ? 'stdin' : file})= ${match[1]}\n`;
      return 0;
    }
    return runPackageCommand(ctx,'openssl',ctx.args);
  },
};
