import { concatBytes } from './bytes';

/** Consume and write concurrently: large transforms otherwise deadlock on backpressure. */
// What a decompression may produce. A small archive can expand without end, and every decoded chunk was kept until the end (codex R287).
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
export async function transformBytes(
  stream:{readable:ReadableStream<Uint8Array>;writable:WritableStream<Uint8Array>},
  data:Uint8Array,
  max = Infinity,
):Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writing = writer.write(data).then(() => writer.close());
  // The reader can fail first; observe the producer's rejection immediately as well.
  writing.catch(() => {});
  const chunks:Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error(`the data expands to more than ${Math.round(max / 1024 / 1024)} MB`);
      chunks.push(value);
    }
    await writing;
    return concatBytes(chunks);
  } catch (error) {
    await Promise.allSettled([reader.cancel(error),writer.abort(error)]);
    throw error;
  } finally {
    reader.releaseLock(); writer.releaseLock();
  }
}
