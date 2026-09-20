import {
  DIRECT_BUFFER_HIGH_WATER,
  DIRECT_BUFFER_LOW_THRESHOLD,
  DIRECT_CHUNK_SIZE,
  DIRECT_CLEANUP_TIMEOUT_MS,
  DIRECT_CONNECTION_TIMEOUT_MS,
  DIRECT_DATA_CHANNEL_LABEL,
  DIRECT_MAX_CONCURRENT_TRANSFERS,
  DIRECT_MAX_ICE_CANDIDATES,
  DIRECT_MAX_TEST_PAYLOAD_BYTES,
  DIRECT_TEST_PAYLOAD_BYTES,
  DIRECT_CLIPBOARD_PROTOCOL,
  DIRECT_APPLICATION_MAX_FRAME_BYTES,
  DIRECT_TRANSFER_TIMEOUT_MS,
  deterministicTestBytes,
  isDirectIceCandidate,
  sha256Hex,
  type DirectIceCandidate,
  type DirectManagerEvent,
  type DirectSignalBody,
  type DirectSignalDelivery,
  type DirectTransferState,
} from "./protocol.ts";
import { base64ToBytes, bytesToBase64 } from "../crypto/bytes.ts";
import {
  isDirectClipboardStartV1,
  type DirectClipboardStartV1,
} from "../crypto/direct-clipboard.ts";

interface DataChannelLike {
  label: string;
  readyState: string;
  binaryType: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  onbufferedamountlow: (() => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
  addEventListener?: (
    type: string,
    listener: (...args: unknown[]) => void,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: (...args: unknown[]) => void,
  ) => void;
}

interface PeerConnectionLike {
  localDescription: RTCSessionDescriptionInit | null;
  remoteDescription: RTCSessionDescriptionInit | null;
  connectionState?: string;
  onicecandidate: ((event: { candidate: unknown }) => void) | null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  createDataChannel(
    label: string,
    options?: { ordered: boolean },
  ): DataChannelLike;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: DirectIceCandidate): Promise<void>;
  close(): void;
}

export interface DirectPeerManagerDependencies {
  peerConnectionFactory?: (
    configuration: RTCConfiguration,
  ) => PeerConnectionLike;
  emit(event: DirectManagerEvent): Promise<void> | void;
  now?: () => Date;
  chunkSize?: number;
  maxConcurrentTransfers?: number;
  connectionTimeoutMs?: number;
  transferTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

export interface DirectClipboardTransferInput {
  transferId: string;
  remoteDeviceId: string;
  manifest: string;
  encryptedChunks: readonly string[];
}

export class DirectTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectTransportError";
  }
}

interface TransferState {
  transferId: string;
  remoteDeviceId: string;
  role: "initiator" | "responder";
  peerConnection: PeerConnectionLike;
  dataChannel?: DataChannelLike;
  pendingCandidates: DirectIceCandidate[];
  remoteDescriptionSet: boolean;
  createdAt: number;
  state: DirectTransferState;
  applicationResult: ApplicationResult;
  succeededStatusEmitted: boolean;
  completionPhase: CompletionPhase;
  connectionTimer?: ReturnType<typeof setTimeout>;
  transferTimer?: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  testBytes?: Uint8Array;
  expectedByteLength?: number;
  expectedSha256?: string;
  expectedClipboardPlaintextByteLength?: number;
  clipboardExpiresAtMs?: number;
  receivedChunks?: ArrayBuffer[];
  expectedChunkCount?: number;
  receivedChunkCount?: number;
  receivedByteLength?: number;
  receivedStart?: boolean;
  receivedEnd?: boolean;
  applicationMode?: "test" | "clipboard";
  clipboardPackage?: {
    manifest: string;
    encryptedChunks: readonly string[];
  };
  applicationFrameChain?: Promise<void>;
}

type CompletionPhase =
  | "transferring"
  | "awaiting-verified"
  | "awaiting-verified-ack"
  | "closing-transport";

type ApplicationResult = "pending" | "succeeded" | "failed";

interface PendingIceQueue {
  sourceDeviceId: string;
  candidates: DirectIceCandidate[];
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface ControlStart {
  type: "start";
  transferId: string;
  byteLength: number;
  chunkSize: number;
  chunkCount: number;
  sha256: string;
}

interface ControlEnd {
  type: "end";
  transferId: string;
}

interface ControlVerified {
  type: "verified";
  transferId: string;
  byteLength: number;
  sha256: string;
}

interface ControlVerifiedAck {
  type: "verified-ack";
  transferId: string;
}

interface ClipboardVerifiedControl {
  type: "clipboard-secure-verified";
  protocol: typeof DIRECT_CLIPBOARD_PROTOCOL;
  transferId: string;
  plaintextByteLength: number;
}

interface ClipboardVerifiedAckControl {
  type: "clipboard-secure-verified-ack";
  protocol: typeof DIRECT_CLIPBOARD_PROTOCOL;
  transferId: string;
}

function isControlObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStartControl(value: unknown): value is ControlStart {
  if (!isControlObject(value)) return false;
  const candidate = value as Partial<ControlStart>;
  return (
    Object.keys(value).length === 6 &&
    candidate.type === "start" &&
    typeof candidate.transferId === "string" &&
    Number.isSafeInteger(candidate.byteLength) &&
    (candidate.byteLength as number) > 0 &&
    (candidate.byteLength as number) <= DIRECT_MAX_TEST_PAYLOAD_BYTES &&
    candidate.chunkSize === DIRECT_CHUNK_SIZE &&
    Number.isSafeInteger(candidate.chunkCount) &&
    (candidate.chunkCount as number) > 0 &&
    typeof candidate.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.sha256)
  );
}

function isEndControl(value: unknown): value is ControlEnd {
  return (
    isControlObject(value) &&
    Object.keys(value).length === 2 &&
    value.type === "end" &&
    typeof value.transferId === "string"
  );
}

