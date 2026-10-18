/** Small key-value helpers over an IndexedDB database whose stores are all out-of-line-key stores. */

export function openStoreDB(name: string, version: number, stores: string[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of stores) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
  });
}

/** Cache accessors over `open`. Reads fail soft (null / []); writes are best-effort (a miss next time). */
export function idbCache(open: () => Promise<IDBDatabase>) {
  async function get<T>(store: string, key: string): Promise<T | null> {
    try {
      const db = await open();
      return new Promise((resolve) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
        tx.oncomplete = () => db.close();
      });
    } catch {
      return null;
    }
  }

  async function write(store: string, run: (s: IDBObjectStore) => IDBRequest): Promise<void> {
    try {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const req = run(tx.objectStore(store));
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      });
    } catch {
      // Non-fatal
    }
  }

  const put = (store: string, key: string, value: any) => write(store, s => s.put(value, key));
  const del = (store: string, key: string) => write(store, s => s.delete(key));

  async function keys(store: string): Promise<string[]> {
    try {
      const db = await open();
      return new Promise((resolve) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAllKeys();
        req.onsuccess = () => resolve((req.result as string[]) || []);
        req.onerror = () => resolve([]);
        tx.oncomplete = () => db.close();
      });
    } catch {
      return [];
    }
  }

  return { get, put, delete: del, keys };
}
