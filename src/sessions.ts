import * as grpc from "@grpc/grpc-js";

import {
  AuthenticationError,
  InvalidRequestError,
  SandboxDeletedError,
  SandboxFailedError,
  TimeoutError,
} from "./errors.js";
import { mapRpcError } from "./grpc-errors.js";
import { validateResizeDimension } from "./session.js";
import { Deadline } from "./transport.js";
import { Exit, Status, Stdout } from "./types.js";
import type { Sandbox } from "./sandbox.js";
import {
  SessionStatus as ProtoSessionStatus,
  type AttachSessionRequest,
  type AttachSessionResponse,
  type SessionInfo as ProtoSessionInfo,
} from "./proto/tyto/runtime/v1/guest.js";
import { AttachEnded_Reason } from "./proto/tyto/runtime/v1/guest.js";

const SESSION_NAME_FIRST = /^[a-z]$/;
const SESSION_NAME_REST = /^[a-z0-9-]$/;
const MAX_SESSION_NAME_LENGTH = 32;

export enum SessionStatus {
  UNSPECIFIED = "unspecified",
  STARTING = "starting",
  IDLE = "idle",
  ATTACHED = "attached",
  EXITED = "exited",
  KILLED = "killed",
  FAILED = "failed",
}

export enum SessionEndedReason {
  UNSPECIFIED = "unspecified",
  DETACHED = "detached",
  TAKEOVER = "takeover",
}

export interface SessionInfo {
  readonly name: string;
  readonly command: readonly string[];
  readonly workingDir: string;
  readonly status: SessionStatus;
  readonly attached: boolean;
  readonly startedAt: Date;
  readonly lastActivityAt: Date;
  readonly endedAt: Date | undefined;
  readonly exit: Exit | undefined;
}

export class SessionEnded {
  readonly reason: SessionEndedReason;
  constructor(reason: SessionEndedReason) {
    this.reason = reason;
  }
}

export class SessionOutputDropped {
  readonly droppedBytes: number;
  constructor(droppedBytes: number) {
    this.droppedBytes = droppedBytes;
  }
}

export type SessionEvent = Stdout | Exit | SessionEnded | SessionOutputDropped;

export class SessionList implements Iterable<SessionInfo> {
  readonly sessions: readonly SessionInfo[];
  readonly sandboxSuspended: boolean;

  constructor(sessions: readonly SessionInfo[], sandboxSuspended: boolean) {
    this.sessions = sessions;
    this.sandboxSuspended = sandboxSuspended;
  }

  get length(): number {
    return this.sessions.length;
  }

  [Symbol.iterator](): Iterator<SessionInfo> {
    return this.sessions[Symbol.iterator]();
  }
}

const END_REQUESTS = Symbol("end-requests");
type ResponseItem = SessionEvent | AcceptedMarker | { error: unknown } | typeof END_REQUESTS;

/**
 * A live attach to a managed session. Mirrors ExecSession's streaming
 * mechanics but proxies AttachSession instead of Exec: the constructor
 * resolves once the first (accepted) frame arrives, so `info`,
 * `replayedBytes`, and `historyDropped` are available immediately via
 * `SessionStream.open(...)`, before any iteration.
 */
export class SessionStream implements AsyncIterable<SessionEvent> {
  private readonly sandboxId: string;
  readonly name: string;
  private readonly secrets: readonly (string | undefined)[];
  private readonly deadline: Deadline;

  info!: SessionInfo;
  replayedBytes = 0;
  historyDropped = false;
  cols = 0;
  rows = 0;

  private closed = false;
  private requestEnded = false;
  private readonly inbound: ResponseItem[] = [];
  private inboundWaiters: Array<() => void> = [];
  private stream!: grpc.ClientDuplexStream<AttachSessionRequest, AttachSessionResponse>;

  private constructor(sandboxId: string, name: string, secrets: readonly (string | undefined)[], timeout: number) {
    this.sandboxId = sandboxId;
    this.name = name;
    this.secrets = secrets;
    this.deadline = Deadline.start(timeout);
  }

