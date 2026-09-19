import assert from "node:assert/strict";
import test from "node:test";
import {
  AES_GCM_TAG_BYTES,
  MAX_CLIPBOARD_CIPHERTEXT_BYTES,
  MAX_CLIPBOARD_PLAINTEXT_BYTES,
} from "./limits.ts";
import {
  CLIPBOARD_BUNDLE_V1_MIME,
  CLIPBOARD_PAYLOAD_VERSION,
  clipboardPayloadFromPlainText,
  decodeClipboardBundleV1,
  decodeClipboardPlainText,
  encodeClipboardBundleV1,
  getHtmlRepresentation,
  getPlainTextRepresentation,
  validateClipboardPayloadV1,
  type ClipboardPayloadV1,
} from "./payload.ts";
import {
  isClipboardText,
  MAX_CLIPBOARD_TEXT_BYTES,
} from "../runtime/messages.ts";

const encoder = new TextEncoder();
const plainRepresentation = {
  mime: "text/plain",
  encoding: "utf-8",
  data: "text",
};
const htmlRepresentation = {
  mime: "text/html",
  encoding: "utf-8",
  data: "<p>text</p>",
};

function serialized(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

test("plain text payload construction creates only the mandatory fallback", () => {
  const payload = clipboardPayloadFromPlainText("clipboard text");
  assert.equal(CLIPBOARD_PAYLOAD_VERSION, 1);
  assert.equal(
    CLIPBOARD_BUNDLE_V1_MIME,
    "application/vnd.copyyt.clipboard-bundle+json",
  );
  assert.deepEqual(payload, {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: "clipboard text" },
    ],
  });
  assert.equal(getPlainTextRepresentation(payload).data, "clipboard text");
  assert.equal(getHtmlRepresentation(payload), undefined);
  assert.equal(
    getPlainTextRepresentation(clipboardPayloadFromPlainText("")).data,
    "",
  );
});

test("whitespace, Unicode, emoji, decomposed accents and leading BOM remain exact", () => {
  const samples = [
    " \t\r\n  clipboard\t \n\r ",
    "Grüße 日本語 مرحبا 👩🏽‍💻 🧑‍🚀",
    "e\u0301 \u00e9 \u200b\u00a0\u0000",
    "\ufeff\ufeffleading BOM\ufeff",
    "",
  ];
  for (const text of samples) {
    const payload = clipboardPayloadFromPlainText(text);
    assert.equal(getPlainTextRepresentation(payload).data, text);
    assert.deepEqual(
      decodeClipboardBundleV1(encodeClipboardBundleV1(payload)),
      payload,
    );
    assert.equal(
      getPlainTextRepresentation(decodeClipboardPlainText(encoder.encode(text)))
        .data,
      text,
    );
  }
});

test("bundle round trip preserves both representations and treats HTML as opaque data", () => {
  const html =
    '<script>throw new Error("never execute")</script><p onclick="alert(1)"> 👩🏽‍💻 </p>';
  const payload: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/html", encoding: "utf-8", data: html },
      { mime: "text/plain", encoding: "utf-8", data: " 👩🏽‍💻 \n" },
    ],
  };
  const decoded = decodeClipboardBundleV1(encodeClipboardBundleV1(payload));
  assert.deepEqual(decoded, payload);
  assert.equal(getHtmlRepresentation(decoded)?.data, html);
  assert.equal(getPlainTextRepresentation(decoded).data, " 👩🏽‍💻 \n");
});

