import * as grpc from "@grpc/grpc-js";

import type { Tyto } from "./client.js";
import { callUnary } from "./client.js";
import {
  CapabilityRejectedError,
  ExecFailedError,
  InvalidRequestError,
  SandboxDeletedError,
  SandboxFailedError,
  SandboxSuspendedError,
} from "./errors.js";
import { isRetryableTransportError, isGrpcServiceError, mapRpcError } from "./grpc-errors.js";
import { SandboxFiles } from "./files.js";
import { SandboxPreviews } from "./previews.js";
import { SandboxSessions } from "./sessions.js";
import { ExecSession } from "./session.js";
import { Deadline, sleepWithDeadline } from "./transport.js";
import { Exit, ExecEvent, Status, Stderr, Stdout } from "./types.js";
import * as grpcStatus from "@grpc/grpc-js";

export interface DeleteResult {
  readonly sandboxId: string;
  readonly alreadyDeleted: boolean;
}

export interface ResumeResult {
  readonly sandboxId: string;
  readonly lifecycleOperationId: string;
  readonly alreadyRunning: boolean;
}

export class Snapshot {
  private readonly client: Tyto;
  readonly id: string;
  readonly sourceSandboxId: string;
  private deleted = false;

  constructor(options: { client: Tyto; snapshotId: string; sourceSandboxId: string }) {
    this.client = options.client;
    this.id = options.snapshotId;
    this.sourceSandboxId = options.sourceSandboxId;
  }

  async delete(): Promise<void> {
    if (this.deleted) {
      return;
    }
    const request = {
      apiKey: this.client._apiKey,
      sourceSandboxId: this.sourceSandboxId,
      snapshotId: this.id,
    };
    const deadline = Deadline.start(this.client._timeout);
    let attempts = 0;
    let backoff = 0.05;
    for (;;) {
      try {
        await callUnary(this.client._tapiStub().deleteSnapshot, request, new grpc.Metadata(), deadline);
        this.deleted = true;
        return;
      } catch (exc) {
        if (!isRetryableTransportError(exc) || attempts >= this.client._maxRetries) {
          throw mapRpcError(exc, { secrets: this.client._secrets(this.id), sandboxId: this.sourceSandboxId });
        }
        attempts += 1;
        await sleepWithDeadline(backoff, deadline);
        backoff = Math.min(backoff * 2, 0.5);
      }
    }
  }
}

export class ExecResult {
  readonly stdoutBytes: Uint8Array;
  readonly stderrBytes: Uint8Array;
  readonly exitCode: number;
  readonly signaled: boolean;
  readonly signal: number;
  readonly sandboxId: string | undefined;

  constructor(options: {
    stdoutBytes: Uint8Array;
    stderrBytes: Uint8Array;
    exitCode: number;
    signaled?: boolean;
    signal?: number;
    sandboxId?: string | undefined;
  }) {
    this.stdoutBytes = options.stdoutBytes;
    this.stderrBytes = options.stderrBytes;
    this.exitCode = options.exitCode;
    this.signaled = options.signaled ?? false;
    this.signal = options.signal ?? 0;
    this.sandboxId = options.sandboxId;
  }

  get stdout(): string {
    return Buffer.from(this.stdoutBytes).toString("utf-8");
  }

  get stderr(): string {
    return Buffer.from(this.stderrBytes).toString("utf-8");
  }

  get ok(): boolean {
    return this.exitCode === 0 && !this.signaled;
  }

  check(): ExecResult {
    if (!this.ok) {
      throw new ExecFailedError(`command failed with exit code ${this.exitCode}`, { result: this });
    }
    return this;
  }

  toString(): string {
    return this.stdout;
  }
}

export type Command = string | readonly string[];

export interface ExecOptions {
  env?: Record<string, string>;
  cwd?: string;
  tty?: boolean;
  cols?: number;
  rows?: number;
  timeout?: number;
  check?: boolean;
  input?: string | Uint8Array;
}

export interface ExecStreamOptions {
  env?: Record<string, string>;
  cwd?: string;
  tty?: boolean;
  cols?: number;
  rows?: number;
  timeout?: number;
}

export interface SandboxOptions {
  client: Tyto;
  sandboxId: string;
  operationId: string;
  template: string;
  version: string;
  status: Status;
  execEndpoint: string;
  capability: string;
  failureCode?: string | undefined;
  failureMessage?: string | undefined;
  name?: string;
}

