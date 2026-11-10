/**
 * Node.js script execution harness.
 * Orchestrates all node-compat modules and manages script lifecycle.
 * Extracted from node-cmd.ts exec() body.
 */

import type { CommandContext } from '../commands/index';
import { sha1sync, fnvHash } from '../commands/jseval/crypto';
import { sha256 as sha256sync } from '../commands/checksums';
import { ProcessExitError } from '../commands/jseval/utils';
import { inspect } from 'node-inspect-extracted';
import { transformESModules, transformTS, transformJSX } from '../commands/jseval/module-transform';
import type { SharedState } from './types';
import { createFakeBuffer } from './buffer';
import { createFakeConsole } from './console';
import { createFakeProcess } from './process';
import { createFileCache } from './file-cache';
import { preloadEnvironment } from './preload';
import { createAutoStubFactory } from './auto-stub';
import { createRequireFunction } from './require';
import { createSqliteShim } from './shims/sqlite';
import { createPathModule } from './modules/path';
import { createOsModule } from './modules/os';
import { createEventsModule } from './modules/events';
import { createUrlModule } from './modules/url';
import { createUtilModule } from './modules/util';
import { createFsModule, createFsPromisesModule } from './modules/fs';
import { createChildProcessModule } from './modules/child-process';
import { createStreamModule } from './modules/stream';
import { createCryptoModule } from './modules/crypto';
import { createHttpModule, createHttpsModule, createHttp2Module } from './modules/http';
import { createNetModule, createTlsModule } from './modules/net-tls';
import { createMiscModule } from './modules/misc';
import { createAppShim } from './shims/app-shims';


// `x.location = …` or a bare `location = …` (not ==, not a property of something else like obj.location).
export const _ASSIGNS_LOCATION_RE = /(?:\b(?:globalThis|window|self|global)\s*\.\s*|(?:^|[^.\w$]))location\s*=(?!=)/;
// The real global with `location` replaced by a per-run value. Methods without a prototype (setTimeout, fetch, atob …) are bound to the
// real global, because a Window method called on the proxy throws "Illegal invocation"; constructors stay the same objects.
function _scriptGlobals(): any[] {
  const real: any = globalThis;
  let loc: any = { ...(() => { try { const l = real.location; return { href: l.href, origin: l.origin, protocol: l.protocol, host: l.host, hostname: l.hostname, port: l.port, pathname: l.pathname, search: l.search, hash: l.hash }; } catch { return {}; } })(),
    reload() {}, assign() {}, replace() {}, toString() { return String(this.href ?? ''); } };
  const bound = new Map<any, any>();
  const view: any = new Proxy(real, {
    get(t, prop) {
      if (prop === 'location') return loc;
      if (prop === 'globalThis' || prop === 'window' || prop === 'self' || prop === 'global') return view;
      const v = Reflect.get(t, prop, t);
      if (typeof v !== 'function' || v.prototype !== undefined) return v;
      if (!bound.has(v)) bound.set(v, v.bind(t));
      return bound.get(v);
    },
    set(t, prop, value) {
      if (prop === 'location') { loc = value; return true; }
      return Reflect.set(t, prop, value, t);
    },
  });
  return [view, view, view, view, loc];
}

/**
 * Execute a Node.js script in Shiro's browser-based JS VM.
 * This is the main entry point that wires together all node-compat modules.
 */
