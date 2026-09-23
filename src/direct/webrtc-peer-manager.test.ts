import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECT_BUFFER_HIGH_WATER,
  DIRECT_CHUNK_SIZE,
  DIRECT_DATA_CHANNEL_LABEL,
  DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE,
  DIRECT_APPLICATION_MAX_FRAME_BYTES,
  DIRECT_CLIPBOARD_CONTENT_TYPE,
  DIRECT_CLIPBOARD_PROTOCOL,
  DIRECT_TEST_PAYLOAD_BYTES,
  deterministicTestBytes,
  sha256Hex,
  type DirectManagerEvent,
} from "./protocol.ts";
import { base64ToBytes, bytesToBase64 } from "../crypto/bytes.ts";
import {
  WebRtcPeerManager,
  type DataChannelLike,
  type PeerConnectionLike,
} from "./webrtc-peer-manager.ts";

const sourceDeviceId = "7d8a7f8f-3b6a-4d45-bf59-8f9c6dd6c2a1";
const recipientDeviceId = "4e9cc7a0-2cbf-4d13-b5bd-4e3b4f1cf6a7";
const otherSourceDeviceId = "0c2f3a0e-4a23-4b83-91ad-5e9ed6a7b8c9";
const transferId = "b8a3df60-5d4c-4c48-8c56-efb31fdb71bc";

class FakeChannel implements DataChannelLike {
  label: string;
  readyState = "connecting";
  binaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  remote: FakeChannel | null = null;
  sent: Array<string | ArrayBuffer> = [];
  backpressureWaits = 0;
  deferredControlTypes = new Set<string>();
  deferredControls: string[] = [];
  sendError: Error | null = null;
  closeCalls = 0;
  binarySendCount = 0;
  closeAfterBinarySendCount: number | null = null;

  constructor(label: string) {
    this.label = label;
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  send(data: string | ArrayBuffer): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
    if (typeof data === "string") {
      const type = (JSON.parse(data) as { type?: unknown }).type;
      if (typeof type === "string" && this.deferredControlTypes.has(type)) {
        this.deferredControls.push(data);
        return;
      }
    }
    if (data instanceof ArrayBuffer) {
      this.binarySendCount += 1;
    }
    if (data instanceof ArrayBuffer && this.sent.length === 2) {
      this.bufferedAmount = DIRECT_BUFFER_HIGH_WATER + 1;
      this.backpressureWaits += 1;
      setTimeout(() => {
        this.bufferedAmount = 0;
        this.onbufferedamountlow?.();
      }, 0);
    }
    const remote = this.remote;
    if (remote) {
      const delivered = typeof data === "string" ? data : data.slice(0);
      queueMicrotask(() => remote.onmessage?.({ data: delivered }));
    }
    if (
      data instanceof ArrayBuffer &&
      this.closeAfterBinarySendCount === this.binarySendCount
    ) {
      queueMicrotask(() => this.close());
    }
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.closeCalls += 1;
    this.readyState = "closed";
    this.onclose?.();
    if (this.remote && this.remote.readyState !== "closed") {
      this.remote.close();
    }
  }

  releaseDeferredControl(type: string): void {
    const index = this.deferredControls.findIndex(
      (control) => (JSON.parse(control) as { type?: unknown }).type === type,
    );
    assert.notEqual(index, -1);
    const control = this.deferredControls.splice(index, 1)[0];
    const remote = this.remote;
    if (remote) queueMicrotask(() => remote.onmessage?.({ data: control }));
  }
}

function clipboardManifest(
  plaintextByteLength = 123,
  expiresAtMs = Date.now() + 60_000,
  chunkCount = 1,
): {
  manifest: string;
  plaintextByteLength: number;
} {
  return {
    manifest: JSON.stringify({
      type: "clipboard-secure-start",
      protocol: DIRECT_CLIPBOARD_PROTOCOL,
      transferId,
      userId: "11111111-1111-4111-8111-111111111111",
      sourceDeviceId,
      sourceKeyVersion: 1,
      recipientDeviceId,
      recipientKeyVersion: 1,
      contentType: DIRECT_CLIPBOARD_CONTENT_TYPE,
      expiresAt: new Date(expiresAtMs).toISOString(),
      plaintextByteLength,
      chunkPlaintextSize: DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE,
      chunkCount,
      noncePrefix: bytesToBase64(new Uint8Array(8)),
      wrapNonce: bytesToBase64(new Uint8Array(12)),
      wrappedKey: bytesToBase64(new Uint8Array(48)),
      sourceSignature: bytesToBase64(new Uint8Array(64)),
    }),
    plaintextByteLength,
  };
}

class FakePeerConnection implements PeerConnectionLike {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState = "new";
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  private onDataChannel:
    | ((event: { channel: DataChannelLike }) => void)
    | null = null;
  pendingRemoteChannel: FakeChannel | null = null;
  receivedDataChannel: FakeChannel | null = null;
  onconnectionstatechange: (() => void) | null = null;
  dataChannel: FakeChannel | null = null;
  addedIceCandidates: unknown[] = [];
  closeCalls = 0;

  set ondatachannel(
    listener: ((event: { channel: DataChannelLike }) => void) | null,
  ) {
    this.onDataChannel = listener;
    if (listener && this.pendingRemoteChannel) {
      this.receivedDataChannel = this.pendingRemoteChannel;
      listener({ channel: this.pendingRemoteChannel });
      this.pendingRemoteChannel = null;
    }
  }

  get ondatachannel(): ((event: { channel: DataChannelLike }) => void) | null {
    return this.onDataChannel;
  }

