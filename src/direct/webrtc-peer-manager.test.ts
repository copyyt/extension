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

  constructor(label: string) {
    this.label = label;
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
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
      const delivered =
        typeof data === "string" ? data : data.slice(0);
      queueMicrotask(() => remote.onmessage?.({ data: delivered }));
    }
  }

  close(): void {
    this.readyState = "closed";
    this.onclose?.();
  }
}

class FakePeerConnection implements PeerConnectionLike {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState = "new";
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  private onDataChannel: ((event: { channel: DataChannelLike }) => void) | null = null;
  pendingRemoteChannel: FakeChannel | null = null;
  receivedDataChannel: FakeChannel | null = null;
  onconnectionstatechange: (() => void) | null = null;
  dataChannel: FakeChannel | null = null;

  set ondatachannel(listener: ((event: { channel: DataChannelLike }) => void) | null) {
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

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(): Promise<void> {
    return undefined;
  }

  close(): void {
    this.connectionState = "closed";
  }
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
  assert.equal(events.some((event) => event.kind === "signal" && event.signal.kind === "answer"), true);
  await manager.cancelAll();
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

  await managerA.startTestTransfer({ transferId, remoteDeviceId: recipientDeviceId });
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
  assert.equal(binaryChunks.length, Math.ceil(DIRECT_TEST_PAYLOAD_BYTES / DIRECT_CHUNK_SIZE));
  assert.ok(binaryChunks.every((chunk) => chunk.byteLength <= DIRECT_CHUNK_SIZE));
  assert.ok(initiatorChannel.backpressureWaits > 0);
  assert.equal(managerA.size, 0);
  assert.equal(managerB.size, 0);
});

test("peer manager enforces the bounded concurrent transfer ceiling", async () => {
  const manager = new WebRtcPeerManager({
    peerConnectionFactory: () => new FakePeerConnection(),
    emit: () => undefined,
    maxConcurrentTransfers: 1,
  });
  await manager.startTestTransfer({ transferId, remoteDeviceId: recipientDeviceId });
  await assert.rejects(
    manager.startTestTransfer({
      transferId: "e0e8e38b-7e3d-4ab7-8a1a-fd0ecf32c9a0",
      remoteDeviceId: recipientDeviceId,
    }),
  );
  await manager.cancelAll();
});
