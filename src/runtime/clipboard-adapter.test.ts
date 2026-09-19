import assert from "node:assert/strict";
import test from "node:test";
import {
  clipboardPayloadFromPlainText,
  type ClipboardPayloadV1,
} from "../clipboard/payload.ts";
import {
  isOffscreenRequest,
  type OffscreenRequest,
  type OffscreenResponse,
} from "./messages.ts";
import { OffscreenClipboardAdapter } from "./clipboard-adapter.ts";

const richPayload: ClipboardPayloadV1 = {
  version: 1,
  representations: [
    { mime: "text/plain", encoding: "utf-8", data: "plain" },
    { mime: "text/html", encoding: "utf-8", data: "<b>plain</b>" },
  ],
};

function response(
  request: OffscreenRequest,
  type: OffscreenResponse["type"],
  extra: Partial<OffscreenResponse> = {},
): OffscreenResponse {
  return {
    source: "offscreen",
    target: "service-worker",
    requestId: request.requestId,
    type,
    ...extra,
  };
}

function adapterFor(
  handler: (request: OffscreenRequest) => OffscreenResponse,
): { adapter: OffscreenClipboardAdapter; requests: OffscreenRequest[] } {
  const requests: OffscreenRequest[] = [];
  const runtime = {
    sendMessage: async (message: unknown) => {
      assert.equal(isOffscreenRequest(message), true);
      const request = message as OffscreenRequest;
      requests.push(request);
      return handler(request);
    },
  };
  return {
    adapter: new OffscreenClipboardAdapter(
      { runtime },
      async () => undefined,
    ),
    requests,
  };
}

test("READ_PAYLOAD and READ_TEXT use the typed payload result", async () => {
  const { adapter, requests } = adapterFor((request) =>
    response(request, "READ_PAYLOAD_RESULT", { payload: richPayload }),
  );
  assert.deepEqual(await adapter.readPayload(), richPayload);
  assert.equal(await adapter.readText(), "plain");
  assert.deepEqual(
    requests.map((request) => request.type),
    ["READ_PAYLOAD", "READ_PAYLOAD"],
  );
});

test("WRITE_PAYLOAD and legacy writeText send strict typed payloads", async () => {
  const { adapter, requests } = adapterFor((request) =>
    response(
      request,
      "WRITE_PAYLOAD_RESULT",
      { payload: request.payload },
    ),
  );
  await adapter.writePayload!(richPayload);
  await adapter.writeText("legacy");
  assert.deepEqual(requests[0].payload, richPayload);
  assert.deepEqual(requests[1].payload, clipboardPayloadFromPlainText("legacy"));
});

test("malformed payloads and malformed response envelopes are rejected", async () => {
  let calls = 0;
  const { adapter } = adapterFor((request) => {
    calls += 1;
    return response(request, "READ_PAYLOAD_RESULT", { payload: undefined });
  });
  await assert.rejects(
    adapter.writePayload!({ version: 1, representations: [] }),
  );
  await assert.rejects(adapter.readPayload());
  assert.equal(calls, 1);
});

test("request and response source/target/requestId validation remains enforced", async () => {
  const requests: unknown[] = [];
  const adapter = new OffscreenClipboardAdapter(
    {
      runtime: {
        sendMessage: async (request) => {
          requests.push(request);
          return {
            source: "other-context",
            target: "service-worker",
            requestId: (request as OffscreenRequest).requestId,
            type: "READ_PAYLOAD_RESULT",
            payload: richPayload,
          };
        },
      },
    },
    async () => undefined,
  );
  await assert.rejects(adapter.readPayload());
  assert.equal(requests.length, 1);
});

test("legacy watcher controls and ping remain functional", async () => {
  const { adapter, requests } = adapterFor((request) => {
    if (request.type === "PING") return response(request, "PONG");
    if (request.type === "WATCH_START") {
      return response(request, "WATCH_START_RESULT");
    }
    return response(request, "WATCH_STOP_RESULT");
  });
  await adapter.ping();
  await adapter.startWatching({ resetBaseline: true });
  await adapter.stopWatching();
  assert.deepEqual(
    requests.map((request) => request.type),
    ["PING", "WATCH_START", "WATCH_STOP"],
  );
});
