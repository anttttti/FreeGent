// Boot the full headless import chain (no agent run) and verify the module-visibility
// fix: the helpers workers.js needs must now be reachable via globalThis.
process.env.WORKSPACE_ROOT = '/tmp/fg-probe-ws';
import(new URL('../headless-runner.ts', import.meta.url).href).then(mod => {
    const need = ['_runToolCalls', '_updateStuckDetector', '_normPath',
                  'truncateResultForHistory', 'callOAI', 'repairOAIHistory',
                  'convoLogTurn', 'runTurn', 'agentSend', 'loadSkills', 'validateOutput'];
    const missing = need.filter(n => typeof globalThis[n] !== 'function' && typeof globalThis.window?.[n] !== 'function');
    console.log('run() exported:', typeof mod.run === 'function');
    console.log('globalThis visibility:', missing.length === 0 ? 'ALL PRESENT' : 'MISSING: ' + missing.join(', '));
    const gt = need.filter(n => typeof globalThis[n] === 'function');
    console.log(`directly on globalThis: ${gt.length}/${need.length}`);
    process.exit(missing.length ? 1 : 0);
}).catch(e => { console.error('BOOT FAILED:', e.message); process.exit(2); });
