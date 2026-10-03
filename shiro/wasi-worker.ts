// wasi-worker.ts — Worker entry for WASM programs. Bundled into one classic script by
// dev-api.ts buildExecSandbox() and started from a blob URL (see wasi-host.ts).
import { makeHandler, type HostMessage } from './wasi-worker-core';

declare const self: { onmessage: ((e: { data: any }) => void) | null; postMessage(m: unknown): void };

const handle = makeHandler(m => self.postMessage(m));
self.onmessage = (e: { data: HostMessage }) => handle(e.data);