  static async open(options: {
    sandboxId: string;
    name: string;
    cols: number;
    rows: number;
    maxReplayBytes: number;
    stub: { attachSession(metadata: grpc.Metadata): grpc.ClientDuplexStream<AttachSessionRequest, AttachSessionResponse> };
    capability: string;
    timeout: number;
    secrets: readonly (string | undefined)[];
  }): Promise<SessionStream> {
    const instance = new SessionStream(options.sandboxId, options.name, options.secrets, options.timeout);
    const metadata = new grpc.Metadata();
    metadata.add("bonya-sandbox-id", options.sandboxId);
    metadata.add("bonya-exec-capability", options.capability);

    instance.stream = options.stub.attachSession(metadata);
    instance.stream.on("data", (response: AttachSessionResponse) => instance.handleResponse(response));
    instance.stream.on("end", () => instance.pushInbound(END_REQUESTS));
    instance.stream.on("error", (error: unknown) => instance.handleStreamError(error));

    instance.stream.write({
      start: { name: options.name, cols: options.cols, rows: options.rows, maxReplayBytes: options.maxReplayBytes },
    });

    const first = await instance.takeInboundRaw();
    if (first === END_REQUESTS) {
      throw new InvalidRequestError("AttachSession stream ended before an accepted frame", { sandboxId: options.sandboxId });
    }
    if (isErrorItem(first)) {
      throw first.error;
    }
    if (!(first instanceof AcceptedMarker)) {
      throw new InvalidRequestError("AttachSession response did not begin with an accepted frame", {
        sandboxId: options.sandboxId,
      });
    }
    instance.info = sessionInfoFromProto(first.session);
    instance.replayedBytes = first.replayedBytes;
    instance.historyDropped = first.historyDropped;
    instance.cols = first.cols;
    instance.rows = first.rows;
    return instance;
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return {
      next: async (): Promise<IteratorResult<SessionEvent>> => {
        const item = await this.takeInboundRaw();
        if (item === END_REQUESTS) {
          return { done: true, value: undefined };
        }
        if (isErrorItem(item)) {
          throw item.error;
        }
        if (item instanceof AcceptedMarker) {
          // Should not occur post-admission; treat defensively as an empty step.
          return this[Symbol.asyncIterator]().next();
        }
        return { done: false, value: item as SessionEvent };
      },
    };
  }

  write(data: Uint8Array): void {
    if (this.closed) {
      throw new InvalidRequestError("session is closed", { sandboxId: this.sandboxId });
    }
    this.stream.write({ stdin: { data: Buffer.from(data) } });
  }

  resize(options: { cols: number; rows: number }): void {
    const cols = validateResizeDimension("cols", options.cols);
    const rows = validateResizeDimension("rows", options.rows);
    if (this.closed) {
      throw new InvalidRequestError("session is closed", { sandboxId: this.sandboxId });
    }
    this.stream.write({ resize: { cols, rows } });
  }

  detach(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (!this.requestEnded) {
      this.stream.write({ detach: {} });
      this.stream.end();
    } else {
      this.stream.cancel();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.detach();
  }

  private handleResponse(response: AttachSessionResponse): void {
    if (response.accepted) {
      this.pushInbound(
        new AcceptedMarker(
          response.accepted.session,
          response.accepted.replayedBytes,
          response.accepted.historyDropped,
          response.accepted.cols,
          response.accepted.rows,
        ),
      );
      return;
    }
    if (response.output) {
      this.pushInbound(new Stdout(new Uint8Array(response.output.data)));
      return;
    }
    if (response.exit) {
      const event = new Exit(response.exit.exitCode, response.exit.signaled, response.exit.signal);
      this.pushInbound(event);
      this.pushInbound(END_REQUESTS);
      this.closed = true;
      return;
    }
    if (response.ended) {
      const event = new SessionEnded(sessionEndedReasonFromProto(response.ended.reason));
      this.pushInbound(event);
      this.pushInbound(END_REQUESTS);
      this.closed = true;
      return;
    }
    if (response.outputDropped) {
      this.pushInbound(new SessionOutputDropped(response.outputDropped.droppedBytes));
      return;
    }
    this.pushInbound({ error: new InvalidRequestError("AttachSession response contained no frame", { sandboxId: this.sandboxId }) });
  }

  private handleStreamError(error: unknown): void {
    if (this.closed) {
      this.pushInbound(END_REQUESTS);
      return;
    }
    const mapped = mapRpcError(error, { secrets: this.secrets, sandboxId: this.sandboxId, sessionRpc: true });
    this.pushInbound({ error: mapped });
  }

  private pushInbound(item: ResponseItem): void {
    this.inbound.push(item);
    const waiter = this.inboundWaiters.shift();
    waiter?.();
  }

  private async takeInboundRaw(): Promise<ResponseItem> {
    const item = this.inbound.shift();
    if (item !== undefined) {
      return item;
    }
    const remaining = this.deadline.expiresAt - now();
    if (remaining <= 0) {
      this.close();
      throw new TimeoutError("session attach timed out", { sandboxId: this.sandboxId });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new TimeoutError("session attach timed out", { sandboxId: this.sandboxId }));
      }, remaining);
      this.inboundWaiters.push(() => {
        clearTimeout(timer);
        const next = this.inbound.shift();
        resolve(next ?? END_REQUESTS);
      });
    });
  }
}