export class Sandbox {
  /** @internal */ _client: Tyto;
  readonly id: string;
  operationId: string;
  template: string;
  version: string;
  lastObservedStatus: Status;
  /**
   * The display name. The service generates one when create() is not given a
   * name. Names are not unique; every operation is keyed by id.
   */
  name: string;
  /** @internal */ _execEndpoint: string;
  /** @internal */ _capability: string;
  /** @internal */ _failureCode: string | undefined;
  /** @internal */ _failureMessage: string | undefined;
  /** @internal */ _deleted = false;

  readonly files: SandboxFiles;
  readonly sessions: SandboxSessions;
  readonly previews: SandboxPreviews;

  constructor(options: SandboxOptions) {
    this._client = options.client;
    this.id = options.sandboxId;
    this.operationId = options.operationId;
    this.template = options.template;
    this.version = options.version;
    this.lastObservedStatus = options.status;
    this.name = options.name ?? "";
    this._execEndpoint = options.execEndpoint;
    this._capability = options.capability;
    this._failureCode = options.failureCode;
    this._failureMessage = options.failureMessage;
    this.files = new SandboxFiles(this);
    this.sessions = new SandboxSessions(this);
    this.previews = new SandboxPreviews(this);
  }

  /**
   * Runs a command and buffers stdout, stderr, and exit status.
   *
   * `env` overlays string environment variables; `cwd` sets the working
   * directory. In TTY mode stdout and stderr share the terminal and are
   * returned as stdout; stderr remains empty. `input` provides UTF-8 string
   * or raw bytes for non-TTY stdin; stdin is half-closed before output is
   * collected.
   */
  async exec(command: Command, options: ExecOptions = {}): Promise<ExecResult> {
    const stdin = normalizeExecInput(options.input, options.tty ?? false);
    const result = await this.execBuffered(command, options, stdin);
    return options.check ? result.check() : result;
  }

  /**
   * Starts a streaming Exec session, yielding Stdout/Stderr/Exit events as
   * they arrive.
   */
  execStream(command: Command, options: ExecStreamOptions = {}): RefreshableExecSession {
    this.ensureExecAllowed();
    const ttyConfig = validateExecTtyOptions(options.tty ?? false, options.cols, options.rows);
    return new RefreshableExecSession({
      sandbox: this,
      command: normalizeCommand(command),
      env: normalizeEnv(options.env),
      cwd: normalizeCwd(options.cwd),
      tty: ttyConfig.tty,
      cols: ttyConfig.cols,
      rows: ttyConfig.rows,
      timeout: options.timeout ?? this._client._timeout,
    });
  }

  /**
   * Deletes this sandbox. Idempotent: calling it again on the same handle
   * is local and returns alreadyDeleted: true without another RPC.
   *
   * The RPC itself is client.sandboxes.delete(); this adds the local
   * already-deleted short-circuit and updates the handle's own status,
   * which only make sense with a handle to check and update.
   */
  async delete(): Promise<DeleteResult> {
    if (this._deleted) {
      return { sandboxId: this.id, alreadyDeleted: true };
    }
    const result = await this._client.sandboxes.delete(this.id);
    this._deleted = true;
    this.lastObservedStatus = Status.DELETED;
    return result;
  }

