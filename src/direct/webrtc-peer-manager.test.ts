import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECT_BUFFER_HIGH_WATER,
  DIRECT_CHUNK_SIZE,
  DIRECT_DATA_CHANNEL_LABEL,
  DIRECT_TEST_PAYLOAD_BYTES,
  deterministicTestBytes,
  sha256Hex,
  type DirectManagerEvent,
} from "./protocol.ts";
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
  closeCalls = 0;

  constructor(label: string) {
    this.label = label;
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
    if (typeof data === "string") {
      const type = (JSON.parse(data) as { type?: unknown }).type;
      if (typeof type === "string" && this.deferredControlTypes.has(type)) {
        this.deferredControls.push(data);
        return;
      }
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
    deferComplete?: boolean;
    transferTimeoutMs?: number;
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
          [
            options.deferVerified ? "verified" : null,
            options.deferComplete ? "complete" : null,
          ].filter((type): type is string => type !== null),
        );
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
  });
  const managerB = new WebRtcPeerManager({
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      if (peers.length === 2 && peers[0]?.dataChannel) {
        const remote = new FakeChannel(DIRECT_DATA_CHANNEL_LABEL);
        remote.deferredControlTypes = new Set(
          [
            options.deferVerified ? "verified" : null,
            options.deferComplete ? "complete" : null,
          ].filter((type): type is string => type !== null),
        );
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

function hasStatus(
  events: DirectManagerEvent[],
  state: Extract<DirectManagerEvent, { kind: "status" }>["state"],
): boolean {
  return events.some(
    (event) => event.kind === "status" && event.state === state,
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

test("completion handshake keeps verified responders alive until expected close", async () => {
  const harness = await createConnectedTransfer({
    deferVerified: true,
    deferComplete: true,
  });

  await waitFor(() => hasStatus(harness.responderEvents, "verified"));
  assert.equal(harness.managerB.size, 1);
  assert.equal(harness.responderChannel.readyState, "open");
  assert.notEqual(harness.responderPeer.connectionState, "closed");
  assert.equal(hasStatus(harness.responderEvents, "succeeded"), false);
  assert.equal(harness.responderChannel.closeCalls, 0);
  assert.equal(harness.responderPeer.closeCalls, 0);

  harness.responderChannel.releaseDeferredControl("verified");
  await waitFor(() =>
    harness.initiatorChannel.sent.some(
      (message) =>
        typeof message === "string" &&
        (JSON.parse(message) as { type?: unknown }).type === "verified-ack",
    ),
  );
  await waitFor(() =>
    harness.responderChannel.deferredControls.some(
      (message) =>
        (JSON.parse(message) as { type?: unknown }).type === "complete",
    ),
  );
  assert.equal(harness.managerA.size, 1);
  assert.equal(hasStatus(harness.initiatorEvents, "succeeded"), false);

  harness.responderChannel.releaseDeferredControl("complete");
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(hasStatus(harness.initiatorEvents, "succeeded"), true);
  assert.equal(hasStatus(harness.responderEvents, "succeeded"), true);
  assert.equal(hasStatus(harness.initiatorEvents, "failed"), false);
  assert.equal(hasStatus(harness.responderEvents, "failed"), false);
});

test("early receiver close before verified remains a transfer failure", async () => {
  const harness = await createConnectedTransfer({ deferVerified: true });
  await waitFor(() => hasStatus(harness.responderEvents, "verified"));

  harness.responderChannel.close();
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(hasStatus(harness.initiatorEvents, "failed"), true);
  assert.equal(hasStatus(harness.responderEvents, "failed"), true);
  assert.equal(hasStatus(harness.responderEvents, "succeeded"), false);
});

test("initiator close before verified acknowledgement remains a failure", async () => {
  const harness = await createConnectedTransfer({ deferVerified: true });
  await waitFor(() => hasStatus(harness.responderEvents, "verified"));

  harness.initiatorChannel.close();
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(hasStatus(harness.initiatorEvents, "failed"), true);
  assert.equal(hasStatus(harness.responderEvents, "failed"), true);
  assert.equal(hasStatus(harness.responderEvents, "succeeded"), false);
});

test("responder close before complete remains a transfer failure", async () => {
  const harness = await createConnectedTransfer({ deferVerified: true });
  await waitFor(() => hasStatus(harness.responderEvents, "verified"));

  harness.responderChannel.close();
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(hasStatus(harness.initiatorEvents, "failed"), true);
  assert.equal(hasStatus(harness.responderEvents, "failed"), true);
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
  assert.equal(hasStatus(harness.responderEvents, "failed"), true);
  assert.equal(hasStatus(harness.initiatorEvents, "failed"), true);
});

test("terminal handshake timeout cleans up when complete never arrives", async () => {
  const harness = await createConnectedTransfer({
    deferComplete: true,
    transferTimeoutMs: 250,
  });
  await waitFor(() =>
    harness.responderChannel.deferredControls.some(
      (message) =>
        (JSON.parse(message) as { type?: unknown }).type === "complete",
    ),
  );
  await waitFor(
    () => harness.managerA.size === 0 && harness.managerB.size === 0,
  );
  assert.equal(hasStatus(harness.initiatorEvents, "failed"), true);
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