class AcceptedMarker {
  constructor(
    readonly session: ProtoSessionInfo | undefined,
    readonly replayedBytes: number,
    readonly historyDropped: boolean,
    readonly cols: number,
    readonly rows: number,
  ) {}
}

function isErrorItem(item: ResponseItem): item is { error: unknown } {
  return typeof item === "object" && item !== null && "error" in item;
}

function now(): number {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1000 + nanoseconds / 1e6;
}

export interface CreateSessionOptions {
  env?: Record<string, string>;
  cwd?: string;
  cols?: number;
  rows?: number;
  replace?: boolean;
}

export interface AttachSessionOptions {
  cols?: number;
  rows?: number;
  maxReplayBytes?: number;
}

/**
 * Managed console session RPC surface: persistent, guest-owned command
 * sessions that outlive the client connection. Capability refresh:
 * UNAUTHENTICATED transparently calls ReissueCapability and retries once,
 * at admission time only; PERMISSION_DENIED never triggers a refresh.
 */
export class SandboxSessions {
  private readonly sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
  }

  /**
   * Creates a named TTY session. Create over an existing record raises
   * SessionExistsError; `replace: true` replaces a terminal record only -- a
   * running or attached session must be killed first.
   */
  async create(name: string, command: readonly string[], options: CreateSessionOptions = {}): Promise<SessionInfo> {
    const validatedName = validateSessionName(name);
    const argv = validateSessionCommand(command);
    const env = validateSessionEnv(options.env);
    const cwd = validateSessionCwd(options.cwd);
    const cols = validateSessionDimension("cols", options.cols ?? 0);
    const rows = validateSessionDimension("rows", options.rows ?? 0);
    const replace = options.replace ?? false;

    return this.withCapabilityRefresh(async () => {
      const request = { name: validatedName, command: argv, env, workingDir: cwd, cols, rows, replace };
      let response: { session?: ProtoSessionInfo };
      try {
        response = await unaryCall(this.stub().createSession, request, this.metadata(), this.timeout());
      } catch (error) {
        throw this.mapError(error);
      }
      return sessionInfoFromProto(response.session);
    });
  }

  /**
   * Lists sessions. Works on a suspended sandbox without waking it: the
   * result's `sandboxSuspended` is true when served from the suspend-time
   * snapshot rather than the live guest.
   */
  async list(): Promise<SessionList> {
    return this.withCapabilityRefresh(async () => {
      let response: { sessions?: ProtoSessionInfo[]; sandboxSuspended?: boolean };
      try {
        response = await unaryCall(this.stub().listSessions, {}, this.metadata(), this.timeout());
      } catch (error) {
        throw this.mapError(error);
      }
      return new SessionList((response.sessions ?? []).map(sessionInfoFromProto), Boolean(response.sandboxSuspended));
    });
  }

  /** Signals (default TERM), then SIGKILL after grace_ms if still alive. */
  async kill(name: string, options: { signal?: string; graceMs?: number } = {}): Promise<SessionInfo> {
    const validatedName = validateSessionName(name);
    const signal = options.signal ?? "TERM";
    if (!signal) {
      throw new InvalidRequestError("signal must be a non-empty string");
    }
    const graceMs = options.graceMs ?? 5000;
    if (!Number.isInteger(graceMs) || graceMs < 0) {
      throw new InvalidRequestError("grace_ms must be a non-negative integer");
    }

    return this.withCapabilityRefresh(async () => {
      let response: { session?: ProtoSessionInfo };
      try {
        response = await unaryCall(
          this.stub().killSession,
          { name: validatedName, signal, graceMs },
          this.metadata(),
          this.timeout(),
        );
      } catch (error) {
        throw this.mapError(error);
      }
      return sessionInfoFromProto(response.session);
    });
  }

  /**
   * Attaches to a session by name, replaying bounded output produced while
   * detached. A second attach preempts an existing one -- the loser's
   * stream ends with a TAKEOVER SessionEnded event.
   */
  async attach(name: string, options: AttachSessionOptions = {}): Promise<SessionStream> {
    const validatedName = validateSessionName(name);
    const cols = validateSessionDimension("cols", options.cols ?? 0);
    const rows = validateSessionDimension("rows", options.rows ?? 0);
    const maxReplayBytes = options.maxReplayBytes ?? 0;
    if (!Number.isInteger(maxReplayBytes) || maxReplayBytes < 0) {
      throw new InvalidRequestError("max_replay_bytes must be a non-negative integer");
    }
    this.ensureSessionsAllowed();

    const openStream = () =>
      SessionStream.open({
        sandboxId: this.sandbox.id,
        name: validatedName,
        cols,
        rows,
        maxReplayBytes,
        stub: this.stub(),
        capability: this.sandbox._capability,
        timeout: this.sandbox._client._timeout,
        secrets: this.sandbox._client._secrets(this.sandbox._capability),
      });

    try {
      return await openStream();
    } catch (error) {
      if (error instanceof AuthenticationError) {
        await this.sandbox.reissueCapability();
        return openStream();
      }
      throw error;
    }
  }

  private async withCapabilityRefresh<T>(call: () => Promise<T>): Promise<T> {
    this.ensureSessionsAllowed();
    try {
      return await call();
    } catch (error) {
      if (error instanceof AuthenticationError) {
        await this.sandbox.reissueCapability();
        return call();
      }
      throw error;
    }
  }

  private ensureSessionsAllowed(): void {
    const sandbox = this.sandbox;
    if (sandbox._deleted || sandbox.lastObservedStatus === Status.DELETED) {
      throw new SandboxDeletedError("sandbox has been deleted", { sandboxId: sandbox.id, operationId: sandbox.operationId });
    }
    if (sandbox.lastObservedStatus === Status.FAILED) {
      const message = sandbox._failureMessage || sandbox._failureCode || "sandbox failed";
      throw new SandboxFailedError(message, { sandboxId: sandbox.id, operationId: sandbox.operationId });
    }
  }

  private stub() {
    return this.sandbox._client._execStub(this.sandbox._execEndpoint);
  }

  private timeout(): Deadline {
    return Deadline.start(this.sandbox._client._timeout);
  }

  private metadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    metadata.add("bonya-sandbox-id", this.sandbox.id);
    metadata.add("bonya-exec-capability", this.sandbox._capability);
    return metadata;
  }

  private mapError(error: unknown): unknown {
    return mapRpcError(error, {
      secrets: this.sandbox._client._secrets(this.sandbox._capability),
      sandboxId: this.sandbox.id,
      operationId: this.sandbox.operationId,
      sessionRpc: true,
    });
  }
}