  async snapshot(options: { idempotencyKey?: string } = {}): Promise<Snapshot> {
    if (this._deleted || this.lastObservedStatus === Status.DELETED) {
      throw new SandboxDeletedError("sandbox has been deleted", { sandboxId: this.id, operationId: this.operationId });
    }
    if (this.lastObservedStatus === Status.FAILED) {
      throw new SandboxFailedError(this._failureMessage || this._failureCode || "sandbox failed", {
        sandboxId: this.id,
        operationId: this.operationId,
      });
    }
    if (this.lastObservedStatus === Status.SUSPENDED) {
      throw new SandboxSuspendedError("sandbox is suspended", { sandboxId: this.id, operationId: this.operationId });
    }
    const key = options.idempotencyKey ?? randomToken();
    const request = { apiKey: this._client._apiKey, sandboxId: this.id, idempotencyKey: key };
    const deadline = Deadline.start(this._client._timeout);
    let attempts = 0;
    let backoff = 0.05;
    for (;;) {
      try {
        const response = (await callUnary(
          this._client._tapiStub().createSnapshot,
          request,
          new grpc.Metadata(),
          deadline,
        )) as { snapshotId?: string; sourceSandboxId?: string };
        const snapshotId = response.snapshotId || "";
        const sourceSandboxId = response.sourceSandboxId || "";
        if (!snapshotId || !sourceSandboxId) {
          throw new InvalidRequestError("CreateSnapshot response is missing snapshot identity", {
            sandboxId: this.id,
            operationId: this.operationId,
            idempotencyKey: key,
          });
        }
        if (sourceSandboxId !== this.id) {
          throw new InvalidRequestError("CreateSnapshot response is missing source identity", {
            sandboxId: this.id,
            operationId: this.operationId,
            idempotencyKey: key,
          });
        }
        return new Snapshot({ client: this._client, snapshotId, sourceSandboxId });
      } catch (exc) {
        if (!isRetryableTransportError(exc) || attempts >= this._client._maxRetries) {
          throw mapRpcError(exc, {
            secrets: this._client._secrets(key),
            sandboxId: this.id,
            operationId: this.operationId,
            idempotencyKey: key,
          });
        }
        attempts += 1;
        await sleepWithDeadline(backoff, deadline);
        backoff = Math.min(backoff * 2, 0.5);
      }
    }
  }

  /**
   * Explicitly resumes a suspended sandbox before running work.
   *
   * The RPC itself is client.sandboxes.resumeRaw(); this additionally
   * copies the refreshed capability and exec endpoint onto the handle,
   * which only makes sense with a handle to update, and checks for a
   * locally known failed status before making a request the server would
   * refuse anyway.
   */
  async resume(options: { idempotencyKey?: string } = {}): Promise<ResumeResult> {
    if (this.lastObservedStatus === Status.FAILED) {
      throw new SandboxFailedError(this._failureMessage || this._failureCode || "sandbox failed", {
        sandboxId: this.id,
        operationId: this.operationId,
      });
    }
    const [result, response] = await this._client.sandboxes.resumeRaw(this.id, options);
    if (response.execCapabilityJws) {
      this._capability = response.execCapabilityJws;
    }
    if (response.execEndpoint) {
      this._execEndpoint = response.execEndpoint;
    }
    this.lastObservedStatus = Status.RUNNING;
    return result;
  }

  private async execBuffered(command: Command, options: ExecOptions, input: Uint8Array | undefined): Promise<ExecResult> {
    const session = this.execStream(command, options);
    try {
      if (input !== undefined) {
        session.write(input);
        session.closeStdin();
      }
      const stdout: number[] = [];
      const stderr: number[] = [];
      let terminal: Exit | undefined;
      try {
        for await (const event of session) {
          if (event instanceof Stdout) {
            stdout.push(...event.data);
          } else if (event instanceof Stderr) {
            stderr.push(...event.data);
          } else if (event instanceof Exit) {
            terminal = event;
          }
        }
      } catch (error) {
        session.cancel();
        throw error;
      }
      if (!terminal) {
        throw new InvalidRequestError("Exec stream ended without an exit event", { sandboxId: this.id });
      }
      return new ExecResult({
        stdoutBytes: Uint8Array.from(stdout),
        stderrBytes: Uint8Array.from(stderr),
        exitCode: terminal.exitCode,
        signaled: terminal.signaled,
        signal: terminal.signal,
        sandboxId: this.id,
      });
    } finally {
      session.close();
    }
  }

  private ensureExecAllowed(): void {
    if (this._deleted || this.lastObservedStatus === Status.DELETED) {
      throw new SandboxDeletedError("sandbox has been deleted", { sandboxId: this.id, operationId: this.operationId });
    }
    if (this.lastObservedStatus === Status.FAILED) {
      throw new SandboxFailedError(this._failureMessage || this._failureCode || "sandbox failed", {
        sandboxId: this.id,
        operationId: this.operationId,
      });
    }
  }

  /** @internal */
  async _refreshCapabilityOnce(): Promise<void> {
    const refreshed = await this._client.sandboxes.get(this.id);
    if (refreshed.lastObservedStatus === Status.FAILED) {
      const message = refreshed._failureMessage || refreshed._failureCode || "sandbox failed";
      this.lastObservedStatus = Status.FAILED;
      this._failureCode = refreshed._failureCode;
      this._failureMessage = refreshed._failureMessage;
      throw new SandboxFailedError(message, { sandboxId: this.id, operationId: this.operationId });
    }
    this.operationId = refreshed.operationId;
    this.template = refreshed.template;
    this.version = refreshed.version;
    this.lastObservedStatus = refreshed.lastObservedStatus;
    this._execEndpoint = refreshed._execEndpoint;
    this._capability = refreshed._capability;
    this._failureCode = undefined;
    this._failureMessage = undefined;
  }

