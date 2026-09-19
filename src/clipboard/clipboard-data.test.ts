import assert from "node:assert/strict";
import test from "node:test";
import {
  clipboardPayloadFromClipboardData,
  clipboardPayloadFromClipboardFile,
  clipboardPayloadsEqual,
  getPngFileFromClipboardData,
  setClipboardDataFromPayload,
  type ClipboardDataLike,
} from "./clipboard-data.ts";
import {
  clipboardPayloadFromPlainText,
  clipboardPayloadFromPngBytes,
  getHtmlRepresentation,
  getPlainTextRepresentation,
  type ClipboardPayloadV1,
} from "./payload.ts";
import {
  MAX_CLIPBOARD_PLAINTEXT_BYTES,
  MAX_LOCAL_CLIPBOARD_IMAGE_BYTES,
} from "./limits.ts";

function clipboardData(
  values: Record<string, string>,
  types = Object.keys(values),
): ClipboardDataLike {
  return {
    types,
    getData: (type) => values[type] ?? "",
    setData: (type, value) => {
      values[type] = value;
    },
  };
}

test("plain-only clipboard data creates a plain-only payload", () => {
  const payload = clipboardPayloadFromClipboardData(
    clipboardData({ "text/plain": "plain" }),
    "textarea fallback",
  );
  assert.deepEqual(payload, clipboardPayloadFromPlainText("plain"));
});

test("plain and HTML clipboard data remain exact opaque representations", () => {
  const html = '<script>alert("never run")</script><p onclick="x()"> 👩🏽‍💻 </p>';
  const plain = " \t\r\n日本語\ufeff ";
  const payload = clipboardPayloadFromClipboardData(
    clipboardData({ "text/plain": plain, "text/html": html }),
    "unused",
  );
  assert.equal(getPlainTextRepresentation(payload).data, plain);
  assert.equal(getHtmlRepresentation(payload)?.data, html);
});

test("explicit empty HTML is retained and differs from absent HTML", () => {
  const emptyHtml = clipboardPayloadFromClipboardData(
    clipboardData({ "text/plain": "plain", "text/html": "" }),
    "unused",
  );
  const noHtml = clipboardPayloadFromClipboardData(
    clipboardData({ "text/plain": "plain" }),
    "unused",
  );
  assert.equal(getHtmlRepresentation(emptyHtml)?.data, "");
  assert.equal(getHtmlRepresentation(noHtml), undefined);
  assert.equal(clipboardPayloadsEqual(emptyHtml, noHtml), false);
});

test("clipboard format assembly preserves text, HTML, and PNG combinations", () => {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x07,
  ]);
  const all = clipboardPayloadFromClipboardData(
    clipboardData({ "text/plain": "plain", "text/html": "<b>plain</b>" }),
    "unused",
    bytes,
  );
  assert.deepEqual(
    all.representations.map((representation) => representation.mime),
    ["text/plain", "text/html", "image/png"],
  );

  const imageOnly = clipboardPayloadFromClipboardData(
    clipboardData({}, ["Files"]),
    "",
    bytes,
  );
  assert.deepEqual(
    imageOnly.representations.map((representation) => representation.mime),
    ["image/png"],
  );
});

test("HTML at the text ceiling remains a valid local representation", () => {
  const plain = "near limit";
  const payload = clipboardPayloadFromClipboardData(
    clipboardData({
      "text/plain": plain,
      "text/html": "h".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES),
    }),
    "unused",
  );
  assert.equal(getPlainTextRepresentation(payload).data, plain);
  assert.equal(getHtmlRepresentation(payload)?.data.length, MAX_CLIPBOARD_PLAINTEXT_BYTES);
});

test("an oversized rich bundle remains a valid local payload for later text projection", () => {
  const plain = "x".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES - 100);
  const payload = clipboardPayloadFromClipboardData(
    clipboardData({ "text/plain": plain, "text/html": "<b>rich</b>" }),
    "unused",
  );
  assert.equal(getPlainTextRepresentation(payload).data, plain);
  assert.equal(getHtmlRepresentation(payload)?.data, "<b>rich</b>");
});