function unaryCall<Req, Res>(
  method: (
    request: Req,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: Res) => void,
  ) => grpc.ClientUnaryCall,
  request: Req,
  metadata: grpc.Metadata,
  deadline: Deadline,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    method(request, metadata, { deadline: deadline.deadlineDate() }, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

function validateSessionName(name: unknown): string {
  if (typeof name !== "string" || !name) {
    throw new InvalidRequestError("session name must be a non-empty string");
  }
  if (name.length > MAX_SESSION_NAME_LENGTH) {
    throw new InvalidRequestError(`session name must be at most ${MAX_SESSION_NAME_LENGTH} characters`);
  }
  if (!SESSION_NAME_FIRST.test(name[0] ?? "") || !Array.from(name.slice(1)).every((c) => SESSION_NAME_REST.test(c))) {
    throw new InvalidRequestError("session name must match ^[a-z][a-z0-9-]{0,31}$");
  }
  return name;
}

function validateSessionCommand(command: unknown): string[] {
  if (typeof command === "string" || !Array.isArray(command)) {
    throw new InvalidRequestError("command must be a non-empty sequence of strings");
  }
  const argv = [...command];
  if (argv.length === 0 || argv.some((arg) => typeof arg !== "string" || arg === "")) {
    throw new InvalidRequestError("command must be a non-empty sequence of non-empty strings");
  }
  return argv;
}

function validateSessionEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (env === undefined) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key || key.includes("=") || key.includes("\0")) {
      throw new InvalidRequestError("env keys must be non-empty strings without '=' or NUL");
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new InvalidRequestError("env values must be strings without NUL");
    }
    normalized[key] = value;
  }
  return normalized;
}

