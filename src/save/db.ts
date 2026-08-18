/**
 * Thin IndexedDB wrapper: one database, one store, keyed records.
 *
 * IndexedDB is the only browser store with room for a save of this shape, but
 * its API is event-based and easy to get subtly wrong, so every call is wrapped
 * into a promise here and nowhere else. Every operation degrades to a no-op
 * when there is no IndexedDB — under Vitest, or in a private window that denies
 * storage — so a missing database can never take the game down with it.
 */
const DB_NAME = 'wasteland-web';
const DB_VERSION = 1;
const STORE = 'state';

let handle: Promise<IDBDatabase | null> | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // A blocked or denied database is not fatal: the run simply does not persist.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function database(): Promise<IDBDatabase | null> {
  handle ??= openDatabase();
  return handle;
}

export async function readRecord<T>(key: string): Promise<T | null> {
  const db = await database();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve((request.result as T) ?? null);
    request.onerror = () => resolve(null);
  });
}

export async function writeRecord(key: string, value: unknown): Promise<boolean> {
  const db = await database();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    // Structured-clone chokes on anything with a prototype or a function, so
    // callers hand in plain data; round-tripping through JSON guarantees it.
    tx.objectStore(STORE).put(JSON.parse(JSON.stringify(value)), key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

export async function deleteRecord(key: string): Promise<void> {
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function isPersistenceAvailable(): boolean {
  return hasIndexedDb();
}
