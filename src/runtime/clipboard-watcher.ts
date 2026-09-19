import {
  clipboardPayloadFromPlainText,
  getPlainTextRepresentation,
  validateClipboardPayloadV1,
  type ClipboardPayloadV1,
} from "../clipboard/payload.ts";
import { clipboardPayloadsEqual } from "../clipboard/clipboard-data.ts";

export type ClipboardTimerId = ReturnType<typeof globalThis.setInterval>;
export type ClipboardSetInterval = (
  handler: () => void,
  ms: number,
) => ClipboardTimerId;
export type ClipboardClearInterval = (id: ClipboardTimerId) => void;

export interface ClipboardWatcherOptions {
  /** Legacy adapter hook retained for diagnostics and compatibility tests. */
  readText?: () => string | Promise<string>;
  /** Typed adapter hook used by the production offscreen watcher. */
  readPayload?: () => ClipboardPayloadV1 | Promise<ClipboardPayloadV1>;
  /** Legacy callback receives the plain fallback. */
  onChanged?: (text: string) => void | Promise<void>;
  /** Typed callback receives the complete in-memory payload. */
  onPayloadChanged?: (
    payload: ClipboardPayloadV1,
  ) => void | Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  setIntervalFn?: ClipboardSetInterval;
  clearIntervalFn?: ClipboardClearInterval;
}

export interface ClipboardWatchStartOptions {
  resetBaseline?: boolean;
}

/**
 * Polls an operating-system clipboard adapter without retaining clipboard
 * content outside this offscreen document.
 */
export class ClipboardWatcher {
  private readonly readPayload: () => ClipboardPayloadV1 | Promise<ClipboardPayloadV1>;
  private readonly onChanged: ClipboardWatcherOptions["onChanged"];
  private readonly onPayloadChanged: ClipboardWatcherOptions["onPayloadChanged"];
  private readonly onError: (error: unknown) => void;
  private readonly intervalMs: number;
  private readonly setIntervalFn: ClipboardSetInterval;
  private readonly clearIntervalFn: ClipboardClearInterval;
  private readonly typedMode: boolean;
  private timer: ClipboardTimerId | null = null;
  private running = false;
  private reading = false;
  private generation = 0;
  private baselineVersion = 0;
  private hasBaseline = false;
  private baseline: ClipboardPayloadV1 | null = null;

  constructor(options: ClipboardWatcherOptions) {
    if (!options.readPayload && !options.readText) {
      throw new Error("Clipboard watcher requires a clipboard reader");
    }
    if (!options.onChanged && !options.onPayloadChanged) {
      throw new Error("Clipboard watcher requires a change callback");
    }
    this.typedMode = Boolean(options.readPayload);
    this.readPayload =
      options.readPayload ??
      (async () => clipboardPayloadFromPlainText(await options.readText!()));
    this.onChanged = options.onChanged;
    this.onPayloadChanged = options.onPayloadChanged;
    this.onError = options.onError ?? (() => undefined);
    this.intervalMs = options.intervalMs ?? 800;
    this.setIntervalFn =
      options.setIntervalFn ??
      ((handler, ms) => globalThis.setInterval(handler, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((id) => globalThis.clearInterval(id));
  }

  get isWatching(): boolean {
    return this.running;
  }

  start(options: ClipboardWatchStartOptions = {}): void {
    if (options.resetBaseline) {
      this.baselineVersion += 1;
      this.hasBaseline = false;
      this.baseline = null;
    }
    if (this.running) return;

    this.running = true;
    const generation = this.generation;
    this.timer = this.setIntervalFn(() => {
      this.pollSafely(generation);
    }, this.intervalMs);
    this.pollSafely(generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.baselineVersion += 1;
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    this.hasBaseline = false;
    this.baseline = null;
  }

  /** Establishes the value written by a trusted remote item. */
  noteExternalWrite(value: ClipboardPayloadV1 | string): void {
    const payload =
      typeof value === "string" ? clipboardPayloadFromPlainText(value) : value;
    validateClipboardPayloadV1(payload);
    this.baselineVersion += 1;
    this.baseline = payload;
    this.hasBaseline = true;
  }

  private async poll(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation || this.reading) return;
    this.reading = true;
    const baselineVersion = this.baselineVersion;
    try {
      const payload = await this.readPayload();
      validateClipboardPayloadV1(payload);
      if (
        !this.running ||
        generation !== this.generation ||
        baselineVersion !== this.baselineVersion
      ) {
        return;
      }

      const changed =
        this.hasBaseline &&
        this.baseline !== null &&
        !clipboardPayloadsEqual(payload, this.baseline);
      // Set the baseline before notifying the service worker. A slow worker
      // cannot cause the same observation to be emitted again.
      this.baseline = payload;
      this.hasBaseline = true;
      if (!changed || getPlainTextRepresentation(payload).data.length === 0) {
        return;
      }

      try {
        if (this.typedMode && this.onPayloadChanged) {
          await this.onPayloadChanged(payload);
        } else {
          await this.onChanged!(getPlainTextRepresentation(payload).data);
        }
      } catch (error) {
        this.handleWatcherError(error);
      }
    } catch (error) {
      if (this.running && generation === this.generation) {
        this.handleWatcherError(error);
      }
    } finally {
      this.reading = false;
    }
  }

  private pollSafely(generation: number): void {
    void this.poll(generation).catch((error) => {
      this.handleWatcherError(error);
    });
  }

  private handleWatcherError(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Error reporting must never turn a timer callback into an unhandled
      // rejected Promise.
    }
  }
}
