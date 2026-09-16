import { io, type Socket } from "socket.io-client";
import { IndexedDBTrustStore } from "./crypto/trust-store.ts";
import { createRuntimeApi } from "./runtime/api.ts";
import { OffscreenClipboardAdapter } from "./runtime/clipboard-adapter.ts";
import { IndexedDBOutboundItemStore, IndexedDBProcessedItemStore } from "./runtime/runtime-db.ts";
import {
  ChromeSessionStore,
  ChromeStatusStore,
} from "./runtime/session-store.ts";
import {
  CopyytServiceWorkerRuntime,
  type SocketLike,
  type SocketOptions,
} from "./runtime/service-worker-runtime.ts";
import { isRuntimeRequest, RUNTIME_SOURCE, POPUP_SOURCE, type RuntimeRequest } from "./runtime/messages.ts";
import { SOCKET_URL } from "./utils/constants.ts";

function socketFactory(url: string, options: SocketOptions): SocketLike {
  return io(url, options) as unknown as Socket;
}

const runtime = new CopyytServiceWorkerRuntime({
  socketUrl: SOCKET_URL,
  appVersion: "1.2",
  sessionStore: new ChromeSessionStore(),
  statusStore: new ChromeStatusStore(),
  trustStore: new IndexedDBTrustStore(),
  clipboardAdapter: new OffscreenClipboardAdapter(),
  processedItemStore: new IndexedDBProcessedItemStore(),
  outboundItemStore: new IndexedDBOutboundItemStore(),
  apiFactory: createRuntimeApi,
  socketFactory,
  broadcastStatus: (message) =>
    chrome.runtime.sendMessage(message).catch(() => undefined),
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (
    !isRuntimeRequest(message) ||
    sender.id !== chrome.runtime.id ||
    (sender.url !== undefined && !sender.url.startsWith(chrome.runtime.getURL("")))
  ) {
    return false;
  }
  void runtime.handleMessage(message).then(sendResponse).catch((error: unknown) => {
    sendResponse({
      source: RUNTIME_SOURCE,
      target: POPUP_SOURCE,
      requestId: (message as RuntimeRequest).requestId,
      ok: false,
      error: { code: "AUTH_REQUIRED", message: "The runtime operation failed" },
    });
    void error;
  });
  return true;
});

void runtime.start();
