import {
  DIRECT_BUFFER_HIGH_WATER,
  DIRECT_BUFFER_LOW_THRESHOLD,
  DIRECT_CHUNK_SIZE,
  DIRECT_CONNECTION_TIMEOUT_MS,
  DIRECT_DATA_CHANNEL_LABEL,
  DIRECT_MAX_CONCURRENT_TRANSFERS,
  DIRECT_MAX_ICE_CANDIDATES,
  DIRECT_MAX_TEST_PAYLOAD_BYTES,
  DIRECT_TEST_PAYLOAD_BYTES,
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
  addEventListener?: (type: string, listener: (...args: unknown[]) => void) => void;
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
  createDataChannel(label: string, options?: { ordered: boolean }): DataChannelLike;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: DirectIceCandidate): Promise<void>;
  close(): void;
}

export interface DirectPeerManagerDependencies {
  peerConnectionFactory?: (configuration: RTCConfiguration) => PeerConnectionLike;
  emit(event: DirectManagerEvent): Promise<void> | void;
  now?: () => Date;
  chunkSize?: number;
  maxConcurrentTransfers?: number;
  connectionTimeoutMs?: number;
  transferTimeoutMs?: number;
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
  connectionTimer?: ReturnType<typeof setTimeout>;
  transferTimer?: ReturnType<typeof setTimeout>;
  testBytes?: Uint8Array;
  expectedByteLength?: number;
  expectedSha256?: string;
  receivedChunks?: ArrayBuffer[];
  expectedChunkCount?: number;
  receivedChunkCount?: number;
  receivedByteLength?: number;
  receivedStart?: boolean;
  receivedEnd?: boolean;
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

function isControlObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStartControl(value: unknown): value is ControlStart {
  if (!isControlObject(value)) return false;
  const candidate = value as Partial<ControlStart>;
  return (
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
    value.type === "end" &&
    typeof value.transferId === "string"
  );
}

function isVerifiedControl(value: unknown): value is ControlVerified {
  return (
    isControlObject(value) &&
    value.type === "verified" &&
    typeof value.transferId === "string" &&
    Number.isSafeInteger(value.byteLength) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  );
}

function asArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
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
  const json = typeof candidate.toJSON === "function" ? candidate.toJSON() : value;
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
  private readonly pendingCandidates = new Map<string, DirectIceCandidate[]>();

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
    if (this.transfers.size >= this.dependencies.maxConcurrentTransfers) {
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
      this.fail(state, error instanceof Error ? error.message : "Offer failed");
      throw new DirectTransportError("Unable to create the direct offer");
    }
  }

  async handleSignal(signal: DirectSignalDelivery): Promise<void> {
    try {
      await this.handleSignalInternal(signal);
    } catch (error) {
      const state = this.transfers.get(signal.transferId);
      if (state && state.remoteDeviceId === signal.sourceDeviceId) {
        this.fail(
          state,
          error instanceof Error ? error.message : "Direct signalling failed",
        );
      } else if (!state) {
        this.pendingCandidates.delete(signal.transferId);
      }
      throw error;
    }
  }

  private async handleSignalInternal(signal: DirectSignalDelivery): Promise<void> {
    if (signal.kind === "cancel") {
      const state = this.transfers.get(signal.transferId);
      if (state) this.cancelState(state, signal.reason ?? "Remote cancelled");
      this.pendingCandidates.delete(signal.transferId);
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
    if (!state || state.role !== "initiator" || state.remoteDeviceId !== signal.sourceDeviceId) {
      throw new DirectTransportError("The direct answer does not match an active transfer");
    }
    if (typeof signal.sdp !== "string" || signal.sdp.length === 0) {
      throw new DirectTransportError("The direct answer is missing SDP");
    }
    await state.peerConnection.setRemoteDescription({ type: "answer", sdp: signal.sdp });
    state.remoteDescriptionSet = true;
    await this.flushCandidates(state);
  }

  async cancelTransfer(transferId: string, reason = "Cancelled"): Promise<void> {
    const state = this.transfers.get(transferId);
    this.pendingCandidates.delete(transferId);
    if (!state) return;
    await this.emitSignal(state, { kind: "cancel", reason }).catch(() => undefined);
    this.cancelState(state, reason);
  }

  async cancelAll(reason = "Transport unavailable"): Promise<void> {
    await Promise.all(
      [...this.transfers.keys()].map((transferId) =>
        this.cancelTransfer(transferId, reason),
      ),
    );
    this.pendingCandidates.clear();
  }

  private createTransfer(
    transferId: string,
    remoteDeviceId: string,
    role: "initiator" | "responder",
  ): TransferState {
    const peerConnection = this.peerConnectionFactory({ iceServers: [] });
    const state: TransferState = {
      transferId,
      remoteDeviceId,
      role,
      peerConnection,
      pendingCandidates: this.pendingCandidates.get(transferId) ?? [],
      remoteDescriptionSet: false,
      createdAt: this.dependencies.now().getTime(),
      state: "connecting",
    };
    this.pendingCandidates.delete(transferId);
    this.transfers.set(transferId, state);
    peerConnection.onicecandidate = (event) => {
      const candidate = candidateFromEvent(event.candidate);
      if (!candidate) return;
      void this.emitSignal(state, { kind: "ice-candidate", candidate }).catch(
        () => this.fail(state, "ICE signalling failed"),
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
      if (
        connectionState === "failed" ||
        connectionState === "closed" ||
        connectionState === "disconnected"
      ) {
        this.fail(state, `Peer connection ${connectionState}`);
      }
    };
    state.connectionTimer = setTimeout(
      () => this.fail(state, "Direct connection timed out"),
      this.dependencies.connectionTimeoutMs,
    );
    void this.emitStatus(state, "connecting");
    return state;
  }

  private async handleOffer(signal: DirectSignalDelivery): Promise<void> {
    let state = this.transfers.get(signal.transferId);
    if (state) {
      if (state.role !== "responder" || state.remoteDeviceId !== signal.sourceDeviceId) {
        throw new DirectTransportError("The direct offer conflicts with an active transfer");
      }
    } else {
      if (this.transfers.size >= this.dependencies.maxConcurrentTransfers) {
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
    await state.peerConnection.setRemoteDescription({ type: "offer", sdp: signal.sdp });
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
      if (
        !this.pendingCandidates.has(signal.transferId) &&
        this.transfers.size + this.pendingCandidates.size >=
          this.dependencies.maxConcurrentTransfers
      ) {
        throw new DirectTransportError(
          "The maximum number of direct transfers is already active",
        );
      }
      const candidates = this.pendingCandidates.get(signal.transferId) ?? [];
      if (candidates.length >= DIRECT_MAX_ICE_CANDIDATES) {
        throw new DirectTransportError("Too many ICE candidates for the transfer");
      }
      candidates.push(signal.candidate);
      this.pendingCandidates.set(signal.transferId, candidates);
      return;
    }
    if (state.remoteDeviceId !== signal.sourceDeviceId) {
      throw new DirectTransportError("The ICE candidate source does not match the transfer");
    }
    if (!state.remoteDescriptionSet) {
      if (state.pendingCandidates.length >= DIRECT_MAX_ICE_CANDIDATES) {
        throw new DirectTransportError("Too many ICE candidates for the transfer");
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

  private attachDataChannel(state: TransferState, channel: DataChannelLike): void {
    state.dataChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = DIRECT_BUFFER_LOW_THRESHOLD;
    channel.onopen = () => {
      if (this.transfers.get(state.transferId) !== state) return;
      this.clearConnectionTimer(state);
      state.transferTimer = setTimeout(
        () => this.fail(state, "Direct transfer timed out"),
        this.dependencies.transferTimeoutMs,
      );
      state.state = "open";
      void this.emitStatus(state, "open");
      if (state.role === "initiator") void this.sendTestPayload(state);
    };
    channel.onmessage = (event) => {
      void this.handleDataMessage(state, event.data).catch((error: unknown) => {
        this.fail(state, error instanceof Error ? error.message : "Data channel failed");
      });
    };
    channel.onerror = () => this.fail(state, "Data channel error");
    channel.onclose = () => {
      if (this.transfers.get(state.transferId) === state) {
        this.fail(state, "Data channel closed before verification");
      }
    };
  }

  private async sendTestPayload(state: TransferState): Promise<void> {
    if (!state.dataChannel || state.dataChannel.readyState !== "open") return;
    try {
      const bytes = deterministicTestBytes(state.transferId, DIRECT_TEST_PAYLOAD_BYTES);
      state.testBytes = bytes;
      state.expectedByteLength = bytes.byteLength;
      state.expectedSha256 = await sha256Hex(bytes);
      const chunkCount = Math.ceil(bytes.byteLength / this.dependencies.chunkSize);
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
      for (let offset = 0; offset < bytes.byteLength; offset += this.dependencies.chunkSize) {
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
    } catch (error) {
      this.fail(state, error instanceof Error ? error.message : "Direct send failed");
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
        finish(new DirectTransportError("Data channel closed while backpressured"));
      };
      if (channel.readyState !== "open") {
        finish(new DirectTransportError("Data channel closed while backpressured"));
      }
    });
  }

  private async handleDataMessage(state: TransferState, raw: unknown): Promise<void> {
    if (typeof raw === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new DirectTransportError("The direct control frame is invalid");
      }
      if (isVerifiedControl(parsed)) {
        if (
          state.role !== "initiator" ||
          parsed.transferId !== state.transferId ||
          parsed.byteLength !== state.expectedByteLength ||
          parsed.sha256 !== state.expectedSha256
        ) {
          throw new DirectTransportError("The direct verification acknowledgement is invalid");
        }
        state.state = "verified";
        await this.emitStatus(state, "verified", {
          bytesReceived: parsed.byteLength,
          byteLength: parsed.byteLength,
          sha256: parsed.sha256,
        });
        this.succeed(state, {
          bytesReceived: parsed.byteLength,
          byteLength: parsed.byteLength,
          sha256: parsed.sha256,
        });
        return;
      }
      if (!isStartControl(parsed)) {
        if (isEndControl(parsed)) {
          await this.finishReceive(state, parsed);
          return;
        }
        throw new DirectTransportError("The direct control frame is invalid");
      }
      if (state.role !== "responder" || parsed.transferId !== state.transferId) {
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
      await this.emitStatus(state, "receiving", { byteLength: parsed.byteLength });
      return;
    }
    const chunk = asArrayBuffer(raw);
    if (!chunk || !state.receivedStart || state.receivedChunks === undefined) {
      throw new DirectTransportError("The direct binary chunk arrived out of order");
    }
    if (chunk.byteLength > this.dependencies.chunkSize) {
      throw new DirectTransportError("The direct binary chunk is too large");
    }
    const nextByteLength = (state.receivedByteLength ?? 0) + chunk.byteLength;
    if (nextByteLength > (state.expectedByteLength ?? DIRECT_MAX_TEST_PAYLOAD_BYTES)) {
      throw new DirectTransportError("The direct transfer exceeded its declared length");
    }
    state.receivedChunks.push(chunk);
    state.receivedChunkCount = (state.receivedChunkCount ?? 0) + 1;
    state.receivedByteLength = nextByteLength;
    await this.emitStatus(state, "receiving", {
      bytesReceived: nextByteLength,
      byteLength: state.expectedByteLength,
    });
  }

  private async finishReceive(state: TransferState, control: ControlEnd): Promise<void> {
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
      throw new DirectTransportError("The direct byte length verification failed");
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
    if (!state.dataChannel || state.dataChannel.readyState !== "open") {
      throw new DirectTransportError("The data channel closed before verification");
    }
    state.dataChannel.send(JSON.stringify(acknowledged));
    state.state = "verified";
    await this.emitStatus(state, "verified", {
      bytesReceived: total,
      byteLength: total,
      sha256: hash,
    });
    this.succeed(state, { bytesReceived: total, byteLength: total, sha256: hash });
  }

  private async emitSignal(state: TransferState, signal: DirectSignalBody): Promise<void> {
    await this.dependencies.emit({
      kind: "signal",
      transferId: state.transferId,
      remoteDeviceId: state.remoteDeviceId,
      signal,
    });
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

  private succeed(state: TransferState, details: Record<string, unknown>): void {
    if (this.transfers.get(state.transferId) !== state) return;
    state.state = "succeeded";
    void this.emitStatus(state, "succeeded", {
      ...details,
      finishedAt: this.dependencies.now().toISOString(),
    } as Partial<DirectManagerEvent & { kind: "status" }>);
    this.cleanup(state);
  }

  private cancelState(state: TransferState, reason: string): void {
    if (this.transfers.get(state.transferId) !== state) return;
    state.state = "cancelled";
    void this.emitStatus(state, "cancelled", {
      error: reason,
      finishedAt: this.dependencies.now().toISOString(),
    });
    this.cleanup(state);
  }

  private fail(state: TransferState, reason: string): void {
    if (this.transfers.get(state.transferId) !== state) return;
    state.state = "failed";
    void this.emitStatus(state, "failed", {
      error: reason,
      finishedAt: this.dependencies.now().toISOString(),
    });
    this.cleanup(state);
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