function isVerifiedControl(value: unknown): value is ControlVerified {
  if (!isControlObject(value)) return false;
  const candidate = value as Partial<ControlVerified>;
  return (
    Object.keys(value).length === 4 &&
    candidate.type === "verified" &&
    typeof candidate.transferId === "string" &&
    Number.isSafeInteger(candidate.byteLength) &&
    (candidate.byteLength as number) > 0 &&
    (candidate.byteLength as number) <= DIRECT_MAX_TEST_PAYLOAD_BYTES &&
    typeof candidate.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.sha256)
  );
}

function isVerifiedAckControl(value: unknown): value is ControlVerifiedAck {
  if (!isControlObject(value)) return false;
  const candidate = value as Partial<ControlVerifiedAck>;
  return (
    Object.keys(value).length === 2 &&
    candidate.type === "verified-ack" &&
    typeof candidate.transferId === "string"
  );
}

function isClipboardStartControl(value: unknown): value is {
  type: "clipboard-secure-start";
  protocol: typeof DIRECT_CLIPBOARD_PROTOCOL;
  transferId: string;
} {
  return (
    isControlObject(value) &&
    value.type === "clipboard-secure-start" &&
    value.protocol === DIRECT_CLIPBOARD_PROTOCOL &&
    typeof value.transferId === "string"
  );
}

function parseClipboardStartManifest(
  value: unknown,
  transferId: string,
): DirectClipboardStartV1 {
  if (!isDirectClipboardStartV1(value) || value.transferId !== transferId) {
    throw new DirectTransportError("The direct clipboard manifest is invalid");
  }
  return value;
}

function parseClipboardExpiry(
  manifest: DirectClipboardStartV1,
  now: number,
): number {
  const expiresAtMs = Date.parse(manifest.expiresAt);
  if (
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== manifest.expiresAt
  ) {
    throw new DirectTransportError("The direct clipboard expiry is invalid");
  }
  if (expiresAtMs <= now) {
    throw new DirectTransportError("Direct clipboard transfer expired");
  }
  return expiresAtMs;
}

function isClipboardVerifiedControl(
  value: unknown,
): value is ClipboardVerifiedControl {
  return (
    isControlObject(value) &&
    Object.keys(value).length === 4 &&
    value.type === "clipboard-secure-verified" &&
    value.protocol === DIRECT_CLIPBOARD_PROTOCOL &&
    typeof value.transferId === "string" &&
    Number.isSafeInteger(value.plaintextByteLength) &&
    (value.plaintextByteLength as number) > 0
  );
}

function isClipboardVerifiedAckControl(
  value: unknown,
): value is ClipboardVerifiedAckControl {
  return (
    isControlObject(value) &&
    Object.keys(value).length === 3 &&
    value.type === "clipboard-secure-verified-ack" &&
    value.protocol === DIRECT_CLIPBOARD_PROTOCOL &&
    typeof value.transferId === "string"
  );
}

function asArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer;
  }
  return null;
}

function candidateFromEvent(value: unknown): DirectIceCandidate | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    candidate?: unknown;
    sdpMid?: unknown;
    sdpMLineIndex?: unknown;
    usernameFragment?: unknown;
    toJSON?: () => unknown;
  };
  const json =
    typeof candidate.toJSON === "function" ? candidate.toJSON() : value;
  if (!isDirectIceCandidate(json)) return null;
  return {
    candidate: json.candidate,
    ...(json.sdpMid !== undefined ? { sdpMid: json.sdpMid } : {}),
    ...(json.sdpMLineIndex !== undefined
      ? { sdpMLineIndex: json.sdpMLineIndex }
      : {}),
    ...(json.usernameFragment !== undefined
      ? { usernameFragment: json.usernameFragment }
      : {}),
  };
}

export class WebRtcPeerManager {
  private readonly dependencies: Required<
    Omit<DirectPeerManagerDependencies, "peerConnectionFactory" | "emit">
  > &
    Pick<DirectPeerManagerDependencies, "emit">;
  private readonly peerConnectionFactory: (
    configuration: RTCConfiguration,
  ) => PeerConnectionLike;
  private readonly transfers = new Map<string, TransferState>();
  private readonly pendingCandidates = new Map<string, PendingIceQueue>();

  constructor(dependencies: DirectPeerManagerDependencies) {
    this.dependencies = {
      now: dependencies.now ?? (() => new Date()),
      chunkSize: dependencies.chunkSize ?? DIRECT_CHUNK_SIZE,
      maxConcurrentTransfers:
        dependencies.maxConcurrentTransfers ?? DIRECT_MAX_CONCURRENT_TRANSFERS,
      connectionTimeoutMs:
        dependencies.connectionTimeoutMs ?? DIRECT_CONNECTION_TIMEOUT_MS,
      transferTimeoutMs:
        dependencies.transferTimeoutMs ?? DIRECT_TRANSFER_TIMEOUT_MS,
      cleanupTimeoutMs:
        dependencies.cleanupTimeoutMs ?? DIRECT_CLEANUP_TIMEOUT_MS,
      emit: dependencies.emit,
    };
    if (
      this.dependencies.chunkSize !== DIRECT_CHUNK_SIZE ||
      this.dependencies.chunkSize <= 0
    ) {
      throw new DirectTransportError("The direct chunk size is invalid");
    }
    this.peerConnectionFactory =
      dependencies.peerConnectionFactory ??
      ((configuration) =>
        new RTCPeerConnection(configuration) as unknown as PeerConnectionLike);
  }

  get size(): number {
    return this.transfers.size;
  }

