export const RUNTIME_DATABASE_NAME = "copyyt-runtime-v1";
export const RUNTIME_DATABASE_VERSION = 1;
export const PROCESSED_ITEM_STORE = "processed-items";
export const OUTBOUND_ITEM_STORE = "outbound-items";

export type ProcessedItemDisposition =
  | "applied"
  | "self-echo"
  | "receive-disabled"
  | "stale";

const MAX_ITEM_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ITEM_COUNT = 500;

export interface ProcessedItemRecord {
  key: string;
  userId: string;
  itemId: string;
  processedAt: string;
  sourceDeviceId: string;
  disposition?: ProcessedItemDisposition;
}

export interface OutboundItemRecord {
  key: string;
  userId: string;
  itemId: string;
  publishedAt: string;
  sourceDeviceId: string;
}

function itemKey(userId: string, itemId: string): string {
  return JSON.stringify([userId, itemId]);
}

function openRuntimeDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    throw new Error("IndexedDB is required for runtime item metadata");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RUNTIME_DATABASE_NAME, RUNTIME_DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Unable to open runtime database"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROCESSED_ITEM_STORE)) {
        database.createObjectStore(PROCESSED_ITEM_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(OUTBOUND_ITEM_STORE)) {
        database.createObjectStore(OUTBOUND_ITEM_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function close(database: IDBDatabase): void {
  database.close();
}

function isFresh(timestamp: string, now: number): boolean {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && now - time <= MAX_ITEM_AGE_MS;
}

function withTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, finish: (value: T) => void) => void,
): Promise<T> {
  return openRuntimeDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        let value: T | undefined;
        let hasValue = false;
        let done = false;
        const finish = (result: T): void => {
          value = result;
          hasValue = true;
        };
        transaction.oncomplete = () => {
          close(database);
          if (done) return;
          done = true;
          if (!hasValue) reject(new Error("Runtime metadata transaction did not finish"));
          else resolve(value as T);
        };
        transaction.onerror = () => {
          close(database);
          if (!done) {
            done = true;
            reject(transaction.error ?? new Error("Runtime metadata transaction failed"));
          }
        };
        transaction.onabort = () => {
          close(database);
          if (!done) {
            done = true;
            reject(transaction.error ?? new Error("Runtime metadata transaction aborted"));
          }
        };
        try {
          work(transaction.objectStore(storeName), finish);
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            // The transaction may already be closing.
          }
          reject(error);
        }
      }),
  );
}

async function pruneStore(storeName: string, now = Date.now()): Promise<void> {
  await withTransaction<void>(storeName, "readwrite", (store, finish) => {
    const request = store.getAll();
    request.onerror = () => {
      try {
        request.transaction?.abort();
      } catch {
        // The transaction may already be closing.
      }
    };
    request.onsuccess = () => {
      const records = request.result as Array<{ key: string; processedAt?: string; publishedAt?: string }>;
      const timestamp = (record: (typeof records)[number]) => record.processedAt ?? record.publishedAt ?? "";
      const sorted = records
        .filter((record) => isFresh(timestamp(record), now))
        .sort((left, right) => Date.parse(timestamp(right)) - Date.parse(timestamp(left)));
      for (const record of sorted.slice(MAX_ITEM_COUNT)) {
        store.delete(record.key);
      }
      for (const record of records) {
        if (!isFresh(timestamp(record), now)) store.delete(record.key);
      }
      finish(undefined);
    };
  });
}

async function hasRecord(storeName: string, userId: string, itemId: string): Promise<boolean> {
  await pruneStore(storeName);
  return withTransaction<boolean>(storeName, "readonly", (store, finish) => {
    const request = store.get(itemKey(userId, itemId));
    request.onerror = () => {
      try {
        request.transaction?.abort();
      } catch {
        // The transaction may already be closing.
      }
    };
    request.onsuccess = () => finish(request.result !== undefined);
  });
}

export interface ProcessedItemStore {
  has(userId: string, itemId: string): Promise<boolean>;
  mark(record: Omit<ProcessedItemRecord, "key">): Promise<void>;
}

export interface OutboundItemStore {
  has(userId: string, itemId: string): Promise<boolean>;
  mark(record: Omit<OutboundItemRecord, "key">): Promise<void>;
}

export class IndexedDBProcessedItemStore implements ProcessedItemStore {
  has(userId: string, itemId: string): Promise<boolean> {
    return hasRecord(PROCESSED_ITEM_STORE, userId, itemId);
  }

  async mark(record: Omit<ProcessedItemRecord, "key">): Promise<void> {
    await withTransaction<void>(PROCESSED_ITEM_STORE, "readwrite", (store, finish) => {
      store.put({ ...record, key: itemKey(record.userId, record.itemId) });
      finish(undefined);
    });
    await pruneStore(PROCESSED_ITEM_STORE);
  }
}

export class IndexedDBOutboundItemStore implements OutboundItemStore {
  has(userId: string, itemId: string): Promise<boolean> {
    return hasRecord(OUTBOUND_ITEM_STORE, userId, itemId);
  }

  async mark(record: Omit<OutboundItemRecord, "key">): Promise<void> {
    await withTransaction<void>(OUTBOUND_ITEM_STORE, "readwrite", (store, finish) => {
      store.put({ ...record, key: itemKey(record.userId, record.itemId) });
      finish(undefined);
    });
    await pruneStore(OUTBOUND_ITEM_STORE);
  }
}

export class InMemoryItemMetadataStore implements ProcessedItemStore, OutboundItemStore {
  private readonly records = new Map<string, ProcessedItemRecord | OutboundItemRecord>();

  async has(userId: string, itemId: string): Promise<boolean> {
    return this.records.has(itemKey(userId, itemId));
  }

  async mark(record: Omit<ProcessedItemRecord, "key"> | Omit<OutboundItemRecord, "key">): Promise<void> {
    this.records.set(itemKey(record.userId, record.itemId), {
      ...record,
      key: itemKey(record.userId, record.itemId),
    });
  }
}
