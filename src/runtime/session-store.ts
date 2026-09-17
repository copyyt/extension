import type { IUser } from "../interfaces/user.interface.ts";

export const SESSION_STORAGE_KEY = "copyyt.runtime.session";
export const STATUS_STORAGE_KEY = "copyyt.runtime.status";

export interface RuntimeSession {
  schemaVersion: 1;
  accessToken: string;
  user: IUser;
}

export interface KeyValueStorageArea {
  get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function storageArea(): KeyValueStorageArea {
  const extensionChrome = globalThis.chrome as typeof chrome | undefined;
  if (!extensionChrome?.storage?.local) {
    throw new Error("Chrome extension storage is unavailable");
  }
  return extensionChrome.storage.local as unknown as KeyValueStorageArea;
}

function isUser(value: unknown): value is IUser {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<IUser>;
  return (
    typeof candidate.id === "string" &&
    (candidate.name === undefined || typeof candidate.name === "string") &&
    typeof candidate.email === "string" &&
    typeof candidate.emailVerified === "boolean" &&
    (candidate.googleSubject === undefined ||
      typeof candidate.googleSubject === "string")
  );
}

function isSession(value: unknown): value is RuntimeSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RuntimeSession>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.accessToken === "string" &&
    candidate.accessToken.length > 0 &&
    isUser(candidate.user)
  );
}

export interface SessionStore {
  get(): Promise<RuntimeSession | null>;
  set(session: RuntimeSession): Promise<void>;
  clear(): Promise<void>;
}

export class ChromeSessionStore implements SessionStore {
  private readonly area: KeyValueStorageArea;

  constructor(area: KeyValueStorageArea = storageArea()) {
    this.area = area;
  }

  async get(): Promise<RuntimeSession | null> {
    const values = await this.area.get(SESSION_STORAGE_KEY);
    const session = values[SESSION_STORAGE_KEY];
    return session === undefined ? null : isSession(session) ? session : null;
  }

  async set(session: RuntimeSession): Promise<void> {
    if (!isSession(session)) {
      throw new TypeError("The runtime session is invalid");
    }
    await this.area.set({ [SESSION_STORAGE_KEY]: session });
  }

  async clear(): Promise<void> {
    await this.area.remove(SESSION_STORAGE_KEY);
  }
}

export interface StatusStore<T> {
  get(): Promise<T | null>;
  set(status: T): Promise<void>;
}

export class ChromeStatusStore<T> implements StatusStore<T> {
  private readonly area: KeyValueStorageArea;
  private readonly key: string;

  constructor(
    area: KeyValueStorageArea = storageArea(),
    key = STATUS_STORAGE_KEY,
  ) {
    this.area = area;
    this.key = key;
  }

  async get(): Promise<T | null> {
    const values = await this.area.get(this.key);
    return (values[this.key] as T | undefined) ?? null;
  }

  async set(status: T): Promise<void> {
    await this.area.set({ [this.key]: status });
  }
}
