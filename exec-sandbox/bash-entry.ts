// This trusted bundle is loaded only in engines with BigInt/WASM/Worker support.
// It remains inside the opaque execution frame and uses its existing RPC channel.
import { runBash } from './bash-run';
import { packageCacheCall } from './channel';
import { setPackageCacheTransport } from '../shiro/wasi-packages';
setPackageCacheTransport(packageCacheCall);
(globalThis as any).__fgRunBash = runBash;
