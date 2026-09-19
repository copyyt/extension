import assert from "node:assert/strict";
import test from "node:test";
import { base64ToBytes } from "../crypto/bytes.ts";
import { writePngToFocusedClipboard } from "./focused-page-writer.ts";

const VALID_PNG = base64ToBytes(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
);

type GlobalKey = "document" | "navigator" | "ClipboardItem" | "File" | "chrome";

function replaceGlobal(key: GlobalKey, value: unknown): PropertyDescriptor | undefined {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
  return original;
}

function restoreGlobal(key: GlobalKey, original: PropertyDescriptor | undefined): void {
  if (original) {
    Object.defineProperty(globalThis, key, original);
  } else {
    Reflect.deleteProperty(globalThis, key);
  }
}

function installPage(overrides: {
  clipboard?: Partial<Clipboard> | null;
  clipboardItem?: unknown;
} = {}): Array<() => void> {
  const clipboard = Object.prototype.hasOwnProperty.call(overrides, "clipboard")
    ? overrides.clipboard
    : { write: async () => undefined };
  const clipboardItem = Object.prototype.hasOwnProperty.call(
    overrides,
    "clipboardItem",
  )
    ? overrides.clipboardItem
    : class {
        public constructor() {}
      };
  const originalDocument = replaceGlobal("document", {
    location: { protocol: "chrome-extension:" },
    visibilityState: "visible",
    hasFocus: () => true,
  });
  const originalNavigator = replaceGlobal("navigator", {
    clipboard,
  });
  const originalClipboardItem = replaceGlobal(
    "ClipboardItem",
    clipboardItem,
  );
  return [
    () => restoreGlobal("document", originalDocument),
    () => restoreGlobal("navigator", originalNavigator),
    () => restoreGlobal("ClipboardItem", originalClipboardItem),
  ];
}

function restoreAll(restorers: Array<() => void>): void {
  for (const restore of restorers.reverse()) restore();
}

test("focused writer creates one image/png Blob and ClipboardItem", async () => {
  let writtenItems: unknown[] | undefined;
  let itemData: Record<string, unknown> | undefined;
  class MockClipboardItem {
    public constructor(data: Record<string, unknown>) {
      itemData = data;
    }
  }
  const restorers = installPage({
    clipboard: {
      write: async (items) => {
        writtenItems = items;
      },
    },
    clipboardItem: MockClipboardItem,
  });
  try {
    await writePngToFocusedClipboard(VALID_PNG);
  } finally {
    restoreAll(restorers);
  }

  assert.equal(writtenItems?.length, 1);
  assert.ok(itemData?.["image/png"] instanceof Blob);
  assert.equal((itemData?.["image/png"] as Blob).type, "image/png");
  assert.equal((itemData?.["image/png"] as Blob).size, VALID_PNG.byteLength);
});

test("focused writer does not construct File or assign a filename", async () => {
  let fileConstructed = false;
  const originalFile = Object.getOwnPropertyDescriptor(globalThis, "File");
  Object.defineProperty(globalThis, "File", {
    configurable: true,
    get: () => {
      fileConstructed = true;
      return class {
        public constructor() {
          fileConstructed = true;
        }
      };
    },
  });
  let itemData: Record<string, unknown> | undefined;
  class MockClipboardItem {
    public constructor(data: Record<string, unknown>) {
      itemData = data;
    }
  }
  const restorers = installPage({
    clipboardItem: MockClipboardItem,
    clipboard: { write: async () => undefined },
  });
  try {
    await writePngToFocusedClipboard(VALID_PNG);
  } finally {
    restoreAll(restorers);
    restoreGlobal("File", originalFile);
  }

  assert.equal(fileConstructed, false);
  assert.deepEqual(Object.keys(itemData ?? {}), ["image/png"]);
});

test("missing Clipboard API fails explicitly", async () => {
  const restorers = installPage({ clipboard: undefined });
  try {
    await assert.rejects(
      writePngToFocusedClipboard(VALID_PNG),
      /no Clipboard API/,
    );
  } finally {
    restoreAll(restorers);
  }
});

test("missing clipboard.write fails explicitly", async () => {
  const restorers = installPage({ clipboard: {} });
  try {
    await assert.rejects(
      writePngToFocusedClipboard(VALID_PNG),
      /no navigator\.clipboard\.write\(\)/,
    );
  } finally {
    restoreAll(restorers);
  }
});

test("missing ClipboardItem fails explicitly", async () => {
  const restorers = installPage({ clipboardItem: undefined });
  try {
    await assert.rejects(
      writePngToFocusedClipboard(VALID_PNG),
      /ClipboardItem is unavailable/,
    );
  } finally {
    restoreAll(restorers);
  }
});

test("rejected clipboard write fails explicitly", async () => {
  const restorers = installPage({
    clipboard: {
      write: async () => {
        throw new DOMException("permission denied", "NotAllowedError");
      },
    },
  });
  try {
    await assert.rejects(
      writePngToFocusedClipboard(VALID_PNG),
      /Chrome rejected the focused PNG clipboard write: NotAllowedError: permission denied/,
    );
  } finally {
    restoreAll(restorers);
  }
});

test("malformed PNG input is rejected before clipboard write", async () => {
  let writeCalls = 0;
  const restorers = installPage({
    clipboard: {
      write: async () => {
        writeCalls += 1;
      },
    },
  });
  try {
    await assert.rejects(
      writePngToFocusedClipboard(new Uint8Array([1, 2, 3])),
      /invalid signature/,
    );
  } finally {
    restoreAll(restorers);
  }
  assert.equal(writeCalls, 0);
});

test("writer fails when the extension page is not visible and focused", async () => {
  const originalDocument = replaceGlobal("document", {
    location: { protocol: "chrome-extension:" },
    visibilityState: "hidden",
    hasFocus: () => false,
  });
  try {
    await assert.rejects(
      writePngToFocusedClipboard(VALID_PNG),
      /visible, focused extension page/,
    );
  } finally {
    restoreGlobal("document", originalDocument);
  }
});

test("writer does not persist plaintext image data", async () => {
  let storageCalls = 0;
  const restorers = installPage({
    clipboard: { write: async () => undefined },
  });
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  replaceGlobal("chrome", {
    storage: {
      local: {
        set: () => {
          storageCalls += 1;
        },
      },
    },
  });
  try {
    await writePngToFocusedClipboard(VALID_PNG);
  } finally {
    restoreGlobal("chrome", originalChrome);
    restoreAll(restorers);
  }
  assert.equal(storageCalls, 0);
});
