import { concatBytes } from './bytes';

/** Consume and write concurrently: large transforms otherwise deadlock on backpressure. */
export async function transformBytes(
  stream:{readable:ReadableStream<Uint8Array>;writable:WritableStream<Uint8Array>},
  data:Uint8Array,
):Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writing = writer.write(data).then(() => writer.close());
  // The reader can fail first; observe the producer's rejection immediately as well.
  writing.catch(() => {});
  const chunks:Uint8Array[] = [];
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
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
