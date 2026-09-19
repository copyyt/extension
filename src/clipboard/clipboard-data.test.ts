import assert from "node:assert/strict";
import test from "node:test";
import {
  clipboardPayloadFromClipboardData,
  clipboardPayloadsEqual,
  setClipboardDataFromPayload,
  type ClipboardDataLike,
} from "./clipboard-data.ts";
import {
  clipboardPayloadFromPlainText,
  getHtmlRepresentation,
  getPlainTextRepresentation,
  type ClipboardPayloadV1,
} from "./payload.ts";
import { MAX_CLIPBOARD_PLAINTEXT_BYTES } from "./limits.ts";

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

test("HTML size overflow drops only HTML and preserves the exact plain fallback", () => {
  const plain = "near limit";
  const payload = clipboardPayloadFromClipboardData(
    clipboardData({
      "text/plain": plain,
      "text/html": "h".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES),
    }),
    "unused",
  );
  assert.equal(getPlainTextRepresentation(payload).data, plain);
  assert.equal(getHtmlRepresentation(payload), undefined);
});

test("an oversized rich bundle downgrades a near-limit valid raw clipboard", () => {
  const plain = "x".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES - 100);
  const payload = clipboardPayloadFromClipboardData(
    clipboardData({ "text/plain": plain, "text/html": "<b>rich</b>" }),
    "unused",
  );
  assert.equal(getPlainTextRepresentation(payload).data, plain);
  assert.equal(getHtmlRepresentation(payload), undefined);
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