  createDataChannel(label: string): DataChannelLike {
    this.dataChannel = new FakeChannel(label);
    return this.dataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "answer-sdp" };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    this.addedIceCandidates.push(candidate);
    return undefined;
  }

  close(): void {
    this.closeCalls += 1;
    this.connectionState = "closed";
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for direct transfer condition");
}

async function createConnectedTransfer(
  options: {
    deferVerified?: boolean;
    deferVerifiedAck?: boolean;
    transferTimeoutMs?: number;
    cleanupTimeoutMs?: number;
  } = {},
): Promise<{
  managerA: WebRtcPeerManager;
  managerB: WebRtcPeerManager;
  initiatorEvents: DirectManagerEvent[];
  responderEvents: DirectManagerEvent[];
  initiatorPeer: FakePeerConnection;
  responderPeer: FakePeerConnection;
  initiatorChannel: FakeChannel;
  responderChannel: FakeChannel;
}> {
  const initiatorEvents: DirectManagerEvent[] = [];
  const responderEvents: DirectManagerEvent[] = [];
  const peers: FakePeerConnection[] = [];
  const managerA = new WebRtcPeerManager({
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      if (peers.length === 2 && peers[0]?.dataChannel) {
        const remote = new FakeChannel(DIRECT_DATA_CHANNEL_LABEL);
        remote.deferredControlTypes = new Set(
          [options.deferVerified ? "verified" : null].filter(
            (type): type is string => type !== null,
          ),
        );
        if (options.deferVerifiedAck) {
          peers[0].dataChannel.deferredControlTypes.add("verified-ack");
        }
        peers[0].dataChannel.remote = remote;
        remote.remote = peers[0].dataChannel;
        peer.pendingRemoteChannel = remote;
      }
      return peer;
    },
    emit: (event) => {
      initiatorEvents.push(event);
    },
    transferTimeoutMs: options.transferTimeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
  });
  const managerB = new WebRtcPeerManager({
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      if (peers.length === 2 && peers[0]?.dataChannel) {
        const remote = new FakeChannel(DIRECT_DATA_CHANNEL_LABEL);
        remote.deferredControlTypes = new Set(
          [options.deferVerified ? "verified" : null].filter(
            (type): type is string => type !== null,
          ),
        );
        if (options.deferVerifiedAck) {
          peers[0].dataChannel.deferredControlTypes.add("verified-ack");
        }
        peers[0].dataChannel.remote = remote;
        remote.remote = peers[0].dataChannel;
        peer.pendingRemoteChannel = remote;
      }
      return peer;
    },
    emit: (event) => {
      responderEvents.push(event);
    },
    transferTimeoutMs: options.transferTimeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
  });

  await managerA.startTestTransfer({
    transferId,
    remoteDeviceId: recipientDeviceId,
  });
  const offer = initiatorEvents.find(
    (event): event is Extract<DirectManagerEvent, { kind: "signal" }> =>
      event.kind === "signal" && event.signal.kind === "offer",
  );
  assert.ok(offer);
  await managerB.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "offer",
    sdp: offer.signal.sdp,
  });
  const answer = responderEvents.find(
    (event): event is Extract<DirectManagerEvent, { kind: "signal" }> =>
      event.kind === "signal" && event.signal.kind === "answer",
  );
  assert.ok(answer);
  await managerA.handleSignal({
    transferId,
    sourceDeviceId: recipientDeviceId,
    sourceKeyVersion: 1,
    kind: "answer",
    sdp: answer.signal.sdp,
  });

  const initiatorPeer = peers[0];
  const responderPeer = peers[1];
  const initiatorChannel = initiatorPeer?.dataChannel;
  const responderChannel = responderPeer?.receivedDataChannel;
  assert.ok(initiatorPeer);
  assert.ok(responderPeer);
  assert.ok(initiatorChannel);
  assert.ok(responderChannel);
  responderChannel.open();
  initiatorChannel.open();
  return {
    managerA,
    managerB,
    initiatorEvents,
    responderEvents,
    initiatorPeer,
    responderPeer,
    initiatorChannel,
    responderChannel,
  };
}