  async startTestTransfer(input: {
    transferId: string;
    remoteDeviceId: string;
  }): Promise<void> {
    if (
      this.occupiedTransferSlots() >= this.dependencies.maxConcurrentTransfers
    ) {
      throw new DirectTransportError(
        "The maximum number of direct transfers is already active",
      );
    }
    if (this.transfers.has(input.transferId)) {
      throw new DirectTransportError("The direct transfer is already active");
    }

    const state = this.createTransfer(
      input.transferId,
      input.remoteDeviceId,
      "initiator",
    );
    try {
      const dataChannel = state.peerConnection.createDataChannel(
        DIRECT_DATA_CHANNEL_LABEL,
        { ordered: true },
      );
      this.attachDataChannel(state, dataChannel);
      const offer = await state.peerConnection.createOffer();
      await state.peerConnection.setLocalDescription(offer);
      await this.emitSignal(state, {
        kind: "offer",
        sdp: offer.sdp ?? "",
      });
    } catch (error) {
      this.handleTransportFailure(
        state,
        error instanceof Error ? error.message : "Offer failed",
      );
      throw new DirectTransportError("Unable to create the direct offer");
    }
  }

  async startClipboardTransfer(
    input: DirectClipboardTransferInput,
  ): Promise<void> {
    if (
      this.occupiedTransferSlots() >= this.dependencies.maxConcurrentTransfers
    ) {
      throw new DirectTransportError(
        "The maximum number of direct transfers is already active",
      );
    }
    if (this.transfers.has(input.transferId)) {
      throw new DirectTransportError("The direct transfer is already active");
    }
    if (typeof input.manifest !== "string" || input.manifest.length === 0) {
      throw new DirectTransportError("The direct clipboard manifest is missing");
    }
    let manifest: DirectClipboardStartV1;
    let clipboardExpiresAtMs: number;
    try {
      manifest = parseClipboardStartManifest(
        JSON.parse(input.manifest) as unknown,
        input.transferId,
      );
      clipboardExpiresAtMs = parseClipboardExpiry(
        manifest,
        this.dependencies.now().getTime(),
      );
    } catch (error) {
      if (error instanceof DirectTransportError) throw error;
      throw new DirectTransportError("The direct clipboard manifest is invalid");
    }
    for (const chunk of input.encryptedChunks) {
      try {
        if (base64ToBytes(chunk).byteLength > DIRECT_APPLICATION_MAX_FRAME_BYTES) {
          throw new Error("oversized");
        }
      } catch {
        throw new DirectTransportError("The direct clipboard chunk is invalid");
      }
    }
    const state = this.createTransfer(
      input.transferId,
      input.remoteDeviceId,
      "initiator",
    );
    state.applicationMode = "clipboard";
    state.clipboardExpiresAtMs = clipboardExpiresAtMs;
    state.expectedClipboardPlaintextByteLength = manifest.plaintextByteLength;
    state.clipboardPackage = {
      manifest: input.manifest,
      encryptedChunks: [...input.encryptedChunks],
    };
    try {
      const dataChannel = state.peerConnection.createDataChannel(
        DIRECT_DATA_CHANNEL_LABEL,
        { ordered: true },
      );
      this.attachDataChannel(state, dataChannel);
      const offer = await state.peerConnection.createOffer();
      await state.peerConnection.setLocalDescription(offer);
      await this.emitSignal(state, {
        kind: "offer",
        sdp: offer.sdp ?? "",
      });
    } catch (error) {
      this.handleTransportFailure(
        state,
        error instanceof Error ? error.message : "Offer failed",
      );
      throw new DirectTransportError("Unable to create the direct offer");
    }
  }

  async sendClipboardVerified(input: {
    transferId: string;
    plaintextByteLength: number;
  }): Promise<void> {
    const state = this.transfers.get(input.transferId);
    if (
      !state ||
      state.role !== "responder" ||
      state.applicationMode !== "clipboard" ||
      state.completionPhase !== "transferring"
    ) {
      throw new DirectTransportError(
        "The direct clipboard transfer is not ready for verification",
      );
    }
    if (
      !Number.isSafeInteger(input.plaintextByteLength) ||
      input.plaintextByteLength <= 0 ||
      input.plaintextByteLength !== state.expectedClipboardPlaintextByteLength
    ) {
      throw new DirectTransportError("The direct clipboard byte length is invalid");
    }
    const control: ClipboardVerifiedControl = {
      type: "clipboard-secure-verified",
      protocol: DIRECT_CLIPBOARD_PROTOCOL,
      transferId: input.transferId,
      plaintextByteLength: input.plaintextByteLength,
    };
    this.markApplicationSucceeded(state);
    state.completionPhase = "awaiting-verified-ack";
    state.state = "verified";
    await this.emitApplicationSucceeded(state, {
      bytesReceived: input.plaintextByteLength,
      byteLength: input.plaintextByteLength,
    });
    this.startCleanupTimer(state);
    try {
      if (!state.dataChannel || state.dataChannel.readyState !== "open") {
        throw new DirectTransportError(
          "The data channel closed before clipboard verification",
        );
      }
      state.dataChannel.send(JSON.stringify(control));
    } catch (error) {
      this.handleTransportFailure(
        state,
        error instanceof Error
          ? error.message
          : "The clipboard verification could not be sent",
      );
    }
  }

  async handleSignal(signal: DirectSignalDelivery): Promise<void> {
    try {
      await this.handleSignalInternal(signal);
    } catch (error) {
      const state = this.transfers.get(signal.transferId);
      if (state && state.remoteDeviceId === signal.sourceDeviceId) {
        this.handleTransportFailure(
          state,
          error instanceof Error ? error.message : "Direct signalling failed",
        );
      } else if (!state) {
        const pending = this.pendingCandidates.get(signal.transferId);
        if (pending?.sourceDeviceId === signal.sourceDeviceId) {
          this.discardPendingCandidates(signal.transferId, pending);
        }
      }
      throw error;
    }
  }

