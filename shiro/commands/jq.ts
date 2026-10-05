import { packageCommand } from '../wasi-packages';
/** The pinned upstream CLI owns filtering, parsing, options and diagnostics. */
export const jqCmd = packageCommand('jq');
