// EventEmitter in the browser shell against Node's (W004): a one-shot listener runs once per registration even when an earlier listener emits again.
import { describe, it, expect } from 'vitest';
import { EventEmitter as NodeEmitter } from 'node:events';
import { createEventsModule } from '../shiro/node-compat/modules/events';

const Shim: any = createEventsModule();
const trace = (E: any, build: (e: any, log: string[]) => void) => { const log: string[] = []; const e = new E(); build(e, log); return log; };
const scenarios: Record<string, (e: any, log: string[]) => void> = {
    'two listeners, the first re-emits': (e, log) => { let again = true; e.once('x', () => { log.push('A'); if (again) { again = false; e.emit('x'); } }); e.once('x', () => log.push('B')); e.emit('x'); },
    'three-listener chain': (e, log) => { let n = 0; e.once('x', () => { log.push('A'); if (!n++) e.emit('x'); }); e.once('x', () => { log.push('B'); if (n++ === 1) e.emit('x'); }); e.once('x', () => log.push('C')); e.emit('x'); },
    'the same function registered twice': (e, log) => { const f = () => log.push('f'); let go = true; e.on('x', () => { if (go) { go = false; e.emit('x'); } }); e.once('x', f); e.once('x', f); e.emit('x'); },
    'a persistent listener recursing': (e, log) => { let n = 0; e.on('x', () => { log.push('p'); if (n++ < 2) e.emit('x'); }); e.emit('x'); },
    'removed by its own function': (e, log) => { const f = () => log.push('f'); e.once('x', f); e.off('x', f); e.emit('x'); },
};
describe('EventEmitter.once', () => {
    for (const [name, build] of Object.entries(scenarios)) it(name, () => expect(trace(Shim.EventEmitter, build)).toEqual(trace(NodeEmitter, build)));
});