export async function executeNodeScript(
  ctx: CommandContext,
  code: string,
  scriptPath: string,
  fileArgs: string[],
  printResult: boolean,
): Promise<number> {
  // Suppress unhandled rejections from CLI force-exit patterns
  let _nodeStderrBuf: string[] | null = null;
  const suppressRejection = (event: PromiseRejectionEvent) => {
    const msg = event.reason?.message || String(event.reason || '');
    if (event.reason?._isProcessExit || msg === 'unreachable' || msg.startsWith('Aborted(') || msg === 'need dylink section') {
      event.preventDefault();
    } else {
      const errStr = msg || 'Unknown error';
      _nodeStderrBuf?.push(`UnhandledPromiseRejection: ${errStr}`);
      event.preventDefault();
    }
  };

  // Save originals for CORS proxy interception. Requests in flight are counted: the script
  // isn't done while one is (see the deferred exit wait).
  const _rawFetch = globalThis.fetch;
  let _fetchesInFlight = 0;
  const _origFetch = ((...a: Parameters<typeof fetch>) => {
    _fetchesInFlight++;
    return _rawFetch(...a).finally(() => { _fetchesInFlight--; });
  }) as typeof fetch;
  const _prevST = globalThis.setTimeout;
  const _prevCT = globalThis.clearTimeout;

  // Shared mutable state
  const _st: SharedState = {
    exitCode: 0,
    exitCalled: false,
    scriptTimeoutId: null,
    deferredExitResolve: null,
    fakeProcess: null,
  };

  try {
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    _nodeStderrBuf = stderrBuf;
    const pendingPromises: Promise<any>[] = [];
    const processEvents: Record<string, Function[]> = {};

    // Deferred exit: resolves when process.exit is called from async code
    const deferredExitPromise = new Promise<number>((resolve) => { _st.deferredExitResolve = resolve; });

    // Console and process
    const fakeConsole = createFakeConsole(ctx, stdoutBuf, stderrBuf, _st);
    const fakeProcess = createFakeProcess(ctx, fileArgs, scriptPath, stdoutBuf, stderrBuf, _st, processEvents, pendingPromises);
    _st.fakeProcess = fakeProcess;

    // File cache, module cache, and sync watchdog
    const { fileCache, fileMtimes, moduleCache, tickSyncOps } = createFileCache();

    // Pre-load environment
    await preloadEnvironment(ctx, fileCache, fileMtimes, scriptPath);
    const homeDir = ctx.env['HOME'] || '/home/user';

    // Buffer shim
    const FakeBuffer = createFakeBuffer();

    // Built-in module registry with caching
    const _builtinCache = new Map<string, any>();
    function getBuiltinModule(name: string): any | null {
      const cacheKey = name.startsWith('node:') ? name.slice(5) : name;
      if (_builtinCache.has(cacheKey)) return _builtinCache.get(cacheKey);
      const mod = _getBuiltinModuleImpl(name);
      if (mod !== null) _builtinCache.set(cacheKey, mod);
      return mod;
    }
    function _getBuiltinModuleImpl(name: string): any | null {
      switch (name) {
        case 'path':
        case 'node:path': return createPathModule(ctx);
        case 'fs':
        case 'node:fs': return createFsModule({ ctx, fileCache, fileMtimes, pendingPromises, tickSyncOps, FakeBuffer, getBuiltinModule, homeDir });
        case 'fs/promises':
        case 'node:fs/promises': return createFsPromisesModule({ ctx, fileCache, fileMtimes, pendingPromises, tickSyncOps, FakeBuffer, getBuiltinModule, homeDir });
        case 'child_process':
        case 'node:child_process': return createChildProcessModule({ ctx, fileCache, fileMtimes, pendingPromises, FakeBuffer });
        case 'os':
        case 'node:os': return createOsModule(ctx);
        case 'util':
        case 'node:util': return createUtilModule();
        case 'events':
        case 'node:events': return createEventsModule();
        case 'url':
        case 'node:url': return createUrlModule();
        case 'stream':
        case 'node:stream': return createStreamModule();
        case 'stream/promises':
        case 'node:stream/promises': return createStreamModule().promises;
        case 'stream/consumers':
        case 'node:stream/consumers': return createStreamModule().consumers;
        case 'crypto':
        case 'node:crypto': return createCryptoModule({ sha256sync, sha1sync, fnvHash, FakeBuffer });
        case 'http':
        case 'node:http': return createHttpModule({ ctx, fakeConsole, getBuiltinModule });
        case 'https':
        case 'node:https': return createHttpsModule({ ctx, fakeConsole, getBuiltinModule });
        case 'net':
        case 'node:net': return createNetModule();
        case 'tls':
        case 'node:tls': return createTlsModule({ getBuiltinModule });
        case 'http2':
        case 'node:http2': return createHttp2Module();
        default: {
          const appShim = createAppShim(name, { ctx, fileCache, fakeProcess });
          if (appShim !== null) return appShim;
          return createMiscModule(name, { ctx, FakeBuffer, fakeProcess, fakeConsole, getBuiltinModule, fileCache, moduleCache, requireModule });
        }
      }
    }

    // Auto-stub factory
    const { createAutoStub } = createAutoStubFactory();

    // Express shim factory

    // Require function (module resolver + loader)
    const requireModule = createRequireFunction({
      ctx, fileCache, fileMtimes, moduleCache, pendingPromises, processEvents,
      getBuiltinModule, fakeConsole, fakeProcess, FakeBuffer,
      createSqliteShim: () => createSqliteShim({ ctx }),
      createAutoStub,
    });
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    // Transform TypeScript/JSX/ESM syntax for execution
    let transformedCode = code;
    if (scriptPath && (scriptPath.endsWith('.ts') || scriptPath.endsWith('.tsx'))) {
      transformedCode = transformTS(transformedCode);
    }
    if (scriptPath && (scriptPath.endsWith('.tsx') || scriptPath.endsWith('.jsx'))) {
      transformedCode = transformJSX(transformedCode);
    }
    transformedCode = transformESModules(transformedCode);

    // Stash real browser console on globalThis so injected code can use it
    if (code.length > 500000) {
      (globalThis as any).__realConsole = console;
    }

    const wrappedCode = printResult ? `return (${transformedCode})` : transformedCode;
    // A script that assigns `location` (a test stubbing `globalThis.location = { reload() {} }`) navigated the shell's own frame on a
    // real Window: the run never answered and every later `node` hung (autopilot exploration AE-11, 2026-10-28: the test-runner gate
    // waited 10 minutes per task). Such a script gets its own globalThis/window/self/global, a view of the real one whose `location`
    // is a per-run value. Other scripts run as before.
    const ownLocation = typeof window !== 'undefined' && _ASSIGNS_LOCATION_RE.test(transformedCode);
    const scopeNames = ownLocation ? ['globalThis', 'window', 'self', 'global', 'location'] : [];
    const fn = new AsyncFunction(
      'console', 'process', 'require', 'Buffer', '__filename', '__dirname', 'shiro', '__import_meta', 'module', 'exports', '__dynamic_import', ...scopeNames,
      wrappedCode
    );
    const scopeValues = ownLocation ? _scriptGlobals() : [];

    // Fake import.meta for ES modules
    const entryFilename = scriptPath || ctx.cwd + '/repl.js';
    const entryDirname = scriptPath ? scriptPath.substring(0, scriptPath.lastIndexOf('/')) : ctx.cwd;
    const fakeImportMeta = {
      url: `file://${entryFilename}`,
      dirname: entryDirname,
      filename: entryFilename,
      resolve: (specifier: string) => {
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          return `file://${ctx.fs.resolvePath(specifier, entryDirname)}`;
        }
        return specifier;
      },
    };

    // Create module/exports for CommonJS compatibility
    const fakeModule: { exports: any } = { exports: {} };
    const fakeExports = fakeModule.exports;

    // Create require function for the entry script
    const entryRequire = (moduleName: string) => requireModule(moduleName, entryDirname);

    // Dynamic import() shim
    const dynamicImport = async (moduleName: string) => {
      try {
        return requireModule(moduleName, entryDirname);
      } catch (e: any) {
        const msg = e?.message || String(e);
        throw new Error(`Failed to dynamically import '${moduleName}': ${msg}`);
      }
    };

    let result;

    if (typeof window !== 'undefined') {
      window.addEventListener('unhandledrejection', suppressRejection);
    }

    globalThis.fetch = _origFetch;

    // Polyfill setImmediate/clearImmediate
    const _origSetImmediate = (globalThis as any).setImmediate;
    const _origClearImmediate = (globalThis as any).clearImmediate;
    (globalThis as any).setImmediate = (fn: Function, ...args: any[]) => setTimeout(fn, 0, ...args);
    (globalThis as any).clearImmediate = (id: any) => clearTimeout(id);

    // Track active timers
    let _activeTimers = 0;
    let _timersResolve: (() => void) | null = null;
    let _timersDone: Promise<void> | null = null;
    const _timerIds = new Set<any>();
    if (code.length <= 500000) {
      globalThis.setTimeout = function(fn: any, ms?: number, ...args: any[]) {
        _activeTimers++;
        if (!_timersDone) _timersDone = new Promise(r => { _timersResolve = r; });
        const id = _prevST(() => {
          _timerIds.delete(id);
          // process.exit() in a timer ends the run through the exit state it set; thrown on, it was an uncaught error in the app's page
          // (kanbanflow set 3: `setTimeout(() => { …; process.exit(0); }, ms)` in a model's test, 2 of 5 runs of a 14-task board).
          try { if (typeof fn === 'function') fn(...args); }
          catch (e: any) { if (!e?._isProcessExit) throw e; }
          finally {
            _activeTimers--;
            if (_activeTimers <= 0 && _timersResolve) { _timersResolve(); _timersResolve = null; _timersDone = null; }
          }
        }, ms);
        _timerIds.add(id);
        return id;
      } as typeof setTimeout;
      globalThis.clearTimeout = function(id: any) {
        if (_timerIds.delete(id)) {
          _activeTimers--;
          if (_activeTimers <= 0 && _timersResolve) { _timersResolve(); _timersResolve = null; _timersDone = null; }
        }
        _prevCT(id);
      };
    }

    // Script execution timeout — scale up for large bundles (e.g. TypeScript ~5MB)
    const SCRIPT_TIMEOUT = code.length > 500_000 ? 60_000 : 15_000;
    let scriptTimedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      _st.scriptTimeoutId = setTimeout(() => {
        scriptTimedOut = true;
        reject(new ProcessExitError(124));
      }, SCRIPT_TIMEOUT);
    });

    try {
      result = await Promise.race([
        fn(fakeConsole, fakeProcess, entryRequire, FakeBuffer, entryFilename, entryDirname, {
          fs: ctx.fs,
          shell: ctx.shell,
          env: ctx.env,
          cwd: ctx.cwd,
        }, fakeImportMeta, fakeModule, fakeExports, dynamicImport, ...scopeValues),
        timeoutPromise,
      ]);
    } catch (e: any) {
      if (e instanceof ProcessExitError) {
        _st.exitCode = e.code;
      } else if (e.message?.includes('extends value') || e.message?.includes('is not a constructor') || e.message?.includes('prototype')) {
        stderrBuf.push(e.message + '\n');
        _st.exitCode = 1;
      } else if (e.name === 'ReferenceError' || e.name === 'TypeError' || e.name === 'SyntaxError') {
        stderrBuf.push((e.message || String(e)) + '\n');
        console.error('[node] Runtime error:', e);
        _st.exitCode = 1;
      } else {
        throw e;
      }
    }

    // Clean up script timeout
    if (_st.scriptTimeoutId) { clearTimeout(_st.scriptTimeoutId); _st.scriptTimeoutId = null; }

    // Wait for pending async operations
    while (pendingPromises.length > 0) {
      const current = [...pendingPromises];
      pendingPromises.length = 0;
      await Promise.all(current);
    }

    // Wait for pending timers (max 5s)
    if (_activeTimers > 0 && _timersDone) {
      try {
        await Promise.race([_timersDone, new Promise((_, rej) => _prevST(() => rej('timer-wait-timeout'), 5000))]);
      } catch { /* timeout is fine */ }
    }

    // Restore setTimeout/clearTimeout before deferred exit
    if (code.length <= 500000) { globalThis.setTimeout = _prevST; globalThis.clearTimeout = _prevCT; }

    // Deferred exit wait
    const hasFinishedOutput = _st.exitCalled || scriptTimedOut
      || stdoutBuf.length > 0 || stderrBuf.length > 0
      || printResult;
    if (!hasFinishedOutput) {
      const DEFERRED_TIMEOUT = code.length > 500000 ? 300000 : 10000;
      const deferredTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new ProcessExitError(124)), DEFERRED_TIMEOUT);
      });
      // A script with nothing left to run is done, as Node exits once its event loop is empty: no
      // requests in flight, timers or pending writes. (Waiting the full timeout made every silent
      // script take 10 s and exit with 124.)
      const idle = (async () => {
        for (let quiet = 0; quiet < 3;) {
          await new Promise(r => _prevST(r, 20));
          if (pendingPromises.length) await Promise.all(pendingPromises.splice(0));
          quiet = _fetchesInFlight === 0 && _activeTimers <= 0 ? quiet + 1 : 0;
        }
        return _st.exitCalled ? _st.exitCode : 0;
      })();
      try {
        const waitCode = await Promise.race([deferredExitPromise, deferredTimeout, idle]);
        _st.exitCode = waitCode;
      } catch (e: any) {
        if (e instanceof ProcessExitError) {
          _st.exitCode = e.code;
        }
      }
    }

    // Flush output
    // The buffers hold raw chunks (console lines end in their newline; process.stdout.write
    // chunks are as written).
    if (stdoutBuf.length > 0) {
      ctx.stdout += stdoutBuf.join('');
    }
    if (stderrBuf.length > 0) {
      ctx.stderr += stderrBuf.join('');
    }

    if (printResult && !_st.exitCalled) {
      ctx.stdout += (typeof result === 'string' ? result : inspect(result)) + '\n';
    }

    // Clean up
    if (typeof window !== 'undefined') {
      setTimeout(() => window.removeEventListener('unhandledrejection', suppressRejection), 1000);
    }
    globalThis.fetch = _rawFetch;
    if (code.length <= 500000) { globalThis.setTimeout = _prevST; globalThis.clearTimeout = _prevCT; }
    if (_origSetImmediate) (globalThis as any).setImmediate = _origSetImmediate; else delete (globalThis as any).setImmediate;
    if (_origClearImmediate) (globalThis as any).clearImmediate = _origClearImmediate; else delete (globalThis as any).clearImmediate;

    return _st.exitCode;
  } catch (e: any) {
    // Clean up on error
    if (typeof window !== 'undefined') {
      setTimeout(() => window.removeEventListener('unhandledrejection', suppressRejection), 1000);
    }
    globalThis.fetch = _rawFetch;
    if (code.length <= 500000) { globalThis.setTimeout = _prevST; globalThis.clearTimeout = _prevCT; }
    delete (globalThis as any).setImmediate;
    delete (globalThis as any).clearImmediate;
    const msg = e.message || String(e);
    console.error('[node] Script error:', e);
    ctx.stderr += `Error: ${msg}\n`;
    return 1;
  }
}