  /**
   * Mints a fresh data-plane capability via TApi's ReissueCapability and
   * uses it for subsequent calls on this Sandbox. `sessions` calls this
   * transparently on an UNAUTHENTICATED (expired-token) rejection, at most
   * once per call, before any stream effect. Call it directly only if you
   * manage tokens yourself.
   */
  async reissueCapability(): Promise<void> {
    const request = { apiKey: this._client._apiKey, sandboxId: this.id };
    const deadline = Deadline.start(this._client._timeout);
    let response: { capabilityJws?: string };
    try {
      response = (await callUnary(this._client._tapiStub().reissueCapability, request, new grpc.Metadata(), deadline)) as {
        capabilityJws?: string;
      };
    } catch (exc) {
      throw mapRpcError(exc, {
        secrets: this._client._secrets(this._capability),
        sandboxId: this.id,
        operationId: this.operationId,
      });
    }
    const capability = response.capabilityJws || "";
    if (!capability) {
      throw new InvalidRequestError("ReissueCapability response is missing capability_jws", {
        sandboxId: this.id,
        operationId: this.operationId,
      });
    }
    this._capability = capability;
  }

  /** @internal */
  _observeExecError(error: unknown): unknown {
    const mapped = mapRpcError(error, {
      secrets: this._client._secrets(this._capability),
      sandboxId: this.id,
      operationId: this.operationId,
      execRpc: true,
    });
    if (mapped instanceof SandboxDeletedError) {
      this._deleted = true;
      this.lastObservedStatus = Status.DELETED;
    } else if (mapped instanceof SandboxSuspendedError) {
      this.lastObservedStatus = Status.SUSPENDED;
    } else if (mapped instanceof InvalidRequestError) {
      // no local state change
    } else if (isGrpcServiceError(error) && error.code === grpcStatus.status.FAILED_PRECONDITION) {
      this.lastObservedStatus = Status.FAILED;
    }
    return mapped;
  }
}

/**
 * Wraps ExecSession so an expired capability is transparently refreshed and
 * the stream restarted exactly once, replaying any input written before the
 * first response arrived. Mirrors
 * sdks/python/src/tyto/_sandbox.py:_RefreshableExecSession.
 */
class RefreshableExecSession implements AsyncIterable<ExecEvent> {
  private readonly sandbox: Sandbox;
  private readonly command: string[];
  private readonly env: Record<string, string>;
  private readonly cwd: string;
  private readonly tty: boolean;
  private readonly cols: number;
  private readonly rows: number;
  private readonly timeout: number;
  private refreshed = false;
  private responsesStarted = false;
  private readonly pendingInputs: Array<
    | { kind: "write"; data: Uint8Array }
    | { kind: "closeStdin" }
    | { kind: "resize"; cols: number; rows: number }
  > = [];
  private session: ExecSession;

  constructor(options: {
    sandbox: Sandbox;
    command: string[];
    env: Record<string, string>;
    cwd: string;
    tty: boolean;
    cols: number;
    rows: number;
    timeout: number;
  }) {
    this.sandbox = options.sandbox;
    this.command = options.command;
    this.env = options.env;
    this.cwd = options.cwd;
    this.tty = options.tty;
    this.cols = options.cols;
    this.rows = options.rows;
    this.timeout = options.timeout;
    this.session = this.newSession();
  }

  [Symbol.asyncIterator](): AsyncIterator<ExecEvent> {
    const iterator = this;
    return {
      async next(): Promise<IteratorResult<ExecEvent>> {
        try {
          const inner = iterator.session[Symbol.asyncIterator]();
          const result = await inner.next();
          iterator.responsesStarted = true;
          return result;
        } catch (error) {
          if (!(error instanceof CapabilityRejectedError) || iterator.refreshed || !capabilityIsExpired(iterator.sandbox._capability)) {
            throw error;
          }
          iterator.refreshed = true;
          iterator.session.close();
          await iterator.sandbox._refreshCapabilityOnce();
          iterator.session = iterator.newSession();
          iterator.replayPendingInputs();
          const inner = iterator.session[Symbol.asyncIterator]();
          const result = await inner.next();
          iterator.responsesStarted = true;
          return result;
        }
      },
    };
  }