async function createConnectedClipboardTransfer(
  options: {
    transferTimeoutMs?: number;
    cleanupTimeoutMs?: number;
    now?: () => Date;
    expiresAtMs?: number;
    encryptedChunks?: string[];
    plaintextByteLength?: number;
    delayFinalProgress?: boolean;
    deferFinalApplicationFrame?: boolean;
    closeInitiatorAfterBinarySendCount?: number;
  } = {},
): Promise<{
  managerA: WebRtcPeerManager;
  managerB: WebRtcPeerManager;
  initiatorEvents: DirectManagerEvent[];
  responderEvents: DirectManagerEvent[];
  initiatorChannel: FakeChannel;
  responderChannel: FakeChannel;
  expectedPlaintextByteLength: number;
  releaseFinalProgress?: () => void;
  releaseFinalApplicationFrame?: () => void;
}> {
  const initiatorEvents: DirectManagerEvent[] = [];
  const responderEvents: DirectManagerEvent[] = [];
  const peers: FakePeerConnection[] = [];
  const encryptedChunks = options.encryptedChunks ?? [
    bytesToBase64(new Uint8Array([0, 0, 0, 0, 1, 2, 3])),
  ];
  const plaintextByteLength = options.plaintextByteLength ?? 123;
  const packageToSend = clipboardManifest(
    plaintextByteLength,
    options.expiresAtMs ?? (options.now?.() ?? new Date()).getTime() + 60_000,
    encryptedChunks.length,
  );
  let releaseFinalProgress: (() => void) | undefined;
  let resolveFinalProgress: (() => void) | undefined;
  let finalProgressGate: Promise<void> | undefined;
  if (options.delayFinalProgress) {
    finalProgressGate = new Promise<void>((resolve) => {
      resolveFinalProgress = resolve;
    });
    releaseFinalProgress = () => resolveFinalProgress?.();
  }
  let releaseFinalApplicationFrame: (() => void) | undefined;
  let resolveFinalApplicationFrame: (() => void) | undefined;
  let finalApplicationFrameGate: Promise<void> | undefined;
  if (options.deferFinalApplicationFrame) {
    finalApplicationFrameGate = new Promise<void>((resolve) => {
      resolveFinalApplicationFrame = resolve;
    });
    releaseFinalApplicationFrame = () => resolveFinalApplicationFrame?.();
  }
  const managerA = new WebRtcPeerManager({
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      if (peers.length === 2 && peers[0]?.dataChannel) {
        const remote = new FakeChannel(DIRECT_DATA_CHANNEL_LABEL);
        peers[0].dataChannel.remote = remote;
        remote.remote = peers[0].dataChannel;
        peer.pendingRemoteChannel = remote;
      }
      return peer;
    },
    emit: (event) => {
      initiatorEvents.push(event);
      if (
        finalProgressGate &&
        event.kind === "status" &&
        event.state === "sending" &&
        event.bytesSent !== undefined &&
        event.byteLength !== undefined &&
        event.bytesSent === event.byteLength
      ) {
        return finalProgressGate;
      }
    },
    now: options.now,
    transferTimeoutMs: options.transferTimeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
  });
  const managerB = new WebRtcPeerManager({
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      if (peers.length === 2 && peers[0]?.dataChannel) {
        const remote = new FakeChannel(DIRECT_DATA_CHANNEL_LABEL);
        peers[0].dataChannel.remote = remote;
        remote.remote = peers[0].dataChannel;
        peer.pendingRemoteChannel = remote;
      }
      return peer;
    },
    emit: async (event) => {
      responderEvents.push(event);
      if (
        finalApplicationFrameGate &&
        event.kind === "application-frame" &&
        event.frame.type === "clipboard-secure-chunk" &&
        responderEvents.filter(
          (candidate) =>
            candidate.kind === "application-frame" &&
            candidate.frame.type === "clipboard-secure-chunk",
        ).length === encryptedChunks.length
      ) {
        await managerB.sendClipboardVerified({
          transferId,
          plaintextByteLength: packageToSend.plaintextByteLength,
        });
        await finalApplicationFrameGate;
      }
    },
    now: options.now,
    transferTimeoutMs: options.transferTimeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
  });
  await managerA.startClipboardTransfer({
    transferId,
    remoteDeviceId: recipientDeviceId,
    manifest: packageToSend.manifest,
    encryptedChunks,
  });
  const offer = initiatorEvents.find(
    (event): event is Extract<DirectManagerEvent, { kind: "signal" }> =>
      event.kind === "signal" && event.signal.kind === "offer",
  );
  assert.ok(offer);
  await managerB.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "offer",
    sdp: offer.signal.sdp,
  });
  const answer = responderEvents.find(
    (event): event is Extract<DirectManagerEvent, { kind: "signal" }> =>
      event.kind === "signal" && event.signal.kind === "answer",
  );
  assert.ok(answer);
  await managerA.handleSignal({
    transferId,
    sourceDeviceId: recipientDeviceId,
    sourceKeyVersion: 1,
    kind: "answer",
    sdp: answer.signal.sdp,
  });
  const initiatorChannel = peers[0]?.dataChannel;
  const responderChannel = peers[1]?.receivedDataChannel;
  assert.ok(initiatorChannel);
  assert.ok(responderChannel);
  responderChannel.open();
  if (options.closeInitiatorAfterBinarySendCount !== undefined) {
    initiatorChannel.closeAfterBinarySendCount =
      options.closeInitiatorAfterBinarySendCount;
  }
  initiatorChannel.open();
  await waitFor(
    () =>
      responderEvents.some(
        (event) =>
          event.kind === "application-frame" &&
          event.frame.type === "clipboard-secure-start",
      ),
  );
  return {
    managerA,
    managerB,
    initiatorEvents,
    responderEvents,
    initiatorChannel,
    responderChannel,
    expectedPlaintextByteLength: packageToSend.plaintextByteLength,
    releaseFinalProgress,
    releaseFinalApplicationFrame,
  };
}

function hasStatus(
  events: DirectManagerEvent[],
  state: Extract<DirectManagerEvent, { kind: "status" }>["state"],
): boolean {
  return events.some(
    (event) => event.kind === "status" && event.state === state,
  );
}

function countStatus(
  events: DirectManagerEvent[],
  state: Extract<DirectManagerEvent, { kind: "status" }>["state"],
): number {
  return events.filter(
    (event) => event.kind === "status" && event.state === state,
  ).length;
}

function hasApplicationFrame(
  events: DirectManagerEvent[],
  type: "clipboard-secure-start" | "clipboard-secure-chunk",
): boolean {
  return events.some(
    (event) => event.kind === "application-frame" && event.frame.type === type,
  );
}

test("direct test bytes are deterministic and hashable", async () => {
  const first = deterministicTestBytes(transferId);
  const second = deterministicTestBytes(transferId);
  assert.equal(first.byteLength, DIRECT_TEST_PAYLOAD_BYTES);
  assert.deepEqual(first, second);
  assert.match(await sha256Hex(first), /^[0-9a-f]{64}$/);
});

