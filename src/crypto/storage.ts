export const CRYPTO_DATABASE_NAME = "copyyt-crypto-v2";
export const CRYPTO_DATABASE_VERSION = 1;
export const IDENTITY_STORE = "identity";
export const TRUST_DEVICE_STORE = "trust-device";

export function openCryptoDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    throw new Error("IndexedDB is required for Copyyt cryptographic state");
  }

  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(
      CRYPTO_DATABASE_NAME,
      CRYPTO_DATABASE_VERSION,
    );
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to open the Copyyt crypto database"));
    request.onblocked = () =>
      reject(new Error("The Copyyt crypto database is blocked by another context"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(IDENTITY_STORE)) {
        database.createObjectStore(IDENTITY_STORE);
      }
      if (!database.objectStoreNames.contains(TRUST_DEVICE_STORE)) {
        database.createObjectStore(TRUST_DEVICE_STORE);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

export function closeDatabase(database: IDBDatabase): void {
  database.close();
}