const malformedPayloads: [string, unknown][] = [
  ["null root", null],
  ["array root", []],
  ["string root", "text"],
  ["numeric root", 1],
  ["boolean root", true],
  ["empty root", {}],
  [
    "unsupported version",
    { version: 2, representations: [plainRepresentation] },
  ],
  ["string version", { version: "1", representations: [plainRepresentation] }],
  ["missing version", { representations: [plainRepresentation] }],
  ["missing representations", { version: 1 }],
  ["null representations", { version: 1, representations: null }],
  [
    "object representations",
    { version: 1, representations: plainRepresentation },
  ],
  ["empty representations", { version: 1, representations: [] }],
  [
    "duplicate text/plain",
    { version: 1, representations: [plainRepresentation, plainRepresentation] },
  ],
  [
    "duplicate text/html",
    { version: 1, representations: [htmlRepresentation, htmlRepresentation] },
  ],
  [
    "missing plain fallback",
    { version: 1, representations: [htmlRepresentation] },
  ],
  [
    "unsupported MIME",
    {
      version: 1,
      representations: [
        plainRepresentation,
        { ...htmlRepresentation, mime: "image/png" },
      ],
    },
  ],
  [
    "unsupported encoding",
    {
      version: 1,
      representations: [{ ...plainRepresentation, encoding: "base64" }],
    },
  ],
  [
    "non-string data",
    { version: 1, representations: [{ ...plainRepresentation, data: 123 }] },
  ],
  [
    "null data",
    { version: 1, representations: [{ ...plainRepresentation, data: null }] },
  ],
  [
    "missing data",
    {
      version: 1,
      representations: [{ mime: "text/plain", encoding: "utf-8" }],
    },
  ],
  [
    "missing MIME",
    { version: 1, representations: [{ encoding: "utf-8", data: "text" }] },
  ],
  [
    "missing encoding",
    { version: 1, representations: [{ mime: "text/plain", data: "text" }] },
  ],
  ["null representation", { version: 1, representations: [null] }],
  ["array representation", { version: 1, representations: [[]] }],
  ["string representation", { version: 1, representations: ["text"] }],
  [
    "unexpected root field",
    { version: 1, representations: [plainRepresentation], extra: true },
  ],
  [
    "unexpected representation field",
    { version: 1, representations: [{ ...plainRepresentation, extra: true }] },
  ],
  [
    "excessive representations",
    {
      version: 1,
      representations: [
        plainRepresentation,
        htmlRepresentation,
        htmlRepresentation,
      ],
    },
  ],
];

for (const [name, value] of malformedPayloads) {
  test(`strict codec rejects ${name}`, () => {
    assert.throws(() => decodeClipboardBundleV1(serialized(value)));
    assert.throws(() => encodeClipboardBundleV1(value as ClipboardPayloadV1));
    assert.throws(() => validateClipboardPayloadV1(value));
  });
}

test("model validation rejects unexpected symbol fields and sparse representations", () => {
  const withSymbol = {
    ...clipboardPayloadFromPlainText("text"),
    [Symbol("extra")]: true,
  };
  assert.throws(() => validateClipboardPayloadV1(withSymbol));
  assert.throws(() =>
    validateClipboardPayloadV1({ version: 1, representations: new Array(1) }),
  );
  assert.throws(() =>
    getPlainTextRepresentation({ version: 1, representations: [] }),
  );
  assert.throws(() => clipboardPayloadFromPlainText(null as unknown as string));
});

test("strict bundle decoder rejects malformed JSON and extraneous JSON values", () => {
  for (const text of [
    "",
    "{",
    '{"version":1,}',
    "undefined",
    "{} {}",
    '\ufeff{"version":1,"representations":[]}',
  ]) {
    assert.throws(() => decodeClipboardBundleV1(encoder.encode(text)));
  }
});

test("bundle and legacy decoding reject malformed UTF-8 without replacement", () => {
  const malformedSequences = [
    [0xff],
    [0xc3, 0x28],
    [0xe2, 0x82],
    [0xc0, 0xaf],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
  ];
  const prefix = encoder.encode(
    '{"version":1,"representations":[{"mime":"text/plain","encoding":"utf-8","data":"',
  );
  const suffix = encoder.encode('"}]}');
  for (const sequence of malformedSequences) {
    assert.throws(() => decodeClipboardPlainText(new Uint8Array(sequence)));
    assert.throws(() =>
      decodeClipboardBundleV1(
        new Uint8Array([...prefix, ...sequence, ...suffix]),
      ),
    );
  }
  // A failed decode must not affect subsequent independent items.
  assert.equal(
    getPlainTextRepresentation(
      decodeClipboardPlainText(encoder.encode("valid")),
    ).data,
    "valid",
  );
});

test("safe plaintext byte maximum reserves exactly the AES-GCM authentication tag", () => {
  assert.equal(MAX_CLIPBOARD_CIPHERTEXT_BYTES, 1_048_576);
  assert.equal(AES_GCM_TAG_BYTES, 16);
  assert.equal(MAX_CLIPBOARD_PLAINTEXT_BYTES, 1_048_560);
  assert.equal(MAX_CLIPBOARD_TEXT_BYTES, MAX_CLIPBOARD_PLAINTEXT_BYTES);
  assert.equal(
    MAX_CLIPBOARD_PLAINTEXT_BYTES + AES_GCM_TAG_BYTES,
    MAX_CLIPBOARD_CIPHERTEXT_BYTES,
  );
});

