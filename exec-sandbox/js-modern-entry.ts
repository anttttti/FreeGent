// node-inspect-extracted needs newer RegExp features; isolate it from legacy boot.
import * as inspect from 'node-inspect-extracted';
import { runJs } from './js-run';
(globalThis as any).__fgModernInspect = inspect;
(globalThis as any).__fgRunJsModern = runJs;