  private async handleSignalInternal(
    signal: DirectSignalDelivery,
  ): Promise<void> {
    if (signal.kind === "cancel") {
      const state = this.transfers.get(signal.transferId);
      if (state && state.remoteDeviceId !== signal.sourceDeviceId) {
        throw new DirectTransportError(
          "The direct cancel source does not match the transfer",
        );
      }

      const pending = this.pendingCandidates.get(signal.transferId);
      if (pending && pending.sourceDeviceId !== signal.sourceDeviceId) {
        throw new DirectTransportError(
          "The direct cancel source does not match the pending transfer",
        );
      }

      if (state) this.cancelState(state, signal.reason ?? "Remote cancelled");
      this.discardPendingCandidates(signal.transferId, pending);
      return;
    }

    if (signal.kind === "ice-candidate") {
      await this.handleCandidate(signal);
      return;
    }

    if (signal.kind === "offer") {
      await this.handleOffer(signal);
      return;
    }

    const state = this.transfers.get(signal.transferId);
    if (
      !state ||
      state.role !== "initiator" ||
      state.remoteDeviceId !== signal.sourceDeviceId
    ) {
      throw new DirectTransportError(
        "The direct answer does not match an active transfer",
      );
    }
    if (typeof signal.sdp !== "string" || signal.sdp.length === 0) {
      throw new DirectTransportError("The direct answer is missing SDP");
    }
    await state.peerConnection.setRemoteDescription({
      type: "answer",
      sdp: signal.sdp,
    });
    state.remoteDescriptionSet = true;
    await this.flushCandidates(state);
  }

  async cancelTransfer(
    transferId: string,
    reason = "Cancelled",
  ): Promise<void> {
    const state = this.transfers.get(transferId);
    this.discardPendingCandidates(transferId);
    if (!state) return;
    await this.emitSignal(state, { kind: "cancel", reason }).catch(
      () => undefined,
    );
    this.cancelState(state, reason);
  }

  async cancelAll(reason = "Transport unavailable"): Promise<void> {
    await Promise.all(
      [...this.transfers.keys()].map((transferId) =>
        this.cancelTransfer(transferId, reason),
      ),
    );
    this.discardAllPendingCandidates();
  }

  private occupiedTransferSlots(): number {
    return this.transfers.size + this.pendingCandidates.size;
  }

  private createTransfer(
    transferId: string,
    remoteDeviceId: string,
    role: "initiator" | "responder",
  ): TransferState {
    const peerConnection = this.peerConnectionFactory({ iceServers: [] });
    const pendingCandidates = this.takePendingCandidates(transferId);
    const state: TransferState = {
      transferId,
      remoteDeviceId,
      role,
      peerConnection,
      pendingCandidates,
      remoteDescriptionSet: false,
      createdAt: this.dependencies.now().getTime(),
      state: "connecting",
      applicationResult: "pending",
      succeededStatusEmitted: false,
      completionPhase: "transferring",
    };
    this.transfers.set(transferId, state);
    peerConnection.onicecandidate = (event) => {
      const candidate = candidateFromEvent(event.candidate);
      if (!candidate) return;
      void this.emitSignal(state, { kind: "ice-candidate", candidate }).catch(
        () => this.handleTransportFailure(state, "ICE signalling failed"),
      );
    };
    peerConnection.ondatachannel = (event) => {
      if (state.role !== "responder") return;
      if (event.channel.label !== DIRECT_DATA_CHANNEL_LABEL) {
        event.channel.close();
        return;
      }
      this.attachDataChannel(state, event.channel);
    };
    peerConnection.onconnectionstatechange = () => {
      const connectionState = peerConnection.connectionState;
      if (connectionState === "closed") {
        this.handleTransportFailure(
          state,
          `Peer connection ${connectionState}`,
        );
        return;
      }

      if (connectionState === "failed") {
        this.handleTransportFailure(state, "Peer connection failed");
        return;
      }

      if (connectionState === "disconnected") {
        // A disconnected peer connection may recover before the transfer
        // timeout expires. Leave the transfer and its timers intact.
        return;
      }
    };
    state.connectionTimer = setTimeout(
      () => this.handleTransportFailure(state, "Direct connection timed out"),
      this.dependencies.connectionTimeoutMs,
    );
    void this.emitStatus(state, "connecting");
    return state;
  }