  write(data: Uint8Array): void {
    this.session.write(data);
    if (!this.responsesStarted && !this.refreshed) {
      this.pendingInputs.push({ kind: "write", data });
    }
  }

  closeStdin(): void {
    this.session.closeStdin();
    if (!this.responsesStarted && !this.refreshed) {
      this.pendingInputs.push({ kind: "closeStdin" });
    }
  }

  resize(options: { cols: number; rows: number }): void {
    this.session.resize(options);
    if (!this.responsesStarted && !this.refreshed) {
      this.pendingInputs.push({ kind: "resize", cols: options.cols, rows: options.rows });
    }
  }

  cancel(): void {
    this.session.cancel();
  }

  close(): void {
    this.session.close();
  }

  private newSession(): ExecSession {
    const sandbox = this.sandbox;
    return new ExecSession({
      sandboxId: sandbox.id,
      operationId: sandbox.operationId,
      command: this.command,
      env: this.env,
      cwd: this.cwd,
      tty: this.tty,
      cols: this.cols,
      rows: this.rows,
      stub: sandbox._client._execStub(sandbox._execEndpoint),
      capability: sandbox._capability,
      timeout: this.timeout,
      secrets: sandbox._client._secrets(sandbox._capability),
      onError: (error) => sandbox._observeExecError(error),
    });
  }

  private replayPendingInputs(): void {
    for (const input of this.pendingInputs) {
      if (input.kind === "write") {
        this.session.write(input.data);
      } else if (input.kind === "closeStdin") {
        this.session.closeStdin();
      } else {
        this.session.resize({ cols: input.cols, rows: input.rows });
      }
    }
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Buffer.from(bytes).toString("base64url");
}

function normalizeCommand(command: Command): string[] {
  if (typeof command === "string") {
    if (!command) {
      throw new InvalidRequestError("command must not be empty");
    }
    return ["/bin/sh", "-c", command];
  }
  const argv = [...command];
  if (argv.length === 0 || argv.some((arg) => typeof arg !== "string" || arg === "")) {
    throw new InvalidRequestError("command must be a non-empty string sequence");
  }
  return argv;
}

function normalizeExecInput(input: string | Uint8Array | undefined, tty: boolean): Uint8Array | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (tty) {
    throw new InvalidRequestError("input requires tty=False");
  }
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  throw new InvalidRequestError("input must be a string, Uint8Array, or undefined");
}

function normalizeEnv(env: Record<string, string> | undefined): Record<string, string> {
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

function normalizeCwd(cwd: string | undefined): string {
  if (cwd === undefined) {
    return "";
  }
  if (!cwd || cwd.includes("\0")) {
    throw new InvalidRequestError("cwd must be a non-empty string without NUL");
  }
  return cwd;
}

interface ExecTtyOptions {
  tty: boolean;
  cols: number;
  rows: number;
}

function validateExecTtyOptions(tty: boolean, cols: number | undefined, rows: number | undefined): ExecTtyOptions {
  if (typeof tty !== "boolean") {
    throw new InvalidRequestError("tty must be a boolean");
  }
  if (!tty) {
    if (cols !== undefined || rows !== undefined) {
      throw new InvalidRequestError("tty dimensions require tty=True");
    }
    return { tty: false, cols: 0, rows: 0 };
  }
  if (cols === undefined && rows === undefined) {
    return { tty: true, cols: 0, rows: 0 };
  }
  return {
    tty: true,
    cols: validateTtyDimension("cols", cols),
    rows: validateTtyDimension("rows", rows),
  };
}

function validateTtyDimension(name: string, value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 512) {
    throw new InvalidRequestError(`${name} must be a positive integer <= 512`);
  }
  return value;
}

function capabilityIsExpired(capability: string): boolean {
  const parts = capability.split(".");
  if (parts.length !== 3) {
    return false;
  }
  try {
    const payloadPart = parts[1];
    if (!payloadPart) {
      return false;
    }
    const padded = payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf-8");
    const claims = JSON.parse(json) as { exp?: unknown };
    const exp = claims.exp;
    return typeof exp === "number" && exp <= Date.now() / 1000;
  } catch {
    return false;
  }
}
