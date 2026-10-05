
import type { Command } from './index';
export const clear: Command = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec(ctx) {
    let terminal = ctx.env.TERM, scrollback = true;
    for (let index = 0; index < ctx.args.length; index++) {
      const arg = ctx.args[index];
      if (arg === '-x') scrollback = false;
      else if (arg === '-T') terminal = ctx.args[++index];
      else if (arg.startsWith('-T')) terminal = arg.slice(2);
      else if (arg !== '--') {
        ctx.stderr += `clear: unsupported option '${arg}'\n`;
        return 1;
      }
    }
    if (!terminal) { ctx.stderr += 'TERM environment variable not set.\n'; return 1; }
    // The browser terminal and these explicit compatibility profiles have
    // controlled clear/E3 capabilities; no host terminfo database is implied.
    const capabilities:Record<string,{screen:string;scrollback:boolean}> = {
      xterm:{screen:'\x1b[H\x1b[2J',scrollback:true},
      'xterm-256color':{screen:'\x1b[H\x1b[2J',scrollback:true},
      screen:{screen:'\x1b[H\x1b[J',scrollback:false},
      'screen-256color':{screen:'\x1b[H\x1b[J',scrollback:false},
      linux:{screen:'\x1b[H\x1b[J',scrollback:true},
      vt100:{screen:'\x1b[H\x1b[J',scrollback:false},
      dumb:{screen:'',scrollback:false},
    };
    const profile = Object.hasOwn(capabilities,terminal) ? capabilities[terminal] : undefined;
    if (!profile) { ctx.stderr += `'${terminal}': unknown terminal type.\n`; return 1; }
    if (!profile.screen) return 1;
    ctx.stdout += profile.screen + (scrollback && profile.scrollback ? '\x1b[3J' : '');
    return 0;
  },
};