test("peer manager queues ICE until the offer creates its peer", async () => {
  const events: DirectManagerEvent[] = [];
  const peers: FakePeerConnection[] = [];
  const manager = new WebRtcPeerManager({
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer;
    },
    emit: (event) => {
      events.push(event);
    },
  });

  await manager.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "ice-candidate",
    candidate: { candidate: "candidate:1", sdpMLineIndex: 0 },
  });
  assert.equal(manager.size, 0);

  await manager.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "offer",
    sdp: "offer-sdp",
  });
  assert.equal(manager.size, 1);
  assert.equal(peers[0]?.remoteDescription?.type, "offer");
  assert.equal(
    events.some(
      (event) => event.kind === "signal" && event.signal.kind === "answer",
    ),
    true,
  );
  await manager.cancelAll();
});

test("pre-offer ICE queues remain bound to their original source device", async () => {
  let peer: FakePeerConnection | undefined;
  const manager = new WebRtcPeerManager({
    peerConnectionFactory: () => {
      peer = new FakePeerConnection();
      return peer;
    },
    emit: () => undefined,
  });

  await manager.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "ice-candidate",
    candidate: { candidate: "candidate:1", sdpMLineIndex: 0 },
  });
  await assert.rejects(
    manager.handleSignal({
      transferId,
      sourceDeviceId: otherSourceDeviceId,
      sourceKeyVersion: 1,
      kind: "cancel",
    }),
    /pending transfer/,
  );
  await assert.rejects(
    manager.handleSignal({
      transferId,
      sourceDeviceId: otherSourceDeviceId,
      sourceKeyVersion: 1,
      kind: "ice-candidate",
      candidate: { candidate: "candidate:2", sdpMLineIndex: 0 },
    }),
  );
  await assert.rejects(
    manager.handleSignal({
      transferId,
      sourceDeviceId: otherSourceDeviceId,
      sourceKeyVersion: 1,
      kind: "offer",
      sdp: "offer-sdp",
    }),
  );

  await manager.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "offer",
    sdp: "offer-sdp",
  });
  assert.equal(manager.size, 1);
  assert.equal(peer?.addedIceCandidates.length, 1);
  await manager.cancelAll();
});

test("mismatched active-transfer cancel leaves the transfer intact", async () => {
  const events: DirectManagerEvent[] = [];
  let peer: FakePeerConnection | undefined;
  const manager = new WebRtcPeerManager({
    peerConnectionFactory: () => {
      peer = new FakePeerConnection();
      peer.pendingRemoteChannel = new FakeChannel(DIRECT_DATA_CHANNEL_LABEL);
      return peer;
    },
    emit: (event) => {
      events.push(event);
    },
  });

  await manager.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "offer",
    sdp: "offer-sdp",
  });
  const channel = peer?.receivedDataChannel;
  assert.ok(peer);
  assert.ok(channel);

  await assert.rejects(
    manager.handleSignal({
      transferId,
      sourceDeviceId: otherSourceDeviceId,
      sourceKeyVersion: 1,
      kind: "cancel",
      reason: "forged cancellation",
    }),
    /transfer/,
  );
  assert.equal(manager.size, 1);
  assert.notEqual(peer.connectionState, "closed");
  assert.notEqual(channel.readyState, "closed");
  assert.equal(
    events.some(
      (event) =>
        event.kind === "status" &&
        event.state === "cancelled" &&
        event.remoteDeviceId === sourceDeviceId,
    ),
    false,
  );

  await manager.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "cancel",
    reason: "owner cancellation",
  });
  assert.equal(manager.size, 0);
  assert.equal(peer.connectionState, "closed");
  assert.equal(channel.readyState, "closed");
  assert.equal(
    events.some(
      (event) => event.kind === "status" && event.state === "cancelled",
    ),
    true,
  );
});

test("peer manager chunks the 2 MiB experiment and completes with verification", async () => {
  const initiatorEvents: DirectManagerEvent[] = [];
  const responderEvents: DirectManagerEvent[] = [];
  const peers: FakePeerConnection[] = [];
  const managerA = new WebRtcPeerManager({
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      if (peers.length === 2 && peers[0]?.dataChannel) {
        const remote = new FakeChannel(DIRECT_DATA_CHANNEL_LABEL);
        peers[0].dataChannel.remote = remote;
        remote.remote = peers[0].dataChannel;
        peer.pendingRemoteChannel = remote;
      }
      return peer;
    },
    emit: (event) => {
      initiatorEvents.push(event);
    },
  });
  const managerB = new WebRtcPeerManager({
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      if (peers.length === 2 && peers[0]?.dataChannel) {
        const remote = new FakeChannel(DIRECT_DATA_CHANNEL_LABEL);
        peers[0].dataChannel.remote = remote;
        remote.remote = peers[0].dataChannel;
        peer.pendingRemoteChannel = remote;
      }
      return peer;
    },
    emit: (event) => {
      responderEvents.push(event);
    },
  });

  await managerA.startTestTransfer({
    transferId,
    remoteDeviceId: recipientDeviceId,
  });
  const offer = initiatorEvents.find(
    (event): event is Extract<DirectManagerEvent, { kind: "signal" }> =>
      event.kind === "signal" && event.signal.kind === "offer",
  );
  assert.ok(offer);
  await managerB.handleSignal({
    transferId,
    sourceDeviceId: sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "offer",
    sdp: offer.signal.sdp,
  });
  const answer = responderEvents.find(
    (event): event is Extract<DirectManagerEvent, { kind: "signal" }> =>
      event.kind === "signal" && event.signal.kind === "answer",
  );
  assert.ok(answer);
  await managerA.handleSignal({
    transferId,
    sourceDeviceId: recipientDeviceId,
    sourceKeyVersion: 1,
    kind: "answer",
    sdp: answer.signal.sdp,
  });
  const initiatorChannel = peers[0]?.dataChannel;
  const responderChannel = peers[1]?.receivedDataChannel;
  assert.ok(initiatorChannel);
  assert.ok(responderChannel);
  responderChannel.open();
  initiatorChannel.open();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(
    initiatorEvents.some(
      (event) => event.kind === "status" && event.state === "succeeded",
    ),
    true,
  );

  const binaryChunks = initiatorChannel.sent.filter(
    (message): message is ArrayBuffer => message instanceof ArrayBuffer,
  );
  assert.equal(
    binaryChunks.length,
    Math.ceil(DIRECT_TEST_PAYLOAD_BYTES / DIRECT_CHUNK_SIZE),
  );
  assert.ok(
    binaryChunks.every((chunk) => chunk.byteLength <= DIRECT_CHUNK_SIZE),
  );
  assert.ok(initiatorChannel.backpressureWaits > 0);
  assert.equal(managerA.size, 0);
  assert.equal(managerB.size, 0);
});

