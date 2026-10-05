/** Shared symbolic permission operations for chmod, mkdir and umask. */
export function applySymbolicMode(spec:string,current:number,options:{directory?:boolean;umask?:number}={}):number|null {
  let mode = current;
  for (const clause of spec.split(',')) {
    const match = /^([ugoa]*)([+=-])([rwxXst]*)$/.exec(clause);
    if (!match) return null;
    const [,who,op,perms] = match;
    const targets = !who || who.includes('a') ? 'ugo' : who;
    let mask = 0, requested = 0;
    const bits = (perms.includes('r')?4:0) | (perms.includes('w')?2:0) |
      (perms.includes('x') || (perms.includes('X') && (options.directory || (mode & 0o111))) ? 1:0);
    for (const target of new Set(targets)) {
      const shift = target === 'u' ? 6 : target === 'g' ? 3 : 0;
      mask |= 7 << shift;
      requested |= bits << shift;
      if (perms.includes('s') && target !== 'o') requested |= target === 'u' ? 0o4000 : 0o2000;
      if (perms.includes('t')) requested |= 0o1000;
    }
    if (!who) { mask &= ~(options.umask ?? 0); requested &= ~(options.umask ?? 0); }
    if (op === '=') mode = (mode & ~mask) | requested;
    else if (op === '+') mode |= requested;
    else mode &= ~requested;
  }
  return mode;
}
