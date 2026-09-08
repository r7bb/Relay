/// <reference lib="dom" />
// The DOM lib is referenced here rather than only in tsconfig: the IndexedDB
// types are needed by this file alone, and the directive survives however the
// compiler is invoked.

/**
 * Persistence boundary for the sync engine.
 *
 * The engine talks to this interface rather than to IndexedDB directly, for two
 * reasons. IndexedDB does not exist outside a browser, so the interesting
 * logic -- queue ordering, retry, conflict resolution -- would otherwise only
 * be testable through a headless browser. And the storage choice is genuinely
 * incidental: the same engine would work over OPFS or SQLite-wasm.
 */
export interface StorageAdapter {
  get<T>(store: string, key: string): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  put<T>(store: string, key: string, value: T): Promise<void>;
  delete(store: string, key: string): Promise<void>;
  clear(store: string): Promise<void>;
}

/** In-memory adapter. Used by the tests, and as the fallback in environments
 * with no IndexedDB (SSR, private-mode Safari quirks). */
export class MemoryAdapter implements StorageAdapter {
  private readonly stores = new Map<string, Map<string, unknown>>();

  private store(name: string): Map<string, unknown> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return store;
  }

  async get<T>(store: string, key: string): Promise<T | undefined> {
    return this.store(store).get(key) as T | undefined;
  }

  async getAll<T>(store: string): Promise<T[]> {
    return [...this.store(store).values()] as T[];
  }

  async put<T>(store: string, key: string, value: T): Promise<void> {
    this.store(store).set(key, value);
  }

  async delete(store: string, key: string): Promise<void> {
    this.store(store).delete(key);
  }

  async clear(store: string): Promise<void> {
    this.store(store).clear();
  }
}

export const STORE_ISSUES = 'issues';
export const STORE_QUEUE = 'queue';
export const STORE_META = 'meta';

const STORES = [STORE_ISSUES, STORE_QUEUE, STORE_META];

/** IndexedDB-backed adapter for the browser. */
export class IndexedDbAdapter implements StorageAdapter {
  private handle: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly name = 'relay',
    private readonly version = 1,
  ) {}

  private open(): Promise<IDBDatabase> {
    this.handle ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, this.version);

      request.onupgradeneeded = () => {
        for (const store of STORES) {
          if (!request.result.objectStoreNames.contains(store)) {
            request.result.createObjectStore(store);
          }
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.handle;
  }

  private async run<T>(
    store: string,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.open();

    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = operation(transaction.objectStore(store));

      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  }

  get<T>(store: string, key: string) {
    return this.run<T | undefined>(store, 'readonly', (s) => s.get(key));
  }

  getAll<T>(store: string) {
    return this.run<T[]>(store, 'readonly', (s) => s.getAll());
  }

  async put<T>(store: string, key: string, value: T) {
    await this.run(store, 'readwrite', (s) => s.put(value, key));
  }

  async delete(store: string, key: string) {
    await this.run(store, 'readwrite', (s) => s.delete(key));
  }

  async clear(store: string) {
    await this.run(store, 'readwrite', (s) => s.clear());
  }
}

/** Prefer IndexedDB, fall back to memory where it is unavailable. */
export function createStorage(name = 'relay'): StorageAdapter {
  return typeof indexedDB === 'undefined' ? new MemoryAdapter() : new IndexedDbAdapter(name);
}
