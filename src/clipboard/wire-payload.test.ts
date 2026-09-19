import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIPBOARD_BUNDLE_V1_CAPABILITY,
  CLIPBOARD_HTML_V1_CAPABILITY,
} from "./capabilities.ts";
import {
  CLIPBOARD_BUNDLE_V1_MIME,
  clipboardPayloadFromPlainText,
  encodeClipboardBundleV1,
  type ClipboardPayloadV1,
} from "./payload.ts";
import {
  selectClipboardWirePayload,
  type ClipboardWireRecipient,
} from "./wire-payload.ts";
import { MAX_CLIPBOARD_PLAINTEXT_BYTES } from "./limits.ts";

const richPayload: ClipboardPayloadV1 = {
  version: 1,
  representations: [
    { mime: "text/plain", encoding: "utf-8", data: "plain fallback" },
    { mime: "text/html", encoding: "utf-8", data: "<b>rich</b>" },
  ],
};

const richCapabilities = [
  CLIPBOARD_BUNDLE_V1_CAPABILITY,
  CLIPBOARD_HTML_V1_CAPABILITY,
];

function recipient(
  localCapabilities: unknown,
  serverCapabilities: unknown,
): ClipboardWireRecipient {
  return {
    local: { capabilities: localCapabilities },
    server: { capabilities: serverCapabilities },
  };
}

test("selects one rich bundle when every actual recipient agrees on capabilities", () => {
  const selected = selectClipboardWirePayload({
    payload: richPayload,
    recipients: [
      recipient(richCapabilities, [...richCapabilities]),
      recipient([...richCapabilities, "clipboard"], richCapabilities),
    ],
  });

  assert.equal(selected.contentType, CLIPBOARD_BUNDLE_V1_MIME);
  assert.equal(selected.format, "bundle-v1");
  assert.deepEqual(selected.plaintext, encodeClipboardBundleV1(richPayload));
});

test("downgrades rich data when one recipient is missing, malformed, or disagrees on capabilities", () => {
  for (const candidate of [
    recipient(richCapabilities, []),
    recipient(richCapabilities, [CLIPBOARD_BUNDLE_V1_CAPABILITY]),
    recipient(undefined, richCapabilities),
    recipient([CLIPBOARD_BUNDLE_V1_CAPABILITY, 42], richCapabilities),
  ]) {
    const selected = selectClipboardWirePayload({
      payload: richPayload,
      recipients: [recipient(richCapabilities, richCapabilities), candidate],
    });
    assert.deepEqual(selected, {
      contentType: "text/plain",
      plaintext: "plain fallback",
      format: "legacy-text",
    });
  }
});

test("keeps plain-only payloads on the legacy wire even when recipients are rich-capable", () => {
  const selected = selectClipboardWirePayload({
    payload: clipboardPayloadFromPlainText("plain only"),
    recipients: [recipient(richCapabilities, richCapabilities)],
  });
  assert.deepEqual(selected, {
    contentType: "text/plain",
    plaintext: "plain only",
    format: "legacy-text",
  });
});

test("downgrades a bundle that exceeds the safe plaintext limit without truncating the fallback", () => {
  const plainText = "exact fallback";
  const oversized: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: plainText },
      {
        mime: "text/html",
        encoding: "utf-8",
        data: "x".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES),
      },
    ],
  };
  const selected = selectClipboardWirePayload({
    payload: oversized,
    recipients: [recipient(richCapabilities, richCapabilities)],
  });
  assert.deepEqual(selected, {
    contentType: "text/plain",
    plaintext: plainText,
    format: "legacy-text",
  });
});