test("initiator rejects verified clipboard length mismatches without success or ack", async () => {
  const harness = await createConnectedClipboardTransfer();
  await waitFor(() => hasApplicationFrame(harness.responderEvents, "clipboard-secure-chunk"));

  harness.initiatorChannel.onmessage?.({
    data: JSON.stringify({
      type: "clipboard-secure-verified",
      protocol: DIRECT_CLIPBOARD_PROTOCOL,
      transferId,
      plaintextByteLength: harness.expectedPlaintextByteLength + 1,
    }),
  });
  await waitFor(() => harness.managerA.size === 0);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 1);
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 0);
  assert.equal(
    harness.initiatorChannel.sent.some(
      (message) =>
        typeof message === "string" &&
        JSON.parse(message).type === "clipboard-secure-verified-ack",
    ),
    false,
  );
  await harness.managerB.cancelAll();
});

test("responder rejects a wrong clipboard verification length without sending", async () => {
  const harness = await createConnectedClipboardTransfer();
  await assert.rejects(
    harness.managerB.sendClipboardVerified({
      transferId,
      plaintextByteLength: harness.expectedPlaintextByteLength + 1,
    }),
    /byte length is invalid/,
  );
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 0);
  assert.equal(
    harness.responderChannel.sent.some(
      (message) =>
        typeof message === "string" &&
        JSON.parse(message).type === "clipboard-secure-verified",
    ),
    false,
  );
  await harness.managerA.cancelAll();
  await harness.managerB.cancelAll();
});

test("exact clipboard manifest length preserves verified success", async () => {
  const harness = await createConnectedClipboardTransfer();
  await harness.managerB.sendClipboardVerified({
    transferId,
    plaintextByteLength: harness.expectedPlaintextByteLength,
  });
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 0);
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);
});

test("clipboard sender accepts immediate final verification while final progress is delayed", async () => {
  const harness = await createConnectedClipboardTransfer({
    delayFinalProgress: true,
  });
  await waitFor(() => hasApplicationFrame(harness.responderEvents, "clipboard-secure-chunk"));

  await harness.managerB.sendClipboardVerified({
    transferId,
    plaintextByteLength: harness.expectedPlaintextByteLength,
  });
  await waitFor(() => hasStatus(harness.initiatorEvents, "succeeded"));

  assert.equal(countStatus(harness.initiatorEvents, "failed"), 0);
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);
  harness.releaseFinalProgress?.();
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
});

test("clipboard responder records the final frame before deferred application completion", async () => {
  const harness = await createConnectedClipboardTransfer({
    deferFinalApplicationFrame: true,
  });
  await waitFor(() => hasStatus(harness.responderEvents, "succeeded"));
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 0);

  const succeededIndex = harness.responderEvents.findIndex(
    (event) => event.kind === "status" && event.state === "succeeded",
  );
  assert.ok(succeededIndex >= 0);
  assert.equal(
    harness.responderEvents.slice(succeededIndex + 1).some(
      (event) =>
        event.kind === "status" &&
        (event.state === "receiving" || event.state === "sending"),
    ),
    false,
  );
  harness.releaseFinalApplicationFrame?.();
  await waitFor(() => harness.managerA.size === 0 && harness.managerB.size === 0);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 1);
});

