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
import { createRuntimeMessageListener } from "./runtime/service-worker-bootstrap.ts";
import { RUNTIME_ERROR_CODES, type RuntimeErrorCode } from "./runtime/errors.ts";
import {
  CONNECTIVITY_RECOVERY_ALARM_NAME,
  CONNECTIVITY_RECOVERY_PERIOD_MINUTES,
  isLateConnectivityRecoveryAlarm,
} from "./runtime/connectivity-recovery.ts";
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
  recoveryAlarm: {
    ensure: () =>
      chrome.alarms.create(CONNECTIVITY_RECOVERY_ALARM_NAME, {
        periodInMinutes: CONNECTIVITY_RECOVERY_PERIOD_MINUTES,
      }),
    clear: async () => {
      await chrome.alarms.clear(CONNECTIVITY_RECOVERY_ALARM_NAME);
    },
  },
});

let startupError: unknown = null;

if (import.meta.env.DEV) {
  console.info("COPYyt service worker starting");
}

const runtimeReady = runtime.start().then(
  () => {
    if (import.meta.env.DEV) {
      console.info("COPYyt service worker ready");
    }
  },
  (error: unknown) => {
    startupError = error;
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const errorCode =
      error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" &&
      RUNTIME_ERROR_CODES.includes(error.code as RuntimeErrorCode)
        ? ` (${error.code})`
        : "";
    console.error(
      `COPYyt service worker startup failed ${errorName}${errorCode}`,
    );
  },
);

// Register synchronously during module evaluation. Alarms are wake events,
// not a clipboard poller or a service-worker keepalive.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CONNECTIVITY_RECOVERY_ALARM_NAME) return;
  const resumeDetected = isLateConnectivityRecoveryAlarm(alarm);
  void runtimeReady
    .then(async () => {
      if (!runtime.hasAuthenticatedSession()) {
        await Promise.resolve(
          chrome.alarms.clear(CONNECTIVITY_RECOVERY_ALARM_NAME),
        ).catch(() => undefined);
        return;
      }
      await runtime.reconcileConnectivity(
        resumeDetected ? "sleep-wake" : "recovery-alarm",
        {
          forceSocketRecycle: resumeDetected,
        },
      );
    })
    .catch((error: unknown) => {
      // Connectivity failures are expected after wake and are represented in
      // runtime status. Keep the alarm event free of rejected promises.
      if (import.meta.env.DEV) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        console.info(`COPYyt recovery alarm deferred (${errorName})`);
      }
    });
});

// Register synchronously during module evaluation. The listener keeps the
// channel open while the single startup promise restores the runtime.
chrome.runtime.onMessage.addListener(
  createRuntimeMessageListener({
    runtime,
    runtimeReady,
    getStartupError: () => startupError,
    runtimeId: chrome.runtime.id,
    extensionUrl: chrome.runtime.getURL(""),
  }),
);