test("legacy plain text accepts its exact byte boundary and rejects one byte over", () => {
  const exact = "x".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES);
  const payload = clipboardPayloadFromPlainText(exact);
  validateClipboardPayloadV1(payload);
  assert.equal(getPlainTextRepresentation(payload).data, exact);
  assert.equal(isClipboardText(exact), true);
  assert.equal(
    getPlainTextRepresentation(decodeClipboardPlainText(encoder.encode(exact)))
      .data,
    exact,
  );
  assert.throws(() => clipboardPayloadFromPlainText(`${exact}x`));
  assert.throws(() => decodeClipboardPlainText(encoder.encode(`${exact}x`)));
  assert.equal(isClipboardText(`${exact}x`), false);
  assert.equal(isClipboardText(123), false);
  // Raw text at its limit remains publishable, but cannot fit in bundle JSON.
  assert.throws(() => encodeClipboardBundleV1(payload));
});

test("legacy text limits use UTF-8 bytes rather than UTF-16 string length", () => {
  const exact = "🧑".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES / 4);
  assert.ok(exact.length < MAX_CLIPBOARD_PLAINTEXT_BYTES);
  assert.equal(encoder.encode(exact).byteLength, MAX_CLIPBOARD_PLAINTEXT_BYTES);
  assert.equal(
    getPlainTextRepresentation(clipboardPayloadFromPlainText(exact)).data,
    exact,
  );
  assert.equal(isClipboardText(exact), true);
  assert.throws(() => clipboardPayloadFromPlainText(`${exact}é`));
  assert.equal(isClipboardText(`${exact}é`), false);
  assert.throws(() => decodeClipboardPlainText(encoder.encode(`${exact}é`)));
});

test("bundle serialization accepts its exact byte boundary and rejects one byte over", () => {
  const emptyBytes = encodeClipboardBundleV1(clipboardPayloadFromPlainText(""));
  const exactText = "x".repeat(
    MAX_CLIPBOARD_PLAINTEXT_BYTES - emptyBytes.byteLength,
  );
  const payload = clipboardPayloadFromPlainText(exactText);
  const bytes = encodeClipboardBundleV1(payload);
  assert.equal(bytes.byteLength, MAX_CLIPBOARD_PLAINTEXT_BYTES);
  assert.deepEqual(decodeClipboardBundleV1(bytes), payload);
  const oversized = clipboardPayloadFromPlainText(`${exactText}x`);
  assert.throws(() => encodeClipboardBundleV1(oversized));
  assert.throws(() => decodeClipboardBundleV1(serialized(oversized)));
});

test("serialized size includes JSON escaping, HTML and multibyte content", () => {
  const withEscapes = clipboardPayloadFromPlainText(
    "\n".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES / 2),
  );
  assert.ok(
    getPlainTextRepresentation(withEscapes).data.length <
      MAX_CLIPBOARD_PLAINTEXT_BYTES,
  );
  assert.throws(() => encodeClipboardBundleV1(withEscapes));
  assert.throws(() => decodeClipboardBundleV1(serialized(withEscapes)));

  const withHtml: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      {
        mime: "text/plain",
        encoding: "utf-8",
        data: "x".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES / 2),
      },
      {
        mime: "text/html",
        encoding: "utf-8",
        data: "x".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES / 2),
      },
    ],
  };
  validateClipboardPayloadV1(withHtml);
  assert.throws(() => encodeClipboardBundleV1(withHtml));
  assert.throws(() => decodeClipboardBundleV1(serialized(withHtml)));

  const emptyBytes = encodeClipboardBundleV1(clipboardPayloadFromPlainText(""));
  const availableDataBytes =
    MAX_CLIPBOARD_PLAINTEXT_BYTES - emptyBytes.byteLength;
  const exactText =
    "🧑".repeat(Math.floor(availableDataBytes / 4)) +
    "x".repeat(availableDataBytes % 4);
  assert.equal(
    encodeClipboardBundleV1(clipboardPayloadFromPlainText(exactText))
      .byteLength,
    MAX_CLIPBOARD_PLAINTEXT_BYTES,
  );
  assert.throws(() =>
    encodeClipboardBundleV1(clipboardPayloadFromPlainText(`${exactText}é`)),
  );
});