test("large clipboard transfers preserve frame order, bounds, verification, and throttled progress", async () => {
  const encryptedChunks = Array.from({ length: 192 }, (_, index) => {
    const bytes = new Uint8Array(DIRECT_APPLICATION_MAX_FRAME_BYTES);
    new DataView(bytes.buffer).setUint32(0, index, false);
    return bytesToBase64(bytes);
  });
  const harness = await createConnectedClipboardTransfer({
    encryptedChunks,
    plaintextByteLength: encryptedChunks.length * DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE,
  });

  await waitFor(
    () =>
      harness.responderEvents.filter(
        (event) =>
          event.kind === "application-frame" &&
          event.frame.type === "clipboard-secure-chunk",
      ).length === encryptedChunks.length,
  );
  const receivedChunks = harness.responderEvents.flatMap((event) =>
    event.kind === "application-frame" &&
    event.frame.type === "clipboard-secure-chunk"
      ? [event.frame.data]
      : [],
  );
  assert.deepEqual(
    receivedChunks.map((data) => new DataView(base64ToBytes(data).buffer).getUint32(0, false)),
    encryptedChunks.map((_, index) => index),
  );
  const sentFrames = harness.initiatorChannel.sent.filter(
    (message): message is ArrayBuffer => message instanceof ArrayBuffer,
  );
  assert.equal(sentFrames.length, encryptedChunks.length);
  assert.ok(sentFrames.every((frame) => frame.byteLength <= DIRECT_APPLICATION_MAX_FRAME_BYTES));
  assert.ok(harness.initiatorChannel.backpressureWaits > 0);

  await harness.managerB.sendClipboardVerified({
    transferId,
    plaintextByteLength: harness.expectedPlaintextByteLength,
  });
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 0);
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 1);
  const progress = harness.responderEvents.filter(
    (event): event is Extract<DirectManagerEvent, { kind: "status" }> =>
      event.kind === "status" &&
      event.state === "receiving" &&
      event.bytesReceived !== undefined &&
      event.byteLength !== undefined,
  );
  assert.ok(progress.length > 0);
  for (let index = 1; index < progress.length; index += 1) {
    assert.ok(progress[index]!.bytesReceived! >= progress[index - 1]!.bytesReceived!);
  }
  assert.ok(progress.every((event) => event.bytesReceived! <= event.byteLength!));
  const finalProgress = progress[progress.length - 1]!;
  assert.equal(finalProgress.bytesReceived, finalProgress.byteLength);
  const sentProgress = harness.initiatorEvents.filter(
    (event): event is Extract<DirectManagerEvent, { kind: "status" }> =>
      event.kind === "status" &&
      event.state === "sending" &&
      event.bytesSent !== undefined &&
      event.byteLength !== undefined,
  );
  assert.ok(sentProgress.length > 0);
  for (let index = 1; index < sentProgress.length; index += 1) {
    assert.ok(sentProgress[index]!.bytesSent! >= sentProgress[index - 1]!.bytesSent!);
  }
  assert.ok(sentProgress.every((event) => event.bytesSent! <= event.byteLength!));
  const finalSentProgress = sentProgress[sentProgress.length - 1]!;
  assert.equal(finalSentProgress.bytesSent, finalSentProgress.byteLength);
  assert.ok(
    countStatus(harness.initiatorEvents, "sending") < encryptedChunks.length / 4,
  );
  assert.ok(hasStatus(harness.initiatorEvents, "sending"));
  assert.ok(hasStatus(harness.responderEvents, "receiving"));
});

test("clipboard receiver rejects a chunk beyond the signed manifest count", async () => {
  const harness = await createConnectedClipboardTransfer();
  await waitFor(
    () =>
      harness.responderEvents.filter(
        (event) =>
          event.kind === "application-frame" &&
          event.frame.type === "clipboard-secure-chunk",
      ).length === 1,
  );

  harness.initiatorChannel.send(new Uint8Array([4, 5, 6]).buffer);
  await waitFor(() => harness.managerB.size === 0);

  assert.equal(countStatus(harness.responderEvents, "succeeded"), 0);
  assert.equal(countStatus(harness.responderEvents, "failed"), 1);
});

test("mid-transfer clipboard channel failure cleans up without verification", async () => {
  const encryptedChunks = Array.from({ length: 32 }, (_, index) => {
    const bytes = new Uint8Array(7);
    new DataView(bytes.buffer).setUint32(0, index, false);
    bytes.set([index, index + 1, index + 2], 4);
    return bytesToBase64(bytes);
  });
  const harness = await createConnectedClipboardTransfer({
    encryptedChunks,
    closeInitiatorAfterBinarySendCount: 4,
  });

  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 0);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 0);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 1);
  assert.equal(countStatus(harness.responderEvents, "failed"), 1);
});

test("backpressure waiting rechecks a threshold transition during handler installation", async () => {
  const manager = new WebRtcPeerManager({
    peerConnectionFactory: () => new FakePeerConnection(),
    emit: () => undefined,
  });
  const channel = new FakeChannel(DIRECT_DATA_CHANNEL_LABEL);
  channel.readyState = "open";
  let reads = 0;
  Object.defineProperty(channel, "bufferedAmount", {
    configurable: true,
    get: () => {
      reads += 1;
      return reads >= 2 ? 0 : DIRECT_BUFFER_HIGH_WATER + 1;
    },
  });
  const waitForBufferLow = (
    manager as unknown as {
      waitForBufferLow: (value: DataChannelLike) => Promise<void>;
    }
  ).waitForBufferLow.bind(manager);

  await waitForBufferLow(channel);
  assert.equal(channel.onbufferedamountlow, null);
  assert.equal(channel.onclose, null);
});

test("clipboard transfers outlive the diagnostic timeout but stop at signed expiry", async () => {
  const nowMs = Date.now();
  const harness = await createConnectedClipboardTransfer({
    transferTimeoutMs: 25,
    now: () => new Date(nowMs),
    expiresAtMs: nowMs + 120,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(harness.managerA.size, 1);
  assert.equal(harness.managerB.size, 1);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 0);
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);

  await harness.managerB.sendClipboardVerified({
    transferId,
    plaintextByteLength: harness.expectedPlaintextByteLength,
  });
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 1);
});

test("clipboard transfer expiry is an absolute deadline", async () => {
  const nowMs = Date.now();
  const harness = await createConnectedClipboardTransfer({
    transferTimeoutMs: 250,
    now: () => new Date(nowMs),
    expiresAtMs: nowMs + 40,
  });
  await waitFor(() => harness.managerA.size === 0 && harness.managerB.size === 0);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 1);
  assert.equal(countStatus(harness.responderEvents, "failed"), 1);
  assert.equal(
    harness.initiatorEvents.some(
      (event) => event.kind === "status" && event.state === "failed" &&
        event.error === "Direct clipboard transfer expired",
    ),
    true,
  );
});

test("responder success survives a verification send failure", async () => {
  const harness = await createConnectedClipboardTransfer({
    transferTimeoutMs: 25,
  });
  harness.responderChannel.sendError = new Error("send failed");
  await harness.managerB.sendClipboardVerified({
    transferId,
    plaintextByteLength: harness.expectedPlaintextByteLength,
  });
  await waitFor(() => harness.managerB.size === 0);
  await waitFor(() => harness.managerA.size === 0);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 0);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 1);
});

