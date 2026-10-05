/** Serialize access to a stateful interpreter, including staging and cleanup. */
const runs = new WeakMap<object,Promise<void>>();

export async function withRuntimeLock<T>(runtime:object, run:()=>Promise<T>): Promise<T> {
  const preceding = runs.get(runtime);
  let release:()=>void;
  const pending = new Promise<void>(resolve => {release = resolve;});
  runs.set(runtime,pending);
  await preceding;
  try {return await run();}
  finally {release!(); if (runs.get(runtime) === pending) runs.delete(runtime);}
}