function validateSessionCwd(cwd: string | undefined): string {
  if (cwd === undefined) {
    return "";
  }
  if (!cwd || cwd.includes("\0")) {
    throw new InvalidRequestError("cwd must be a non-empty string without NUL");
  }
  return cwd;
}

function validateSessionDimension(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 512) {
    throw new InvalidRequestError(`${name} must be a non-negative integer <= 512`);
  }
  return value;
}

function sessionInfoFromProto(info: ProtoSessionInfo | undefined): SessionInfo {
  if (!info) {
    return {
      name: "",
      command: [],
      workingDir: "",
      status: SessionStatus.UNSPECIFIED,
      attached: false,
      startedAt: new Date(0),
      lastActivityAt: new Date(0),
      endedAt: undefined,
      exit: undefined,
    };
  }
  const endedAtNanos = Number(info.endedAtUnixNanos ?? 0);
  return {
    name: info.name ?? "",
    command: info.command ?? [],
    workingDir: info.workingDir ?? "",
    status: sessionStatusFromProto(info.status ?? ProtoSessionStatus.SESSION_STATUS_UNSPECIFIED),
    attached: Boolean(info.attached),
    startedAt: new Date(Number(info.startedAtUnixNanos ?? 0) / 1e6),
    lastActivityAt: new Date(Number(info.lastActivityUnixNanos ?? 0) / 1e6),
    endedAt: endedAtNanos ? new Date(endedAtNanos / 1e6) : undefined,
    exit: info.exit ? new Exit(info.exit.exitCode, info.exit.signaled, info.exit.signal) : undefined,
  };
}

function sessionStatusFromProto(value: ProtoSessionStatus): SessionStatus {
  switch (value) {
    case ProtoSessionStatus.SESSION_STATUS_STARTING:
      return SessionStatus.STARTING;
    case ProtoSessionStatus.SESSION_STATUS_IDLE:
      return SessionStatus.IDLE;
    case ProtoSessionStatus.SESSION_STATUS_ATTACHED:
      return SessionStatus.ATTACHED;
    case ProtoSessionStatus.SESSION_STATUS_EXITED:
      return SessionStatus.EXITED;
    case ProtoSessionStatus.SESSION_STATUS_KILLED:
      return SessionStatus.KILLED;
    case ProtoSessionStatus.SESSION_STATUS_FAILED:
      return SessionStatus.FAILED;
    default:
      // SESSION_STATUS_UNSPECIFIED (0) is a value real, compatible servers
      // can send deliberately, and any other unrecognized value (e.g. a
      // newer server) degrades the same way rather than throwing.
      return SessionStatus.UNSPECIFIED;
  }
}

function sessionEndedReasonFromProto(value: AttachEnded_Reason): SessionEndedReason {
  switch (value) {
    case AttachEnded_Reason.REASON_DETACHED:
      return SessionEndedReason.DETACHED;
    case AttachEnded_Reason.REASON_TAKEOVER:
      return SessionEndedReason.TAKEOVER;
    default:
      return SessionEndedReason.UNSPECIFIED;
  }
}
