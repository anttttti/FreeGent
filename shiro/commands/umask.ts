import type { Command } from './index';
import { parseArgs } from './flags';
import { applySymbolicMode } from '../utils/permissions';

export interface UmaskResult { mask:number; stdout:string; stderr:string; status:number }

export function processUmask(current:number, args:string[]):UmaskResult {
  const {flags,positional} = parseArgs(args);
  const value = current.toString(8).padStart(4,'0');
  if (!positional.length) {
    if (flags.S) return {mask:current,stdout:(flags.p ? 'umask -S ' : '')+maskToSymbolic(current)+'\n',stderr:'',status:0};
    return {mask:current,stdout:(flags.p ? `umask ${value}` : value)+'\n',stderr:'',status:0};
  }
  const raw = positional[0];
  if (/^[0-7]+$/.test(raw) && parseInt(raw,8) <= 0o7777) return {mask:parseInt(raw,8),stdout:flags.S?maskToSymbolic(parseInt(raw,8))+'\n':'',stderr:'',status:0};
  if (/^[ugoa]*[+-=][rwx]*(,[ugoa]*[+-=][rwx]*)*$/.test(raw)) {
    const allowed = applySymbolicMode(raw,0o777 & ~current);
    const symbolic = allowed === null ? null : 0o777 & ~allowed;
    if (symbolic !== null) return {mask:symbolic,stdout:flags.S?maskToSymbolic(symbolic)+'\n':'',stderr:'',status:0};
  }
  return {mask:current,stdout:'',stderr:`umask: ${raw}: invalid symbolic mode\n`,status:1};
}

export const umask:Command = {
  name:'umask', description:'Set or display file creation mask',
  async exec(ctx) {
    const result = processUmask(ctx.shell.umask,ctx.args);
    ctx.shell.umask = result.mask;
    ctx.stdout += result.stdout;
    ctx.stderr += result.stderr;
    return result.status;
  },
};

function maskToSymbolic(mask:number):string {
  const permissions = 0o777 & ~mask;
  const part = (value:number) => (value&4?'r':'')+(value&2?'w':'')+(value&1?'x':'');
  return `u=${part((permissions>>6)&7)},g=${part((permissions>>3)&7)},o=${part(permissions&7)}`;
}
