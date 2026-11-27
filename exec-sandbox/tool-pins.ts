// exec-sandbox/tool-pins.ts — the pinned programs of tools.ts: CDN files with the SHA-256 and length each must have. Data only (privacy.ts derives
// the directories the Local privacy level lets the sandbox reach from it). Add a file by downloading that exact version and hashing it.

export interface ToolFile { url: string; sha256: string; length: number }
export interface ToolEntry { version: string; license: string; files: Record<string, ToolFile> }

const J = 'https://cdn.jsdelivr.net/npm/';   // (the DuckDB extensions are the one exception: extensions.duckdb.org)
const f = (path: string, sha256: string, length: number): ToolFile => ({ url: J + path, sha256, length });

export const TOOLS: Record<string, ToolEntry> = {
  'pdf-lib': { version: '1.17.1', license: 'MIT', files: {
    js: f('pdf-lib@1.17.1/dist/pdf-lib.min.js', '0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f', 525099) } },
  'sql.js': { version: '1.13.0', license: 'MIT', files: {
    js: f('sql.js@1.13.0/dist/sql-wasm.js', '694ca5b36aa3e6e71f417819d7df390b65343665fcfa5c69015ca33d93d291b3', 48788),
    wasm: f('sql.js@1.13.0/dist/sql-wasm.wasm', '0734155c83e493983d1f2ff5b09a4fab6e35a32e9449c7e4e545756439f62d73', 659806) } },
  mammoth: { version: '1.13.0', license: 'BSD-2-Clause', files: {
    js: f('mammoth@1.13.0/mammoth.browser.min.js', '92914a3708cfdf1e62cb553d1856a7fedab21da83d8ee82845de2f897b368cab', 405060) } },
  xlsx: { version: '0.18.5', license: 'Apache-2.0', files: {
    js: f('xlsx@0.18.5/dist/xlsx.full.min.js', 'c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99', 881727) } },
  jszip: { version: '3.10.1', license: 'MIT or GPL-3.0', files: {
    js: f('jszip@3.10.1/dist/jszip.min.js', 'acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e', 97630) } },
  duckdb: { version: '1.29.0', license: 'MIT (Apache-2.0 for Arrow)', files: {
    js: f('@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser-blocking.cjs', '3f91980f03d76a22f3e8748791063049dd584a1ba0089b201388a4330f81a501', 1140148),
    arrow: f('apache-arrow@17.0.0/Arrow.es2015.min.js', '375fb7c891e25677c021e585d4ec51a5752112b182f41d51071b8401e590379e', 172843),
    wasm: f('@duckdb/duckdb-wasm@1.29.0/dist/duckdb-eh.wasm', '00d45e5e074b7f7e17e45daabacb0fb67248eac8bd638a72cd1b42dad23788e4', 35659694),
    // The extensions DuckDB would download by itself, unverified, when a query needs them. Engine v1.1.1 (duckdb-wasm 1.29.0), the "eh" build.
    parquet: { url: 'https://extensions.duckdb.org/v1.1.1/wasm_eh/parquet.duckdb_extension.wasm', sha256: 'e24fb2953c6a80e32d17fa3921f90f1f05ccbfa40f382e77702c1e6af9b79479', length: 2803379 },
    json: { url: 'https://extensions.duckdb.org/v1.1.1/wasm_eh/json.duckdb_extension.wasm', sha256: '84958e8b52814ff0035dfcb208dbac80d99d30e582c668090879d3b814c571e4', length: 696809 } } },
  tesseract: { version: '5.1.1', license: 'Apache-2.0', files: {
    js: f('tesseract.js@5.1.1/dist/tesseract.min.js', 'a8e29918d098b2b06e1012bdaeffb4aec0445c5d5654709023e0bd1f442a80e8', 66695),
    worker: f('tesseract.js@5.1.1/dist/worker.min.js', 'aca1229639fc9907d86f96e825955a2b7c5716d17f3bc3acd71f9c7ab66181fc', 123724),
    core: f('tesseract.js-core@5.1.0/tesseract-core-simd-lstm.wasm.js', '18797eef96bab787636c40b53efaa445cf5ca1c97abd735c4fd8dc3d03652959', 3938656),
    eng: f('@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz', '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91', 2952873) } },
  ffmpeg: { version: '0.12.10', license: 'GPL-2.0-or-later', files: {
    js: f('@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js', 'b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21', 112059),
    wasm: f('@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm', '9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7', 32232419) } },
};


/** The directory of every pinned file: a CSP path source matches a directory only when it ends in "/", so each file's own directory is allowed, not the host. */
export const TOOL_CDN_DIRS: string[] = [...new Set(Object.values(TOOLS).flatMap(t => Object.values(t.files).map(f => f.url.slice(0, f.url.lastIndexOf('/') + 1))))];