test("a raw plain clipboard at the limit remains usable without bundle overhead", () => {
  const plain = "x".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES);
  const payload = clipboardPayloadFromClipboardData(
    clipboardData({ "text/plain": plain }),
    "unused",
  );
  assert.equal(getPlainTextRepresentation(payload).data, plain);
});

test("clipboard data writing sets exact plain and HTML without interpretation", () => {
  const values: Record<string, string> = {};
  const html = '<img src="x" onerror="alert(1)">';
  const payload: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/html", encoding: "utf-8", data: html },
      { mime: "text/plain", encoding: "utf-8", data: "fallback" },
    ],
  };
  setClipboardDataFromPayload(clipboardData(values), payload);
  assert.deepEqual(values, { "text/plain": "fallback", "text/html": html });
});

test("PNG clipboard data is assembled and written as exact opaque bytes", async () => {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
  ]);
  const image = clipboardPayloadFromPngBytes(bytes);
  const readFile = {
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
  const fromItems = clipboardData({}, ["Files"]);
  (fromItems as { items: unknown }).items = [
    { kind: "file", type: "image/jpeg", getAsFile: () => readFile },
    { kind: "file", type: "image/png", getAsFile: () => readFile },
  ];
  assert.deepEqual(
    getPngFileFromClipboardData(fromItems),
    readFile,
  );

  const added: Blob[] = [];
  const target = clipboardData({}, ["text/plain"]);
  (target as { items: unknown }).items = {
    length: 0,
    item: () => null,
    add: (value: Blob) => {
      added.push(value);
      return {};
    },
  };
  const actual = setClipboardDataFromPayload(target, image);
  assert.deepEqual(actual, image);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.type, "image/png");
  assert.deepEqual(new Uint8Array(await added[0]!.arrayBuffer()), bytes);
});

test("oversized PNGs preserve supported text and fail cleanly without text", async () => {
  const oversized = new Uint8Array(MAX_LOCAL_CLIPBOARD_IMAGE_BYTES + 1);
  oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = { arrayBuffer: async () => oversized.buffer };

  const withText = clipboardData({ "text/plain": "keep" });
  const textPayload = await clipboardPayloadFromClipboardFile(withText, "", file);
  assert.deepEqual(textPayload, clipboardPayloadFromPlainText("keep"));

  await assert.rejects(
    clipboardPayloadFromClipboardFile(clipboardData({}, ["Files"]), "", file),
  );
});

test("PNG application failure returns the actual text fallback", () => {
  const payload: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: "plain" },
      { mime: "text/html", encoding: "utf-8", data: "<b>plain</b>" },
      {
        mime: "image/png",
        encoding: "base64",
        data: "iVBORw0KGgoBAgM=",
      },
    ],
  };
  const target = clipboardData({}, ["text/plain", "text/html"]);
  (target as { items: unknown }).items = {
    length: 0,
    item: () => null,
    add: () => {
      throw new Error("image unsupported");
    },
  };
  const actual = setClipboardDataFromPayload(target, payload);
  assert.deepEqual(actual, {
    version: 1,
    representations: payload.representations.slice(0, 2),
  });
});

test("PNG add returning null returns the actual text fallback", () => {
  const payload: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: "plain" },
      { mime: "text/html", encoding: "utf-8", data: "<b>plain</b>" },
      {
        mime: "image/png",
        encoding: "base64",
        data: "iVBORw0KGgoBAgM=",
      },
    ],
  };
  const target = clipboardData({}, ["text/plain", "text/html"]);
  (target as { items: unknown }).items = {
    length: 0,
    item: () => null,
    add: () => null,
  };

  const actual = setClipboardDataFromPayload(target, payload);
  assert.deepEqual(actual, {
    version: 1,
    representations: payload.representations.slice(0, 2),
  });
});

test("PNG add returning null fails an image-only write", () => {
  const payload = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  );
  const target = clipboardData({}, ["Files"]);
  (target as { items: unknown }).items = {
    length: 0,
    item: () => null,
    add: () => null,
  };

  assert.throws(
    () => setClipboardDataFromPayload(target, payload),
    /No supported clipboard representation could be applied/,
  );
});
