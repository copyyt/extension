import type { ClipboardItemEnvelope } from "../crypto/crypto-core.ts";

export const RUNTIME_DATABASE_NAME = "copyyt-runtime-v1";
export const RUNTIME_DATABASE_VERSION = 2;
export const PROCESSED_ITEM_STORE = "processed-items";
export const OUTBOUND_ITEM_STORE = "outbound-items";
export const PENDING_ASSISTED_IMAGE_STORE = "pending-assisted-images";
export const ASSISTED_PNG_SUPPRESSION_STORE = "assisted-png-suppressions";

export type ProcessedItemDisposition =
  | "applied"
  | "self-echo"
  | "receive-disabled"
  | "unsupported-content"
  | "invalid-content"
  | "stale"
  | "pending-image";

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

export interface PendingAssistedImageRecord {
  key: string;
  userId: string;
  itemId: string;
  sourceDeviceId: string;
  sourceDeviceName?: string;
  receivedAt: string;
  expiresAt: string;
  hasPng: true;
  /** Encrypted envelope only; never decrypted PNG or bundle bytes. */
  envelope: ClipboardItemEnvelope;
}

export interface AssistedPngSuppressionRecord {
  key: string;
  userId: string;
  itemId: string;
  payloadFingerprint: string;
  expiresAt: string;
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
      if (!database.objectStoreNames.contains(PENDING_ASSISTED_IMAGE_STORE)) {
        database.createObjectStore(PENDING_ASSISTED_IMAGE_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(ASSISTED_PNG_SUPPRESSION_STORE)) {
        database.createObjectStore(ASSISTED_PNG_SUPPRESSION_STORE, { keyPath: "key" });
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

export interface PendingAssistedImageStore {
  list(userId: string): Promise<PendingAssistedImageRecord[]>;
  get(userId: string, itemId: string): Promise<PendingAssistedImageRecord | null>;
  put(record: Omit<PendingAssistedImageRecord, "key">): Promise<void>;
  remove(userId: string, itemId: string): Promise<void>;
  clearUser(userId: string): Promise<void>;
}

export interface AssistedPngSuppressionStore {
  put(record: Omit<AssistedPngSuppressionRecord, "key">): Promise<void>;
  consumeByFingerprint(userId: string, payloadFingerprint: string): Promise<boolean>;
  remove(userId: string, itemId: string): Promise<void>;
  clearUser(userId: string): Promise<void>;
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

function pendingKey(userId: string, itemId: string): string {
  return itemKey(userId, itemId);
}

function suppressionKey(userId: string, itemId: string): string {
  return itemKey(userId, itemId);
}

function isUnexpired(expiresAt: string, now = Date.now()): boolean {
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp > now;
}

export class InMemoryPendingAssistedImageStore implements PendingAssistedImageStore {
  private readonly records = new Map<string, PendingAssistedImageRecord>();

  async list(userId: string): Promise<PendingAssistedImageRecord[]> {
    const now = Date.now();
    const result: PendingAssistedImageRecord[] = [];
    for (const [key, record] of this.records) {
      if (record.userId !== userId) continue;
      if (!isUnexpired(record.expiresAt, now)) this.records.delete(key);
      else result.push(structuredClone(record));
    }
    return result.sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt));
  }

  async get(userId: string, itemId: string): Promise<PendingAssistedImageRecord | null> {
    const record = this.records.get(pendingKey(userId, itemId));
    if (!record) return null;
    if (!isUnexpired(record.expiresAt)) {
      this.records.delete(pendingKey(userId, itemId));
      return null;
    }
    return structuredClone(record);
  }

  async put(record: Omit<PendingAssistedImageRecord, "key">): Promise<void> {
    this.records.set(pendingKey(record.userId, record.itemId), {
      ...structuredClone(record),
      key: pendingKey(record.userId, record.itemId),
    });
  }

  async remove(userId: string, itemId: string): Promise<void> {
    this.records.delete(pendingKey(userId, itemId));
  }

  async clearUser(userId: string): Promise<void> {
    for (const [key, record] of this.records) if (record.userId === userId) this.records.delete(key);
  }
}

export class InMemoryAssistedPngSuppressionStore implements AssistedPngSuppressionStore {
  private readonly records = new Map<string, AssistedPngSuppressionRecord>();

  async put(record: Omit<AssistedPngSuppressionRecord, "key">): Promise<void> {
    this.records.set(suppressionKey(record.userId, record.itemId), {
      ...record,
      key: suppressionKey(record.userId, record.itemId),
    });
  }

  async consumeByFingerprint(userId: string, payloadFingerprint: string): Promise<boolean> {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (record.userId !== userId) continue;
      if (!isUnexpired(record.expiresAt, now)) {
        this.records.delete(key);
        continue;
      }
      if (record.payloadFingerprint === payloadFingerprint) {
        this.records.delete(key);
        return true;
      }
    }
    return false;
  }

  async remove(userId: string, itemId: string): Promise<void> {
    this.records.delete(suppressionKey(userId, itemId));
  }

  async clearUser(userId: string): Promise<void> {
    for (const [key, record] of this.records) if (record.userId === userId) this.records.delete(key);
  }
}

export class IndexedDBPendingAssistedImageStore implements PendingAssistedImageStore {
  async list(userId: string): Promise<PendingAssistedImageRecord[]> {
    return withTransaction(PENDING_ASSISTED_IMAGE_STORE, "readwrite", (store, finish) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const records = request.result as PendingAssistedImageRecord[];
        for (const record of records) {
          if (!isUnexpired(record.expiresAt)) store.delete(record.key);
        }
        const active = records
          .filter((record) => record.userId === userId && isUnexpired(record.expiresAt))
          .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt));
        finish(active.map((record) => structuredClone(record)));
      };
      request.onerror = () => request.transaction?.abort();
    });
  }

  async get(userId: string, itemId: string): Promise<PendingAssistedImageRecord | null> {
    const record = await withTransaction<PendingAssistedImageRecord | undefined>(
      PENDING_ASSISTED_IMAGE_STORE,
      "readonly",
      (store, finish) => {
        const request = store.get(pendingKey(userId, itemId));
        request.onsuccess = () => finish(request.result as PendingAssistedImageRecord | undefined);
        request.onerror = () => request.transaction?.abort();
      },
    );
    if (!record) return null;
    if (!isUnexpired(record.expiresAt)) {
      await this.remove(userId, itemId);
      return null;
    }
    return record;
  }

  async put(record: Omit<PendingAssistedImageRecord, "key">): Promise<void> {
    await withTransaction<void>(PENDING_ASSISTED_IMAGE_STORE, "readwrite", (store, finish) => {
      store.put({ ...structuredClone(record), key: pendingKey(record.userId, record.itemId) });
      finish(undefined);
    });
  }

  async remove(userId: string, itemId: string): Promise<void> {
    await withTransaction<void>(PENDING_ASSISTED_IMAGE_STORE, "readwrite", (store, finish) => {
      store.delete(pendingKey(userId, itemId));
      finish(undefined);
    });
  }

  async clearUser(userId: string): Promise<void> {
    await withTransaction<void>(PENDING_ASSISTED_IMAGE_STORE, "readwrite", (store, finish) => {
      const request = store.getAll();
      request.onsuccess = () => {
        for (const record of request.result as PendingAssistedImageRecord[]) {
          if (record.userId === userId) store.delete(record.key);
        }
        finish(undefined);
      };
      request.onerror = () => request.transaction?.abort();
    });
  }
}

