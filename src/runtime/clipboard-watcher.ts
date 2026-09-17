export interface ClipboardWatcherOptions {
  readText: () => string | Promise<string>;
  onChanged: (text: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export interface ClipboardWatchStartOptions {
  resetBaseline?: boolean;
}

/**
 * Polls an operating-system clipboard adapter without retaining clipboard
 * content outside this offscreen document.
 */
export class ClipboardWatcher {
  private readonly readText: ClipboardWatcherOptions["readText"];
  private readonly onChanged: ClipboardWatcherOptions["onChanged"];
  private readonly onError: (error: unknown) => void;
  private readonly intervalMs: number;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private running = false;
  private reading = false;
  private generation = 0;
  private baselineVersion = 0;
  private hasBaseline = false;
  private baseline = "";

  constructor(options: ClipboardWatcherOptions) {
    this.readText = options.readText;
    this.onChanged = options.onChanged;
    this.onError = options.onError ?? (() => undefined);
    this.intervalMs = options.intervalMs ?? 800;
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
  }

  get isWatching(): boolean {
    return this.running;
  }

  start(options: ClipboardWatchStartOptions = {}): void {
    if (options.resetBaseline) {
      this.baselineVersion += 1;
      this.hasBaseline = false;
      this.baseline = "";
    }
    if (this.running) return;

    this.running = true;
    const generation = this.generation;
    this.timer = this.setIntervalFn(() => {
      void this.poll(generation);
    }, this.intervalMs);
    void this.poll(generation);
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
    this.baseline = "";
  }

  /**
   * Establishes the value written by a trusted remote item before the next
   * sample. This is synchronous with the successful clipboard write in the
   * offscreen message handler.
   */
  noteExternalWrite(text: string): void {
    this.baselineVersion += 1;
    this.baseline = text;
    this.hasBaseline = true;
  }

  private async poll(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation || this.reading) return;
    this.reading = true;
    const baselineVersion = this.baselineVersion;
    try {
      const text = await this.readText();
      if (
        !this.running ||
        generation !== this.generation ||
        baselineVersion !== this.baselineVersion ||
        typeof text !== "string"
      ) {
        return;
      }

      const changed = this.hasBaseline && text !== this.baseline;
      // Set the baseline before notifying the service worker. A slow worker
      // cannot cause the same observation to be emitted again.
      this.baseline = text;
      this.hasBaseline = true;
      if (!changed || text.length === 0) return;

      try {
        void Promise.resolve(this.onChanged(text)).catch(this.onError);
      } catch (error) {
        this.onError(error);
      }
    } catch (error) {
      if (this.running && generation === this.generation) this.onError(error);
    } finally {
      this.reading = false;
    }
  }
}