  private async handleOffer(signal: DirectSignalDelivery): Promise<void> {
    let state = this.transfers.get(signal.transferId);
    if (state) {
      if (
        state.role !== "responder" ||
        state.remoteDeviceId !== signal.sourceDeviceId
      ) {
        throw new DirectTransportError(
          "The direct offer conflicts with an active transfer",
        );
      }
    } else {
      const pending = this.pendingCandidates.get(signal.transferId);
      if (pending && pending.sourceDeviceId !== signal.sourceDeviceId) {
        throw new DirectTransportError(
          "The direct offer source does not match the pending ICE queue",
        );
      }
      if (
        !pending &&
        this.occupiedTransferSlots() >= this.dependencies.maxConcurrentTransfers
      ) {
        throw new DirectTransportError(
          "The maximum number of direct transfers is already active",
        );
      }
      state = this.createTransfer(
        signal.transferId,
        signal.sourceDeviceId,
        "responder",
      );
    }
    if (typeof signal.sdp !== "string" || signal.sdp.length === 0) {
      throw new DirectTransportError("The direct offer is missing SDP");
    }
    await state.peerConnection.setRemoteDescription({
      type: "offer",
      sdp: signal.sdp,
    });
    state.remoteDescriptionSet = true;
    await this.flushCandidates(state);
    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);
    await this.emitSignal(state, {
      kind: "answer",
      sdp: answer.sdp ?? "",
    });
  }

  private async handleCandidate(signal: DirectSignalDelivery): Promise<void> {
    if (!signal.candidate || !isDirectIceCandidate(signal.candidate)) {
      throw new DirectTransportError("The ICE candidate is invalid");
    }
    const state = this.transfers.get(signal.transferId);
    if (!state) {
      const pending = this.pendingCandidates.get(signal.transferId);
      if (
        !pending &&
        this.occupiedTransferSlots() >= this.dependencies.maxConcurrentTransfers
      ) {
        throw new DirectTransportError(
          "The maximum number of direct transfers is already active",
        );
      }
      if (pending && pending.sourceDeviceId !== signal.sourceDeviceId) {
        throw new DirectTransportError(
          "The ICE candidate source does not match the pending transfer",
        );
      }
      if (pending && pending.candidates.length >= DIRECT_MAX_ICE_CANDIDATES) {
        throw new DirectTransportError(
          "Too many ICE candidates for the transfer",
        );
      }
      if (pending) {
        pending.candidates.push(signal.candidate);
        return;
      }
      const queue: PendingIceQueue = {
        sourceDeviceId: signal.sourceDeviceId,
        candidates: [signal.candidate],
        expiresAt:
          this.dependencies.now().getTime() +
          this.dependencies.connectionTimeoutMs,
      };
      queue.timer = setTimeout(
        () => this.expirePendingCandidates(signal.transferId, queue),
        this.dependencies.connectionTimeoutMs,
      );
      this.pendingCandidates.set(signal.transferId, queue);
      return;
    }
    if (state.remoteDeviceId !== signal.sourceDeviceId) {
      throw new DirectTransportError(
        "The ICE candidate source does not match the transfer",
      );
    }
    if (!state.remoteDescriptionSet) {
      if (state.pendingCandidates.length >= DIRECT_MAX_ICE_CANDIDATES) {
        throw new DirectTransportError(
          "Too many ICE candidates for the transfer",
        );
      }
      state.pendingCandidates.push(signal.candidate);
      return;
    }
    await state.peerConnection.addIceCandidate(signal.candidate);
  }

  private async flushCandidates(state: TransferState): Promise<void> {
    if (!state.remoteDescriptionSet) return;
    const candidates = state.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      await state.peerConnection.addIceCandidate(candidate);
    }
  }

  private expirePendingCandidates(
    transferId: string,
    queue: PendingIceQueue,
  ): void {
    if (this.pendingCandidates.get(transferId) !== queue) return;
    this.discardPendingCandidates(transferId, queue);
  }

  private takePendingCandidates(transferId: string): DirectIceCandidate[] {
    const queue = this.pendingCandidates.get(transferId);
    if (!queue) return [];
    if (queue.timer !== undefined) {
      clearTimeout(queue.timer);
      queue.timer = undefined;
    }
    this.pendingCandidates.delete(transferId);
    return queue.candidates;
  }

  private discardPendingCandidates(
    transferId: string,
    expectedQueue?: PendingIceQueue,
  ): void {
    const queue = this.pendingCandidates.get(transferId);
    if (!queue || (expectedQueue && queue !== expectedQueue)) return;
    if (queue.timer !== undefined) {
      clearTimeout(queue.timer);
      queue.timer = undefined;
    }
    queue.candidates.length = 0;
    this.pendingCandidates.delete(transferId);
  }

  private discardAllPendingCandidates(): void {
    for (const [transferId, queue] of this.pendingCandidates) {
      this.discardPendingCandidates(transferId, queue);
    }
  }

  private attachDataChannel(
    state: TransferState,
    channel: DataChannelLike,
  ): void {
    state.dataChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = DIRECT_BUFFER_LOW_THRESHOLD;
    channel.onopen = () => {
      if (this.transfers.get(state.transferId) !== state) return;
      this.clearConnectionTimer(state);
      if (state.applicationMode === "clipboard") {
        if (!this.armClipboardTransferTimer(state)) return;
      } else {
        this.armTransferTimer(
          state,
          this.dependencies.transferTimeoutMs,
          "Direct transfer timed out",
        );
      }
      state.state = "open";
      void this.emitStatus(state, "open");
      if (state.role === "initiator") {
        if (state.applicationMode === "clipboard") {
          void this.sendClipboardPayload(state);
        } else {
          void this.sendTestPayload(state);
        }
      }
    };
    channel.onmessage = (event) => {
      state.applicationFrameChain = (state.applicationFrameChain ?? Promise.resolve())
        .then(() => this.handleDataMessage(state, event.data))
        .catch((error: unknown) => {
          this.handleTransportFailure(
            state,
            error instanceof Error ? error.message : "Data channel failed",
          );
        });
    };
    channel.onerror = () =>
      this.handleTransportFailure(state, "Data channel error");
    channel.onclose = () => {
      this.handleTransportFailure(
        state,
        "Data channel closed before verification",
      );
    };
  }

  private async sendTestPayload(state: TransferState): Promise<void> {
    if (!state.dataChannel || state.dataChannel.readyState !== "open") return;
    try {
      const bytes = deterministicTestBytes(
        state.transferId,
        DIRECT_TEST_PAYLOAD_BYTES,
      );
      state.testBytes = bytes;
      state.expectedByteLength = bytes.byteLength;
      state.expectedSha256 = await sha256Hex(bytes);
      const chunkCount = Math.ceil(
        bytes.byteLength / this.dependencies.chunkSize,
      );
      const start: ControlStart = {
        type: "start",
        transferId: state.transferId,
        byteLength: bytes.byteLength,
        chunkSize: this.dependencies.chunkSize,
        chunkCount,
        sha256: state.expectedSha256,
      };
      state.dataChannel.send(JSON.stringify(start));
      state.state = "sending";
      await this.emitStatus(state, "sending", { byteLength: bytes.byteLength });
      for (
        let offset = 0;
        offset < bytes.byteLength;
        offset += this.dependencies.chunkSize
      ) {
        await this.waitForBufferLow(state.dataChannel);
        if (state.dataChannel.readyState !== "open") {
          throw new DirectTransportError("Data channel closed during sending");
        }
        const chunk = bytes.slice(
          offset,
          Math.min(offset + this.dependencies.chunkSize, bytes.byteLength),
        );
        state.dataChannel.send(chunk.buffer);
        await this.emitStatus(state, "sending", {
          bytesSent: Math.min(offset + chunk.byteLength, bytes.byteLength),
          byteLength: bytes.byteLength,
        });
      }
      const end: ControlEnd = { type: "end", transferId: state.transferId };
      state.dataChannel.send(JSON.stringify(end));
      state.completionPhase = "awaiting-verified";
    } catch (error) {
      this.handleTransportFailure(
        state,
        error instanceof Error ? error.message : "Direct send failed",
      );
    }
  }

  private async sendClipboardPayload(state: TransferState): Promise<void> {
    const packageToSend = state.clipboardPackage;
    if (
      !state.dataChannel ||
      state.dataChannel.readyState !== "open" ||
      !packageToSend
    ) {
      return;
    }
    try {
      state.dataChannel.send(packageToSend.manifest);
      state.state = "sending";
      const totalBytes = packageToSend.encryptedChunks.reduce((total, chunk) => {
        try {
          return total + base64ToBytes(chunk).byteLength;
        } catch {
          throw new DirectTransportError("The direct clipboard chunk is invalid");
        }
      }, 0);
      let sentBytes = 0;
      await this.emitStatus(state, "sending", { byteLength: totalBytes });
      for (const encodedChunk of packageToSend.encryptedChunks) {
        await this.waitForBufferLow(state.dataChannel);
        if (state.dataChannel.readyState !== "open") {
          throw new DirectTransportError("Data channel closed during sending");
        }
        const bytes = base64ToBytes(encodedChunk);
        if (bytes.byteLength > DIRECT_APPLICATION_MAX_FRAME_BYTES) {
          throw new DirectTransportError("The direct clipboard chunk is too large");
        }
        state.dataChannel.send(bytes.buffer);
        sentBytes += bytes.byteLength;
        await this.emitStatus(state, "sending", {
          bytesSent: sentBytes,
          byteLength: totalBytes,
        });
      }
      state.completionPhase = "awaiting-verified";
    } catch (error) {
      this.handleTransportFailure(
        state,
        error instanceof Error ? error.message : "Direct clipboard send failed",
      );
    }
  }

  private async waitForBufferLow(channel: DataChannelLike): Promise<void> {
    if (channel.bufferedAmount <= DIRECT_BUFFER_HIGH_WATER) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const previousLow = channel.onbufferedamountlow;
      const previousClose = channel.onclose;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        channel.onbufferedamountlow = previousLow;
        channel.onclose = previousClose;
        if (error) reject(error);
        else resolve();
      };
      channel.onbufferedamountlow = () => {
        previousLow?.();
        if (channel.bufferedAmount <= DIRECT_BUFFER_HIGH_WATER) finish();
      };
      channel.onclose = () => {
        previousClose?.();
        finish(
          new DirectTransportError("Data channel closed while backpressured"),
        );
      };
      if (channel.readyState !== "open") {
        finish(
          new DirectTransportError("Data channel closed while backpressured"),
        );
      }
    });
  }

  private async handleDataMessage(
    state: TransferState,
    raw: unknown,
  ): Promise<void> {
    if (this.transfers.get(state.transferId) !== state) return;
    if (typeof raw === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new DirectTransportError("The direct control frame is invalid");
      }
      if (isClipboardVerifiedControl(parsed)) {
        if (
          state.role !== "initiator" ||
          state.applicationMode !== "clipboard" ||
          state.completionPhase !== "awaiting-verified" ||
          parsed.transferId !== state.transferId ||
          parsed.plaintextByteLength !==
            state.expectedClipboardPlaintextByteLength
        ) {
          throw new DirectTransportError(
            "The direct clipboard verification acknowledgement is invalid",
          );
        }
        this.markApplicationSucceeded(state);
        state.state = "verified";
        const verifiedStatus = this.emitStatus(state, "verified", {
          bytesReceived: parsed.plaintextByteLength,
          byteLength: parsed.plaintextByteLength,
        });
        await this.emitApplicationSucceeded(state, {
          bytesReceived: parsed.plaintextByteLength,
          byteLength: parsed.plaintextByteLength,
        });
        await verifiedStatus;
        if (!state.dataChannel || state.dataChannel.readyState !== "open") {
          throw new DirectTransportError(
            "The data channel closed before clipboard verification acknowledgement",
          );
        }
        const acknowledged: ClipboardVerifiedAckControl = {
          type: "clipboard-secure-verified-ack",
          protocol: DIRECT_CLIPBOARD_PROTOCOL,
          transferId: state.transferId,
        };
        state.dataChannel.send(JSON.stringify(acknowledged));
        state.completionPhase = "closing-transport";
        this.startCleanupTimer(state);
        return;
      }
      if (isClipboardVerifiedAckControl(parsed)) {
        if (
          state.role !== "responder" ||
          state.applicationMode !== "clipboard" ||
          state.applicationResult !== "succeeded" ||
          state.completionPhase !== "awaiting-verified-ack" ||
          parsed.transferId !== state.transferId
        ) {
          throw new DirectTransportError(
            "The direct clipboard verification acknowledgement is invalid",
          );
        }
        state.completionPhase = "closing-transport";
        this.cleanup(state);
        return;
      }
      if (isClipboardStartControl(parsed)) {
        if (
          state.role !== "responder" ||
          state.applicationMode !== undefined ||
          parsed.transferId !== state.transferId
        ) {
          throw new DirectTransportError("The direct clipboard start frame is invalid");
        }
        const manifest = parseClipboardStartManifest(parsed, state.transferId);
        const expiresAtMs = parseClipboardExpiry(
          manifest,
          this.dependencies.now().getTime(),
        );
        state.applicationMode = "clipboard";
        state.clipboardExpiresAtMs = expiresAtMs;
        state.expectedClipboardPlaintextByteLength =
          manifest.plaintextByteLength;
        if (!this.armClipboardTransferTimer(state)) return;
        state.receivedStart = true;
        state.state = "receiving";
        await this.emitApplicationFrame(state, {
          type: "clipboard-secure-start",
          manifest: raw,
        });
        return;
      }
      if (isVerifiedControl(parsed)) {
        if (
          state.role !== "initiator" ||
          state.completionPhase !== "awaiting-verified" ||
          parsed.transferId !== state.transferId ||
          parsed.byteLength !== state.expectedByteLength ||
          parsed.sha256 !== state.expectedSha256
        ) {
          throw new DirectTransportError(
            "The direct verification acknowledgement is invalid",
          );
        }
        this.markApplicationSucceeded(state);
        state.state = "verified";
        const verifiedStatus = this.emitStatus(state, "verified", {
          bytesReceived: parsed.byteLength,
          byteLength: parsed.byteLength,
          sha256: parsed.sha256,
        });
        await this.emitApplicationSucceeded(
          state,
          this.verificationDetails(state),
        );
        await verifiedStatus;
        const acknowledged: ControlVerifiedAck = {
          type: "verified-ack",
          transferId: state.transferId,
        };
        if (!state.dataChannel || state.dataChannel.readyState !== "open") {
          throw new DirectTransportError(
            "The data channel closed before verification acknowledgement",
          );
        }
        state.dataChannel.send(JSON.stringify(acknowledged));
        state.completionPhase = "closing-transport";
        this.startCleanupTimer(state);
        return;
      }
      if (isVerifiedAckControl(parsed)) {
        if (
          state.role !== "responder" ||
          state.applicationResult !== "succeeded" ||
          state.completionPhase !== "awaiting-verified-ack" ||
          parsed.transferId !== state.transferId
        ) {
          throw new DirectTransportError(
            "The direct verification acknowledgement is invalid",
          );
        }
        state.completionPhase = "closing-transport";
        this.cleanup(state);
        return;
      }
      if (!isStartControl(parsed)) {
        if (isEndControl(parsed)) {
          await this.finishReceive(state, parsed);
          return;
        }
        throw new DirectTransportError("The direct control frame is invalid");
      }
      if (
        state.role !== "responder" ||
        parsed.transferId !== state.transferId
      ) {
        throw new DirectTransportError("The direct start frame is invalid");
      }
      if (state.receivedStart) {
        throw new DirectTransportError("The direct start frame was repeated");
      }
      if (
        parsed.chunkCount !==
        Math.ceil(parsed.byteLength / this.dependencies.chunkSize)
      ) {
        throw new DirectTransportError("The direct chunk count is invalid");
      }
      state.expectedByteLength = parsed.byteLength;
      state.expectedSha256 = parsed.sha256;
      state.expectedChunkCount = parsed.chunkCount;
      state.receivedChunks = [];
      state.receivedChunkCount = 0;
      state.receivedByteLength = 0;
      state.receivedStart = true;
      state.state = "receiving";
      await this.emitStatus(state, "receiving", {
        byteLength: parsed.byteLength,
      });
      return;
    }
    const chunk = asArrayBuffer(raw);
    if (state.applicationMode === "clipboard") {
      if (!chunk || !state.receivedStart) {
        throw new DirectTransportError("The direct clipboard chunk arrived before its manifest");
      }
      if (chunk.byteLength > DIRECT_APPLICATION_MAX_FRAME_BYTES) {
        throw new DirectTransportError("The direct clipboard chunk is too large");
      }
      await this.emitApplicationFrame(state, {
        type: "clipboard-secure-chunk",
        data: bytesToBase64(new Uint8Array(chunk)),
      });
      return;
    }
    if (!chunk || !state.receivedStart || state.receivedChunks === undefined) {
      throw new DirectTransportError(
        "The direct binary chunk arrived out of order",
      );
    }
    if (chunk.byteLength > this.dependencies.chunkSize) {
      throw new DirectTransportError("The direct binary chunk is too large");
    }
    const nextByteLength = (state.receivedByteLength ?? 0) + chunk.byteLength;
    if (
      nextByteLength >
      (state.expectedByteLength ?? DIRECT_MAX_TEST_PAYLOAD_BYTES)
    ) {
      throw new DirectTransportError(
        "The direct transfer exceeded its declared length",
      );
    }
    state.receivedChunks.push(chunk);
    state.receivedChunkCount = (state.receivedChunkCount ?? 0) + 1;
    state.receivedByteLength = nextByteLength;
    await this.emitStatus(state, "receiving", {
      bytesReceived: nextByteLength,
      byteLength: state.expectedByteLength,
    });
  }

  private async finishReceive(
    state: TransferState,
    control: ControlEnd,
  ): Promise<void> {
    if (
      state.role !== "responder" ||
      !state.receivedStart ||
      control.transferId !== state.transferId ||
      state.receivedEnd ||
      !state.receivedChunks ||
      state.receivedChunkCount !== state.expectedChunkCount
    ) {
      throw new DirectTransportError("The direct completion frame is invalid");
    }
    state.receivedEnd = true;
    const total = state.receivedByteLength ?? 0;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of state.receivedChunks) {
      bytes.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    if (offset !== state.expectedByteLength) {
      throw new DirectTransportError(
        "The direct byte length verification failed",
      );
    }
    const hash = await sha256Hex(bytes);
    if (hash !== state.expectedSha256) {
      throw new DirectTransportError("The direct SHA-256 verification failed");
    }
    const acknowledged: ControlVerified = {
      type: "verified",
      transferId: state.transferId,
      byteLength: total,
      sha256: hash,
    };
    this.markApplicationSucceeded(state);
    state.completionPhase = "awaiting-verified-ack";
    state.state = "verified";
    const verifiedStatus = this.emitStatus(state, "verified", {
      bytesReceived: total,
      byteLength: total,
      sha256: hash,
    });
    await this.emitApplicationSucceeded(state, {
      bytesReceived: total,
      byteLength: total,
      sha256: hash,
    });
    await verifiedStatus;
    if (!state.dataChannel || state.dataChannel.readyState !== "open") {
      this.handleTransportFailure(state, "The data channel closed before verification");
      return;
    }
    state.dataChannel.send(JSON.stringify(acknowledged));
    this.startCleanupTimer(state);
  }

  private async emitSignal(
    state: TransferState,
    signal: DirectSignalBody,
  ): Promise<void> {
    await this.dependencies.emit({
      kind: "signal",
      transferId: state.transferId,
      remoteDeviceId: state.remoteDeviceId,
      signal,
    });
  }

  private async emitApplicationFrame(
    state: TransferState,
    frame:
      | { type: "clipboard-secure-start"; manifest: string }
      | { type: "clipboard-secure-chunk"; data: string },
  ): Promise<void> {
    await this.dependencies.emit({
      kind: "application-frame",
      transferId: state.transferId,
      remoteDeviceId: state.remoteDeviceId,
      frame,
    });
  }

  private verificationDetails(state: TransferState): Record<string, unknown> {
    return {
      bytesReceived: state.expectedByteLength,
      byteLength: state.expectedByteLength,
      sha256: state.expectedSha256,
    };
  }

  private async emitStatus(
    state: TransferState,
    status: DirectTransferState,
    details: Partial<DirectManagerEvent & { kind: "status" }> = {},
  ): Promise<void> {
    await this.dependencies.emit({
      kind: "status",
      transferId: state.transferId,
      remoteDeviceId: state.remoteDeviceId,
      state: status,
      startedAt: new Date(state.createdAt).toISOString(),
      ...details,
    });
  }

  private markApplicationSucceeded(state: TransferState): void {
    if (this.transfers.get(state.transferId) !== state) return;
    if (state.applicationResult === "failed") return;
    state.applicationResult = "succeeded";
  }

  private async emitApplicationSucceeded(
    state: TransferState,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (this.transfers.get(state.transferId) !== state) return;
    if (
      state.applicationResult !== "succeeded" ||
      state.succeededStatusEmitted
    ) {
      return;
    }
    state.succeededStatusEmitted = true;
    state.state = "succeeded";
    await this.emitStatus(state, "succeeded", {
      ...details,
      finishedAt: this.dependencies.now().toISOString(),
    } as Partial<DirectManagerEvent & { kind: "status" }>);
  }

  private cancelState(state: TransferState, reason: string): void {
    if (this.transfers.get(state.transferId) !== state) return;
    if (state.applicationResult === "succeeded") {
      this.cleanup(state);
      return;
    }
    state.applicationResult = "failed";
    state.state = "cancelled";
    void this.emitStatus(state, "cancelled", {
      error: reason,
      finishedAt: this.dependencies.now().toISOString(),
    });
    this.cleanup(state);
  }

  private fail(state: TransferState, reason: string): void {
    if (this.transfers.get(state.transferId) !== state) return;
    if (state.applicationResult === "succeeded") {
      this.cleanup(state);
      return;
    }
    if (state.applicationResult === "failed") {
      this.cleanup(state);
      return;
    }
    state.applicationResult = "failed";
    state.state = "failed";
    void this.emitStatus(state, "failed", {
      error: reason,
      finishedAt: this.dependencies.now().toISOString(),
    });
    this.cleanup(state);
  }

  private handleTransportFailure(state: TransferState, reason: string): void {
    if (state.applicationResult === "succeeded") {
      this.cleanup(state);
      return;
    }
    this.fail(state, reason);
  }

  private armTransferTimer(
    state: TransferState,
    delayMs: number,
    reason: string,
  ): void {
    if (state.transferTimer !== undefined) clearTimeout(state.transferTimer);
    state.transferTimer = setTimeout(
      () => this.handleTransportFailure(state, reason),
      Math.max(0, delayMs),
    );
  }

  private armClipboardTransferTimer(state: TransferState): boolean {
    const expiresAtMs = state.clipboardExpiresAtMs;
    if (expiresAtMs === undefined) {
      this.handleTransportFailure(
        state,
        "The direct clipboard expiry is missing",
      );
      return false;
    }
    const remainingMs = expiresAtMs - this.dependencies.now().getTime();
    if (remainingMs <= 0) {
      this.handleTransportFailure(state, "Direct clipboard transfer expired");
      return false;
    }
    this.armTransferTimer(state, remainingMs, "Direct clipboard transfer expired");
    return true;
  }

  private startCleanupTimer(state: TransferState): void {
    if (this.transfers.get(state.transferId) !== state) return;
    if (state.transferTimer !== undefined) {
      clearTimeout(state.transferTimer);
      state.transferTimer = undefined;
    }
    if (state.cleanupTimer !== undefined) clearTimeout(state.cleanupTimer);
    state.cleanupTimer = setTimeout(
      () => this.cleanup(state),
      this.dependencies.cleanupTimeoutMs,
    );
  }

  private clearConnectionTimer(state: TransferState): void {
    if (state.connectionTimer !== undefined) {
      clearTimeout(state.connectionTimer);
      state.connectionTimer = undefined;
    }
  }

  private cleanup(state: TransferState): void {
    if (this.transfers.get(state.transferId) !== state) return;
    this.clearConnectionTimer(state);
    if (state.transferTimer !== undefined) clearTimeout(state.transferTimer);
    if (state.cleanupTimer !== undefined) clearTimeout(state.cleanupTimer);
    state.transferTimer = undefined;
    state.cleanupTimer = undefined;
    this.transfers.delete(state.transferId);
    try {
      state.dataChannel?.close();
    } catch {
      // Cleanup is best effort after a direct transfer has ended.
    }
    try {
      state.peerConnection.close();
    } catch {
      // Cleanup is best effort after a direct transfer has ended.
    }
  }
}

export type { DataChannelLike, PeerConnectionLike };