export class IndexedDBAssistedPngSuppressionStore implements AssistedPngSuppressionStore {
  async put(record: Omit<AssistedPngSuppressionRecord, "key">): Promise<void> {
    await withTransaction<void>(ASSISTED_PNG_SUPPRESSION_STORE, "readwrite", (store, finish) => {
      store.put({ ...record, key: suppressionKey(record.userId, record.itemId) });
      finish(undefined);
    });
  }

  async consumeByFingerprint(userId: string, payloadFingerprint: string): Promise<boolean> {
    return withTransaction<boolean>(ASSISTED_PNG_SUPPRESSION_STORE, "readwrite", (store, finish) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const records = request.result as AssistedPngSuppressionRecord[];
        const match = records.find((record) =>
          record.userId === userId &&
          isUnexpired(record.expiresAt) &&
          record.payloadFingerprint === payloadFingerprint,
        );
        for (const record of records) {
          if (!isUnexpired(record.expiresAt) || record === match) store.delete(record.key);
        }
        finish(Boolean(match));
      };
      request.onerror = () => request.transaction?.abort();
    });
  }

  async remove(userId: string, itemId: string): Promise<void> {
    await withTransaction<void>(ASSISTED_PNG_SUPPRESSION_STORE, "readwrite", (store, finish) => {
      store.delete(suppressionKey(userId, itemId));
      finish(undefined);
    });
  }

  async clearUser(userId: string): Promise<void> {
    await withTransaction<void>(ASSISTED_PNG_SUPPRESSION_STORE, "readwrite", (store, finish) => {
      const request = store.getAll();
      request.onsuccess = () => {
        for (const record of request.result as AssistedPngSuppressionRecord[]) {
          if (record.userId === userId) store.delete(record.key);
        }
        finish(undefined);
      };
      request.onerror = () => request.transaction?.abort();
    });
  }
}