test("responder success survives a channel closing before verification send", async () => {
  const harness = await createConnectedClipboardTransfer({
    transferTimeoutMs: 25,
  });
  harness.responderChannel.readyState = "closed";
  await harness.managerB.sendClipboardVerified({
    transferId,
    plaintextByteLength: harness.expectedPlaintextByteLength,
  });
  // The fake channel is manually closed and therefore cannot notify its
  // remote peer. Model the real peer-side close explicitly.
  harness.initiatorChannel.onerror?.();
  await waitFor(() => harness.managerB.size === 0);
  await waitFor(() => harness.managerA.size === 0);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 0);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 1);
});

test("responder success is final before the initiator receives verified", async () => {
  const harness = await createConnectedTransfer({
    deferVerified: true,
    cleanupTimeoutMs: 100,
  });

  await waitFor(() => hasStatus(harness.responderEvents, "succeeded"));
  assert.equal(harness.managerB.size, 1);
  assert.equal(harness.responderChannel.readyState, "open");
  assert.notEqual(harness.responderPeer.connectionState, "closed");
  harness.responderChannel.onerror?.();
  await waitFor(() => harness.managerB.size === 0);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);
});

test("initiator success survives a post-success data channel error", async () => {
  const harness = await createConnectedTransfer({ deferVerifiedAck: true });

  await waitFor(() => hasStatus(harness.initiatorEvents, "succeeded"));
  await waitFor(() => hasStatus(harness.responderEvents, "succeeded"));
  assert.equal(
    harness.initiatorChannel.deferredControls.some(
      (message) =>
        (JSON.parse(message) as { type?: unknown }).type === "verified-ack",
    ),
    true,
  );

  harness.initiatorChannel.onerror?.();
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 0);
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);
});

test("transport errors before initiator verification still fail", async () => {
  const harness = await createConnectedTransfer({ deferVerified: true });

  await waitFor(() => hasStatus(harness.responderEvents, "succeeded"));
  assert.equal(hasStatus(harness.initiatorEvents, "succeeded"), false);
  harness.initiatorChannel.onerror?.();
  await waitFor(() => harness.managerA.size === 0);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 1);
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 0);
});

test("responder transport errors before hash verification still fail", async () => {
  const harness = await createConnectedTransfer();

  harness.responderChannel.onerror?.();
  await waitFor(() => harness.managerB.size === 0);
  assert.equal(countStatus(harness.responderEvents, "failed"), 1);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 0);
});

test("verified-ack causes responder cleanup without a complete frame", async () => {
  const harness = await createConnectedTransfer({ deferVerifiedAck: true });

  await waitFor(() => hasStatus(harness.initiatorEvents, "succeeded"));
  await waitFor(() => hasStatus(harness.responderEvents, "succeeded"));
  assert.equal(
    [...harness.initiatorChannel.sent, ...harness.responderChannel.sent].some(
      (message) =>
        typeof message === "string" &&
        (JSON.parse(message) as { type?: unknown }).type === "complete",
    ),
    false,
  );
  assert.equal(harness.managerA.size, 1);
  assert.equal(harness.managerB.size, 1);

  harness.initiatorChannel.releaseDeferredControl("verified-ack");
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 0);
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);
});

test("verified-ack before responder verification is invalid", async () => {
  const harness = await createConnectedTransfer({ deferVerified: true });

  harness.responderChannel.onmessage?.({
    data: JSON.stringify({ type: "verified-ack", transferId }),
  });
  await waitFor(() => harness.managerB.size === 0);
  assert.equal(countStatus(harness.responderEvents, "failed"), 1);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 0);
});

test("disconnected initiator transfers remain active and recover before success", async () => {
  const harness = await createConnectedTransfer({ deferVerified: true });
  await waitFor(() => hasStatus(harness.responderEvents, "succeeded"));

  harness.initiatorPeer.connectionState = "disconnected";
  harness.initiatorPeer.onconnectionstatechange?.();
  assert.equal(harness.managerA.size, 1);
  assert.equal(hasStatus(harness.initiatorEvents, "succeeded"), false);
  assert.equal(hasStatus(harness.initiatorEvents, "failed"), false);

  harness.initiatorPeer.connectionState = "connected";
  harness.initiatorPeer.onconnectionstatechange?.();
  harness.responderChannel.releaseDeferredControl("verified");
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 0);
});

test("terminal handshake timeout cleans up when verified acknowledgement never arrives", async () => {
  const harness = await createConnectedTransfer({
    deferVerified: true,
    transferTimeoutMs: 250,
  });
  await waitFor(() => hasStatus(harness.responderEvents, "verified"));
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(hasStatus(harness.responderEvents, "succeeded"), true);
  assert.equal(hasStatus(harness.responderEvents, "failed"), false);
  assert.equal(hasStatus(harness.initiatorEvents, "failed"), true);
});

test("post-success cleanup timeout preserves success", async () => {
  const harness = await createConnectedTransfer({
    deferVerifiedAck: true,
    cleanupTimeoutMs: 25,
  });
  await waitFor(() => hasStatus(harness.initiatorEvents, "succeeded"));
  await waitFor(() => hasStatus(harness.responderEvents, "succeeded"));
  harness.initiatorChannel.onclose = null;
  harness.responderChannel.onclose = null;
  harness.initiatorPeer.onconnectionstatechange = null;
  harness.responderPeer.onconnectionstatechange = null;
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.responderEvents, "succeeded"), 1);
  assert.equal(countStatus(harness.initiatorEvents, "failed"), 0);
  assert.equal(countStatus(harness.responderEvents, "failed"), 0);
  assert.equal(harness.initiatorChannel.closeCalls, 1);
  assert.equal(harness.responderChannel.closeCalls, 1);
  assert.equal(harness.initiatorPeer.closeCalls, 1);
  assert.equal(harness.responderPeer.closeCalls, 1);
});

