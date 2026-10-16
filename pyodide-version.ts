// One Pyodide release for the sandbox worker and the Python runner page. 0.27.x cannot start in a browser whose
// locale is Arabic (ar, ar-SA): "Fatal Python error: init_fs_encoding" and no Python at all; 0.28 does.
export const PYODIDE_VERSION = '0.28.3';
export const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
