export const SYNC_PREFERENCES_STORAGE_KEY = "copyyt.runtime.sync-preferences";

export interface SyncPreferences {
  schemaVersion: 1;
  sendEnabled: boolean;
  receiveEnabled: boolean;
}

export const DEFAULT_SYNC_PREFERENCES: SyncPreferences = {
  schemaVersion: 1,
  sendEnabled: true,
  receiveEnabled: true,
};

export const OFF_SYNC_PREFERENCES: SyncPreferences = {
  schemaVersion: 1,
  sendEnabled: false,
  receiveEnabled: false,
};

export function isSyncPreferences(value: unknown): value is SyncPreferences {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SyncPreferences>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.sendEnabled === "boolean" &&
    typeof candidate.receiveEnabled === "boolean"
  );
}

export interface SyncPreferencesStore {
  get(): Promise<SyncPreferences>;
  set(preferences: SyncPreferences): Promise<void>;
}

export interface SyncPreferencesStorageArea {
  get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function storageArea(): SyncPreferencesStorageArea {
  const extensionChrome = globalThis.chrome as typeof chrome | undefined;
  if (!extensionChrome?.storage?.local) {
    throw new Error("Chrome extension storage is unavailable");
  }
  return extensionChrome.storage.local as unknown as SyncPreferencesStorageArea;
}

/**
 * A malformed stored value is treated as Off. This keeps bad local state from
 * unexpectedly enabling clipboard I/O; a missing value uses the Both default.
 */
export class ChromeSyncPreferencesStore implements SyncPreferencesStore {
  private readonly area: SyncPreferencesStorageArea;

  constructor(area: SyncPreferencesStorageArea = storageArea()) {
    this.area = area;
  }

  async get(): Promise<SyncPreferences> {
    const values = await this.area.get(SYNC_PREFERENCES_STORAGE_KEY);
    const stored = values[SYNC_PREFERENCES_STORAGE_KEY];
    return stored === undefined
      ? { ...DEFAULT_SYNC_PREFERENCES }
      : isSyncPreferences(stored)
        ? { ...stored }
        : { ...OFF_SYNC_PREFERENCES };
  }

  async set(preferences: SyncPreferences): Promise<void> {
    if (!isSyncPreferences(preferences)) {
      throw new TypeError("The clipboard sync preferences are invalid");
    }
    await this.area.set({
      [SYNC_PREFERENCES_STORAGE_KEY]: { ...preferences },
    });
  }
}

/** A small in-memory equivalent used by runtime tests and local harnesses. */
export class InMemorySyncPreferencesStore implements SyncPreferencesStore {
  private preferences: SyncPreferences | null = null;

  async get(): Promise<SyncPreferences> {
    return this.preferences
      ? { ...this.preferences }
      : { ...DEFAULT_SYNC_PREFERENCES };
  }

  async set(preferences: SyncPreferences): Promise<void> {
    if (!isSyncPreferences(preferences)) {
      throw new TypeError("The clipboard sync preferences are invalid");
    }
    this.preferences = { ...preferences };
  }
}