test("post-success close callbacks are idempotent in either order", async () => {
  for (const order of ["channel-first", "peer-first"] as const) {
    const harness = await createConnectedTransfer({ deferVerifiedAck: true });
    await waitFor(() => hasStatus(harness.initiatorEvents, "succeeded"));
    await waitFor(() => hasStatus(harness.responderEvents, "succeeded"));

    if (order === "channel-first") {
      harness.initiatorChannel.onerror?.();
      harness.initiatorChannel.onclose?.();
      harness.initiatorPeer.connectionState = "closed";
      harness.initiatorPeer.onconnectionstatechange?.();
    } else {
      harness.initiatorPeer.connectionState = "closed";
      harness.initiatorPeer.onconnectionstatechange?.();
      harness.initiatorChannel.onerror?.();
      harness.initiatorChannel.onclose?.();
    }

    await waitFor(
      () => harness.managerA.size === 0 && harness.managerB.size === 0,
    );
    assert.equal(countStatus(harness.initiatorEvents, "succeeded"), 1);
    assert.equal(countStatus(harness.responderEvents, "succeeded"), 1);
    assert.equal(countStatus(harness.initiatorEvents, "failed"), 0);
    assert.equal(countStatus(harness.responderEvents, "failed"), 0);
  }
});

test("peer manager enforces the bounded concurrent transfer ceiling", async () => {
  const manager = new WebRtcPeerManager({
    peerConnectionFactory: () => new FakePeerConnection(),
    emit: () => undefined,
    maxConcurrentTransfers: 1,
  });
  await manager.startTestTransfer({
    transferId,
    remoteDeviceId: recipientDeviceId,
  });
  await assert.rejects(
    manager.startTestTransfer({
      transferId: "e0e8e38b-7e3d-4ab7-8a1a-fd0ecf32c9a0",
      remoteDeviceId: recipientDeviceId,
    }),
  );
  await manager.cancelAll();
});

test("expired pre-offer ICE queues release their bounded transfer slot", async () => {
  const manager = new WebRtcPeerManager({
    peerConnectionFactory: () => new FakePeerConnection(),
    emit: () => undefined,
    maxConcurrentTransfers: 1,
    connectionTimeoutMs: 10,
  });
  const secondTransferId = "e0e8e38b-7e3d-4ab7-8a1a-fd0ecf32c9a0";

  await manager.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "ice-candidate",
    candidate: { candidate: "candidate:1", sdpMLineIndex: 0 },
  });
  await assert.rejects(
    manager.handleSignal({
      transferId: secondTransferId,
      sourceDeviceId,
      sourceKeyVersion: 1,
      kind: "ice-candidate",
      candidate: { candidate: "candidate:2", sdpMLineIndex: 0 },
    }),
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  await manager.startTestTransfer({
    transferId: secondTransferId,
    remoteDeviceId: recipientDeviceId,
  });
  await manager.cancelAll();
});

test("cancel removes a pre-offer ICE queue and frees its slot", async () => {
  const manager = new WebRtcPeerManager({
    peerConnectionFactory: () => new FakePeerConnection(),
    emit: () => undefined,
    maxConcurrentTransfers: 1,
    connectionTimeoutMs: 10_000,
  });
  const secondTransferId = "e0e8e38b-7e3d-4ab7-8a1a-fd0ecf32c9a0";

  await manager.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "ice-candidate",
    candidate: { candidate: "candidate:1", sdpMLineIndex: 0 },
  });
  await assert.rejects(
    manager.handleSignal({
      transferId,
      sourceDeviceId: otherSourceDeviceId,
      sourceKeyVersion: 1,
      kind: "cancel",
      reason: "forged cancellation",
    }),
    /pending transfer/,
  );
  await assert.rejects(
    manager.startTestTransfer({
      transferId: secondTransferId,
      remoteDeviceId: recipientDeviceId,
    }),
  );
  await manager.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "cancel",
    reason: "test cancellation",
  });

  await manager.startTestTransfer({
    transferId: secondTransferId,
    remoteDeviceId: recipientDeviceId,
  });
  await manager.cancelAll();
});

test("cancelTransfer and cancelAll clear pre-offer queues and active transfers", async () => {
  const manager = new WebRtcPeerManager({
    peerConnectionFactory: () => new FakePeerConnection(),
    emit: () => undefined,
    maxConcurrentTransfers: 1,
    connectionTimeoutMs: 10_000,
  });
  const secondTransferId = "e0e8e38b-7e3d-4ab7-8a1a-fd0ecf32c9a0";
  const thirdTransferId = "f1f9f49c-8f4e-4bc8-9b2b-ae1fd043d0b1";

  await manager.handleSignal({
    transferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "ice-candidate",
    candidate: { candidate: "candidate:1", sdpMLineIndex: 0 },
  });
  await manager.cancelTransfer(transferId);
  await manager.startTestTransfer({
    transferId: secondTransferId,
    remoteDeviceId: recipientDeviceId,
  });

  await manager.cancelAll();
  await manager.handleSignal({
    transferId: thirdTransferId,
    sourceDeviceId,
    sourceKeyVersion: 1,
    kind: "ice-candidate",
    candidate: { candidate: "candidate:2", sdpMLineIndex: 0 },
  });
  await manager.cancelAll();
});
