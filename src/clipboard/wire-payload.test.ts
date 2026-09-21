import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIPBOARD_BUNDLE_V1_CAPABILITY,
  CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY,
  CLIPBOARD_HTML_V1_CAPABILITY,
  CLIPBOARD_IMAGE_PNG_ASSISTED_WRITE_V1_CAPABILITY,
} from "./capabilities.ts";
import {
  CLIPBOARD_BUNDLE_V1_MIME,
  clipboardPayloadFromPlainText,
  clipboardPayloadFromPngBytes,
  encodeClipboardBundleV1,
  type ClipboardPayloadV1,
} from "./payload.ts";
import {
  selectClipboardWirePayload,
  selectClipboardWirePayloads,
  selectClipboardDeliveryRoutes,
  ClipboardWirePayloadTooLargeError,
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
const pngCapabilities = [
  ...richCapabilities,
  CLIPBOARD_IMAGE_PNG_ASSISTED_WRITE_V1_CAPABILITY,
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

test("local PNG data is projected out of every Phase 2C.3.0 wire selection", () => {
  const image = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]),
  );
  const mixed: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: "plain" },
      { mime: "text/html", encoding: "utf-8", data: "<b>plain</b>" },
      ...image.representations,
    ],
  };
  const selected = selectClipboardWirePayload({
    payload: mixed,
    recipients: [recipient(richCapabilities, richCapabilities)],
  });
  assert.equal(selected.contentType, CLIPBOARD_BUNDLE_V1_MIME);
  const decoded = JSON.parse(new TextDecoder().decode(selected.plaintext as Uint8Array)) as ClipboardPayloadV1;
  assert.deepEqual(decoded.representations.map((representation) => representation.mime), [
    "text/plain",
    "text/html",
  ]);
  assert.equal(decoded.representations.some((representation) => representation.mime === "image/png"), false);
  assert.throws(() => selectClipboardWirePayload({ payload: image, recipients: [] }));
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

test("selects an image bundle only for recipients with the assisted PNG capability", () => {
  const image = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]),
  );
  const mixed: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: "exact plain" },
      { mime: "text/html", encoding: "utf-8", data: "<b>exact plain</b>" },
      ...image.representations,
    ],
  };
  const projections = selectClipboardWirePayloads({
    payload: mixed,
    recipients: [
      recipient(pngCapabilities, pngCapabilities),
      recipient(richCapabilities, richCapabilities),
      recipient(["clipboard"], ["clipboard"]),
    ],
  });

  assert.equal(projections.length, 3);
  const representations = projections.map((projection) =>
    projection.payload.representations.map((value) => value.mime),
  );
  assert.deepEqual(representations, [
    ["text/plain", "text/html", "image/png"],
    ["text/plain", "text/html"],
    ["text/plain"],
  ]);
  assert.equal(
    (projections[0]!.wirePayload.plaintext as Uint8Array).byteLength > 0,
    true,
  );
  assert.equal(projections[0]!.wirePayload.format, "bundle-v1");
});

test("an image-only payload has no projection for recipients without assisted PNG", () => {
  const image = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]),
  );
  assert.equal(
    selectClipboardWirePayloads({
      payload: image,
      recipients: [recipient(richCapabilities, richCapabilities)],
    }).length,
    0,
  );
  const selected = selectClipboardWirePayload({
    payload: image,
    recipients: [recipient(pngCapabilities, pngCapabilities)],
  });
  assert.equal(selected.format, "bundle-v1");
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(selected.plaintext as Uint8Array))
      .representations.map((value: { mime: string }) => value.mime),
    ["image/png"],
  );
});

test("PNG projection measures serialized bundle size and never truncates", () => {
  const bytes = new Uint8Array(1_100_000);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const image = clipboardPayloadFromPngBytes(bytes);
  assert.throws(
    () =>
      selectClipboardWirePayloads({
        payload: image,
        recipients: [recipient(pngCapabilities, pngCapabilities)],
      }),
    ClipboardWirePayloadTooLargeError,
  );
});

test("oversized PNG routing is recipient-specific and never creates an oversized relay projection", () => {
  const bytes = new Uint8Array(800_000);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = clipboardPayloadFromPngBytes(bytes);
  const payload: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: "fallback" },
      { mime: "text/html", encoding: "utf-8", data: "<b>fallback</b>" },
      ...png.representations,
    ],
  };
  const directCapabilities = [
    ...pngCapabilities,
    CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY,
  ];
  const routes = selectClipboardDeliveryRoutes({
    payload,
    recipients: [
      recipient(directCapabilities, directCapabilities),
      recipient(pngCapabilities, pngCapabilities),
      recipient(["clipboard"], ["clipboard"]),
    ],
  });
  assert.equal(routes.direct.length, 1);
  assert.equal(routes.direct[0]!.payload.representations.some((value) => value.mime === "image/png"), true);
  assert.deepEqual(
    routes.direct[0]!.payload.representations.map((value) => value.mime),
    ["image/png"],
  );
  assert.equal(
    (routes.direct[0]!.plaintext as Uint8Array).byteLength > 0,
    true,
  );
  assert.equal(routes.relay.length, 2);
  const richFallback = routes.relay.find((route) =>
    route.payload.representations.some((value) => value.mime === "text/html"),
  );
  assert.equal(richFallback?.recipients.includes(routes.direct[0]!.recipient), true);
  assert.equal(richFallback?.recipients.length, 2);
  assert.equal(
    richFallback?.payload.representations.some((value) => value.mime === "image/png"),
    false,
  );
  for (const relay of routes.relay) {
    if (relay.wirePayload.format === "bundle-v1") {
      assert.equal(
        relay.wirePayload.plaintext.byteLength <= MAX_CLIPBOARD_PLAINTEXT_BYTES,
        true,
      );
      assert.equal(relay.payload.representations.some((value) => value.mime === "image/png"), false);
    }
  }
});
