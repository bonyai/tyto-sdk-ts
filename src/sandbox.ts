import * as grpc from "@grpc/grpc-js";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";

import type { Tyto } from "./client.js";
import { callUnary } from "./client.js";
import {
  AuthenticationError,
  CapabilityRejectedError,
  ExecFailedError,
  FilesystemLimitError,
  InvalidRequestError,
  SandboxDeletedError,
  SandboxFailedError,
  SandboxSuspendedError,
} from "./errors.js";
import { isRetryableTransportError, isGrpcServiceError, mapRpcError } from "./grpc-errors.js";
import { FileKind as ProtoFileKind, type FileInfo as ProtoFileInfo } from "./proto/tyto/runtime/v1/guest.js";
import { FileInfo, FileKind, TRANSFER_CHUNK_BYTES } from "./files.js";
import {
  previewFromInfo,
  PreviewAuth,
  type CreatePreviewOptions,
  type Preview,
} from "./previews.js";
import { PreviewAuthMode } from "./proto/tyto/runtime/v1/preview.js";
import type { PreviewInfo as ProtoPreviewInfo } from "./proto/tyto/runtime/v1/tapi.js";
import {
  SessionStream,
  SessionList,
  validateSessionCommand,
  validateSessionCwd,
  validateSessionDimension,
  validateSessionEnv,
  validateSessionName,
  sessionInfoFromProto,
  type AttachSessionOptions,
  type CreateSessionOptions,
  type SessionInfo as SessionInfoResult,
} from "./sessions.js";
import type { SessionInfo as ProtoSessionInfo } from "./proto/tyto/runtime/v1/guest.js";
import { ExecSession } from "./session.js";
import { Deadline, sleepWithDeadline } from "./transport.js";
import { Exit, ExecEvent, Status, Stderr, Stdout } from "./types.js";
import * as grpcStatus from "@grpc/grpc-js";

const MIN_PREVIEW_PORT = 1024;
const MAX_PREVIEW_PORT = 65535;
const MAX_PREVIEW_NAME_BYTES = 80;
const TOKEN_QUERY_PARAM = "bonya_token";

const PREVIEW_AUTH_TO_PROTO: Record<PreviewAuth, PreviewAuthMode> = {
  [PreviewAuth.TOKEN]: PreviewAuthMode.PREVIEW_AUTH_MODE_TOKEN,
  [PreviewAuth.PUBLIC]: PreviewAuthMode.PREVIEW_AUTH_MODE_PUBLIC,
};

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
   * The RPC itself is client.deleteSandbox(); this adds the local
   * already-deleted short-circuit and updates the handle's own status,
   * which only make sense with a handle to check and update.
   */
  async delete(): Promise<DeleteResult> {
    if (this._deleted) {
      return { sandboxId: this.id, alreadyDeleted: true };
    }
    const result = await this._client.deleteSandbox(this.id);
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
   * The RPC itself is client._resumeSandboxRaw(); this additionally
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
    const [result, response] = await this._client._resumeSandboxRaw(this.id, options);
    if (response.execCapabilityJws) {
      this._capability = response.execCapabilityJws;
    }
    if (response.execEndpoint) {
      this._execEndpoint = response.execEndpoint;
    }
    this.lastObservedStatus = Status.RUNNING;
    return result;
  }

  /**
   * Creates a named TTY session: a persistent, guest-owned command session
   * that outlives the client connection. Create over an existing record
   * raises SessionExistsError; `replace: true` replaces a terminal record
   * only -- a running or attached session must be killed first.
   *
   * Capability refresh: an UNAUTHENTICATED rejection (an expired token)
   * transparently calls reissueCapability() and retries exactly once, at
   * admission time only, never mid-stream. PERMISSION_DENIED never triggers
   * a refresh.
   */
  async createSession(
    name: string,
    command: readonly string[],
    options: CreateSessionOptions = {},
  ): Promise<SessionInfoResult> {
    const validatedName = validateSessionName(name);
    const argv = validateSessionCommand(command);
    const env = validateSessionEnv(options.env);
    const cwd = validateSessionCwd(options.cwd);
    const cols = validateSessionDimension("cols", options.cols ?? 0);
    const rows = validateSessionDimension("rows", options.rows ?? 0);
    const replace = options.replace ?? false;

    return this.withSessionCapabilityRefresh(async () => {
      const request = { name: validatedName, command: argv, env, workingDir: cwd, cols, rows, replace };
      let response: { session?: ProtoSessionInfo };
      try {
        response = await callUnaryWithOptions(this.sessionStub().createSession, request, this.sessionMetadata(), this.sessionTimeout());
      } catch (error) {
        throw this.mapSessionError(error);
      }
      return sessionInfoFromProto(response.session);
    });
  }

  /**
   * Lists sessions. Works on a suspended sandbox without waking it: the
   * result's `sandboxSuspended` is true when served from the suspend-time
   * snapshot rather than the live guest.
   */
  async listSessions(): Promise<SessionList> {
    return this.withSessionCapabilityRefresh(async () => {
      let response: { sessions?: ProtoSessionInfo[]; sandboxSuspended?: boolean };
      try {
        response = await callUnaryWithOptions(this.sessionStub().listSessions, {}, this.sessionMetadata(), this.sessionTimeout());
      } catch (error) {
        throw this.mapSessionError(error);
      }
      return new SessionList((response.sessions ?? []).map(sessionInfoFromProto), Boolean(response.sandboxSuspended));
    });
  }

  /** Signals (default TERM), then SIGKILL after grace_ms if still alive. */
  async killSession(name: string, options: { signal?: string; graceMs?: number } = {}): Promise<SessionInfoResult> {
    const validatedName = validateSessionName(name);
    const signal = options.signal ?? "TERM";
    if (!signal) {
      throw new InvalidRequestError("signal must be a non-empty string");
    }
    const graceMs = options.graceMs ?? 5000;
    if (!Number.isInteger(graceMs) || graceMs < 0) {
      throw new InvalidRequestError("grace_ms must be a non-negative integer");
    }

    return this.withSessionCapabilityRefresh(async () => {
      let response: { session?: ProtoSessionInfo };
      try {
        response = await callUnaryWithOptions(
          this.sessionStub().killSession,
          { name: validatedName, signal, graceMs },
          this.sessionMetadata(),
          this.sessionTimeout(),
        );
      } catch (error) {
        throw this.mapSessionError(error);
      }
      return sessionInfoFromProto(response.session);
    });
  }

  /**
   * Attaches to a session by name, replaying bounded output produced while
   * detached. A second attach preempts an existing one -- the loser's
   * stream ends with a TAKEOVER SessionEnded event.
   */
  async attachSession(name: string, options: AttachSessionOptions = {}): Promise<SessionStream> {
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
        sandboxId: this.id,
        name: validatedName,
        cols,
        rows,
        maxReplayBytes,
        stub: this.sessionStub(),
        capability: this._capability,
        timeout: this._client._timeout,
        secrets: this._client._secrets(this._capability),
      });

    try {
      return await openStream();
    } catch (error) {
      if (error instanceof AuthenticationError) {
        await this.reissueCapability();
        return openStream();
      }
      throw error;
    }
  }

  /**
   * Publishes a preview URL for a guest port. These are TApi calls
   * authenticated with the API key, not data-plane calls, so the
   * capability-refresh wrapper that guards exec and files does not apply
   * here -- there is no capability in play on the request.
   *
   * On success the sandbox's stored capability is replaced with the one
   * returned, because the preview scope is newer than the token a sandbox
   * was created with.
   */
  async createPreview(port: number, options: CreatePreviewOptions = {}): Promise<Preview> {
    if (!Number.isInteger(port)) {
      throw new InvalidRequestError("port must be an integer", { sandboxId: this.id });
    }
    if (port < MIN_PREVIEW_PORT || port > MAX_PREVIEW_PORT) {
      throw new InvalidRequestError(`port must be between ${MIN_PREVIEW_PORT} and ${MAX_PREVIEW_PORT}`, {
        sandboxId: this.id,
      });
    }
    const auth = options.auth ?? PreviewAuth.TOKEN;
    if (!(auth in PREVIEW_AUTH_TO_PROTO)) {
      throw new InvalidRequestError("auth must be a PreviewAuth", { sandboxId: this.id });
    }
    const displayName = options.name ?? "";
    if (Buffer.byteLength(displayName, "utf-8") > MAX_PREVIEW_NAME_BYTES) {
      throw new InvalidRequestError(`name exceeds ${MAX_PREVIEW_NAME_BYTES} bytes`, { sandboxId: this.id });
    }
    const key = options.idempotencyKey ?? randomUUID();
    if (!key) {
      throw new InvalidRequestError("idempotency key must be non-empty", { sandboxId: this.id });
    }

    const request = {
      apiKey: this._client._apiKey,
      sandboxId: this.id,
      port,
      authMode: PREVIEW_AUTH_TO_PROTO[auth],
      name: displayName,
      idempotencyKey: key,
    };
    const deadline = Deadline.start(this._client._timeout);
    let response: { preview?: ProtoPreviewInfo; capabilityJws?: string };
    try {
      response = (await callUnary(this._client._tapiStub().createPreview, request, new grpc.Metadata(), deadline)) as {
        preview?: ProtoPreviewInfo;
        capabilityJws?: string;
      };
    } catch (error) {
      throw mapRpcError(error, { secrets: this._client._secrets(this._capability), sandboxId: this.id });
    }

    if (response.capabilityJws) {
      this._capability = response.capabilityJws;
    }
    if (!response.preview?.record?.previewId) {
      throw new InvalidRequestError("CreatePreview response is missing the preview identity", {
        sandboxId: this.id,
        idempotencyKey: key,
      });
    }
    return previewFromInfo(response.preview);
  }

  /** Every published preview for this sandbox. */
  async listPreviews(): Promise<Preview[]> {
    const request = { apiKey: this._client._apiKey, sandboxId: this.id };
    const deadline = Deadline.start(this._client._timeout);
    let response: { previews?: ProtoPreviewInfo[] };
    try {
      response = (await callUnary(this._client._tapiStub().listPreviews, request, new grpc.Metadata(), deadline)) as {
        previews?: ProtoPreviewInfo[];
      };
    } catch (error) {
      throw mapRpcError(error, { secrets: this._client._secrets(this._capability), sandboxId: this.id });
    }
    return (response.previews ?? []).map(previewFromInfo);
  }

  /** Revokes a preview URL. */
  async deletePreview(previewId: string): Promise<void> {
    if (!previewId) {
      throw new InvalidRequestError("preview id is required", { sandboxId: this.id });
    }
    const request = { apiKey: this._client._apiKey, sandboxId: this.id, previewId };
    const deadline = Deadline.start(this._client._timeout);
    try {
      await callUnary(this._client._tapiStub().deletePreview, request, new grpc.Metadata(), deadline);
    } catch (error) {
      throw mapRpcError(error, { secrets: this._client._secrets(this._capability), sandboxId: this.id });
    }
  }

  /**
   * A one-time URL that logs a browser into a token-mode preview. Raises on
   * a public preview, which has no token to exchange and whose plain `url`
   * already works. Never share this URL: anyone who receives it holds the
   * sandbox's data-plane capability until it expires.
   */
  previewBrowserUrl(preview: Preview): string {
    if (preview.auth === PreviewAuth.PUBLIC) {
      throw new InvalidRequestError("a public preview needs no token; use preview.url", { sandboxId: this.id });
    }
    const capability = this._capability;
    if (!capability) {
      throw new InvalidRequestError("no capability is available for this sandbox", { sandboxId: this.id });
    }
    const separator = preview.url.includes("?") ? "&" : "?";
    return `${preview.url}${separator}${TOKEN_QUERY_PARAM}=${capability}`;
  }

  /**
   * Buffers an entire remote file and returns its bytes. Rejects with
   * FilesystemLimitError before exceeding the client's memory cap.
   */
  async readFile(rawPath: string): Promise<Uint8Array> {
    const remotePath = validateRemotePath(rawPath);
    return this.withFileCapabilityRefresh(async () => {
      const stream = this.fileStub().readFile({ sandboxId: this.id, path: remotePath }, this.fileMetadata(), {
        deadline: Deadline.start(this._client._timeout).deadlineDate(),
      });
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const response of stream as AsyncIterable<{ data: Buffer }>) {
          const chunk = response.data ?? Buffer.alloc(0);
          total += chunk.length;
          if (total > this._client._filesystemReadLimit) {
            stream.cancel();
            throw new FilesystemLimitError("filesystem read exceeded client memory limit", {
              sandboxId: this.id,
              operationId: this.operationId,
            });
          }
          chunks.push(chunk);
        }
      } catch (error) {
        if (error instanceof FilesystemLimitError) {
          throw error;
        }
        throw this.mapFileError(error);
      }
      return new Uint8Array(Buffer.concat(chunks));
    });
  }

  /**
   * Writes data to a remote path, streamed in 64 KiB chunks through a
   * guest-side temporary file and published atomically.
   */
  async writeFile(rawPath: string, data: Uint8Array | string): Promise<void> {
    const remotePath = validateRemotePath(rawPath);
    const payload = normalizeWriteData(data);
    await this.writeFileStream(() => fileWriteFrames(this.id, remotePath, payload));
  }

  /** Streams a local file to the remote path in 64 KiB chunks. */
  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const validatedRemote = validateRemotePath(remotePath);
    const source = await fsPromises.readFile(localPath);
    await this.writeFileStream(() => fileWriteFrames(this.id, validatedRemote, source));
  }

  /**
   * Streams a remote file into a hidden temporary file in the destination
   * directory, fsyncs it, and atomically replaces the destination.
   */
  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const validatedRemote = validateRemotePath(remotePath);
    const destination = nodePath.resolve(localPath);
    const parent = nodePath.dirname(destination);
    const temp = nodePath.join(parent, `.${nodePath.basename(destination)}.bonya-download-${randomUUID()}.tmp`);
    let replaced = false;
    try {
      const handle = await fsPromises.open(temp, "wx");
      try {
        await this.downloadFileToHandle(validatedRemote, handle);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsPromises.rename(temp, destination);
      replaced = true;
      await fsyncParentDir(parent);
    } finally {
      if (!replaced) {
        await fsPromises.unlink(temp).catch(() => undefined);
      }
    }
  }

  /** Returns immediate children of a remote directory, sorted by name. */
  async listFiles(rawPath: string): Promise<FileInfo[]> {
    const remotePath = validateRemotePath(rawPath);
    return this.withFileCapabilityRefresh(async () => {
      const stream = this.fileStub().listDirectory({ sandboxId: this.id, path: remotePath }, this.fileMetadata(), {
        deadline: Deadline.start(this._client._timeout).deadlineDate(),
      });
      const files: FileInfo[] = [];
      try {
        for await (const response of stream as AsyncIterable<{ file?: ProtoFileInfo }>) {
          if (!response.file) {
            throw new InvalidRequestError("ListDirectory response is missing file metadata");
          }
          files.push(fileInfoFromProto(response.file));
        }
      } catch (error) {
        throw this.mapFileError(error);
      }
      return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    });
  }

  /** Returns lstat-style metadata for a remote path. */
  async statFile(rawPath: string): Promise<FileInfo> {
    const remotePath = validateRemotePath(rawPath);
    return this.withFileCapabilityRefresh(async () => {
      let response: { file?: ProtoFileInfo };
      try {
        response = await callUnaryWithOptions(
          this.fileStub().statFile,
          { sandboxId: this.id, path: remotePath },
          this.fileMetadata(),
          Deadline.start(this._client._timeout),
        );
      } catch (error) {
        throw this.mapFileError(error);
      }
      if (!response.file) {
        throw new InvalidRequestError("StatFile response is missing file metadata");
      }
      return fileInfoFromProto(response.file);
    });
  }

  /** Creates a remote directory. */
  async mkdirFile(rawPath: string): Promise<void> {
    const remotePath = validateRemotePath(rawPath);
    await this.unaryFileMutation("makeDirectory", { sandboxId: this.id, path: remotePath });
  }

  /** Removes a remote path, recursively if recursive is true. */
  async removeFile(rawPath: string, recursive = false): Promise<void> {
    const remotePath = validateRemotePath(rawPath);
    await this.unaryFileMutation("removeFile", { sandboxId: this.id, path: remotePath, recursive });
  }

  /** Moves a remote file or directory. Same-filesystem, atomic, and no-overwrite. */
  async moveFile(source: string, destination: string): Promise<void> {
    const sourcePath = validateRemotePath(source);
    const destinationPath = validateRemotePath(destination);
    await this.unaryFileMutation("moveFile", { sandboxId: this.id, sourcePath, destinationPath });
  }

  private async writeFileStream(framesFactory: () => Array<{ start?: unknown; chunk?: unknown }>): Promise<void> {
    await this.withFileCapabilityRefresh(async () => {
      await new Promise<void>((resolve, reject) => {
        const call = this.fileStub().writeFile(
          this.fileMetadata(),
          { deadline: Deadline.start(this._client._timeout).deadlineDate() },
          (error) => {
            if (error) {
              reject(this.mapFileError(error));
              return;
            }
            resolve();
          },
        );
        for (const frame of framesFactory()) {
          call.write(frame as never);
        }
        call.end();
      });
    });
  }

  private async downloadFileToHandle(remotePath: string, handle: fsPromises.FileHandle): Promise<void> {
    await this.withFileCapabilityRefresh(async () => {
      const stream = this.fileStub().readFile({ sandboxId: this.id, path: remotePath }, this.fileMetadata(), {
        deadline: Deadline.start(this._client._timeout).deadlineDate(),
      });
      try {
        for await (const response of stream as AsyncIterable<{ data: Buffer }>) {
          await handle.write(response.data ?? Buffer.alloc(0));
        }
      } catch (error) {
        throw this.mapFileError(error);
      }
    });
  }

  private async unaryFileMutation(
    methodName: "makeDirectory" | "removeFile" | "moveFile",
    request: Record<string, unknown>,
  ): Promise<void> {
    await this.withFileCapabilityRefresh(async () => {
      const stub = this.fileStub() as unknown as Record<
        string,
        (
          request: unknown,
          metadata: grpc.Metadata,
          options: grpc.CallOptions,
          callback: (error: grpc.ServiceError | null, response: unknown) => void,
        ) => grpc.ClientUnaryCall
      >;
      const method = stub[methodName];
      if (!method) {
        throw new InvalidRequestError(`unknown filesystem method ${methodName}`);
      }
      try {
        await new Promise<void>((resolve, reject) => {
          method.call(
            stub,
            request,
            this.fileMetadata(),
            { deadline: Deadline.start(this._client._timeout).deadlineDate() },
            (error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            },
          );
        });
      } catch (error) {
        throw this.mapFileError(error);
      }
    });
  }

  private async withFileCapabilityRefresh<T>(call: () => Promise<T>): Promise<T> {
    this.ensureFilesAllowed();
    try {
      return await call();
    } catch (error) {
      if (error instanceof CapabilityRejectedError) {
        await this._refreshCapabilityOnce();
        return call();
      }
      throw error;
    }
  }

  private ensureFilesAllowed(): void {
    if (this._deleted || this.lastObservedStatus === Status.DELETED) {
      throw new SandboxDeletedError("sandbox has been deleted", { sandboxId: this.id, operationId: this.operationId });
    }
    if (this.lastObservedStatus === Status.FAILED) {
      const message = this._failureMessage || this._failureCode || "sandbox failed";
      throw new SandboxFailedError(message, { sandboxId: this.id, operationId: this.operationId });
    }
  }

  private fileStub() {
    return this._client._execStub(this._execEndpoint);
  }

  private fileMetadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    metadata.add("bonya-sandbox-id", this.id);
    metadata.add("bonya-exec-capability", this._capability);
    return metadata;
  }

  private mapFileError(error: unknown): unknown {
    const mapped = mapRpcError(error, {
      secrets: this._client._secrets(this._capability),
      sandboxId: this.id,
      operationId: this.operationId,
      filesystemRpc: true,
    });
    if (mapped instanceof SandboxDeletedError) {
      this._deleted = true;
      this.lastObservedStatus = Status.DELETED;
    }
    return mapped;
  }

  private async withSessionCapabilityRefresh<T>(call: () => Promise<T>): Promise<T> {
    this.ensureSessionsAllowed();
    try {
      return await call();
    } catch (error) {
      if (error instanceof AuthenticationError) {
        await this.reissueCapability();
        return call();
      }
      throw error;
    }
  }

  private ensureSessionsAllowed(): void {
    if (this._deleted || this.lastObservedStatus === Status.DELETED) {
      throw new SandboxDeletedError("sandbox has been deleted", { sandboxId: this.id, operationId: this.operationId });
    }
    if (this.lastObservedStatus === Status.FAILED) {
      const message = this._failureMessage || this._failureCode || "sandbox failed";
      throw new SandboxFailedError(message, { sandboxId: this.id, operationId: this.operationId });
    }
  }

  private sessionStub() {
    return this._client._execStub(this._execEndpoint);
  }

  private sessionTimeout(): Deadline {
    return Deadline.start(this._client._timeout);
  }

  private sessionMetadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    metadata.add("bonya-sandbox-id", this.id);
    metadata.add("bonya-exec-capability", this._capability);
    return metadata;
  }

  private mapSessionError(error: unknown): unknown {
    return mapRpcError(error, {
      secrets: this._client._secrets(this._capability),
      sandboxId: this.id,
      operationId: this.operationId,
      sessionRpc: true,
    });
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
    const refreshed = await this._client.getSandbox(this.id);
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

function callUnaryWithOptions<Req, Res>(
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

function validateRemotePath(value: string): string {
  if (!value || value.includes("\0")) {
    throw new InvalidRequestError("path must be a non-empty string without NUL");
  }
  return value;
}

function normalizeWriteData(data: Uint8Array | string): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return data;
}

function fileWriteFrames(
  sandboxId: string,
  remotePath: string,
  payload: Uint8Array,
): Array<{ start?: unknown; chunk?: unknown }> {
  const frames: Array<{ start?: unknown; chunk?: unknown }> = [{ start: { sandboxId, path: remotePath } }];
  for (let offset = 0; offset < payload.length; offset += TRANSFER_CHUNK_BYTES) {
    frames.push({ chunk: { data: Buffer.from(payload.slice(offset, offset + TRANSFER_CHUNK_BYTES)) } });
  }
  return frames;
}

function fileInfoFromProto(file: ProtoFileInfo): FileInfo {
  return {
    path: file.path ?? "",
    name: file.name ?? "",
    kind: fileKindFromProto(file.kind ?? 0),
    size: Number(file.size ?? 0),
    mode: Number(file.mode ?? 0),
    modifiedAt: dateFromUnixNanos(Number(file.modifiedAtUnixNanos ?? 0)),
  };
}

function fileKindFromProto(kind: ProtoFileKind): FileKind {
  switch (kind) {
    case ProtoFileKind.FILE_KIND_FILE:
      return FileKind.FILE;
    case ProtoFileKind.FILE_KIND_DIRECTORY:
      return FileKind.DIRECTORY;
    case ProtoFileKind.FILE_KIND_SYMLINK:
      return FileKind.SYMLINK;
    default:
      return FileKind.OTHER;
  }
}

function dateFromUnixNanos(nanos: number): Date {
  return new Date(nanos / 1e6);
}

async function fsyncParentDir(parent: string): Promise<void> {
  let handle: fsPromises.FileHandle;
  try {
    handle = await fsPromises.open(parent, fs.constants.O_RDONLY);
  } catch (error) {
    if (isUnsupportedDirectoryFsyncError(error)) {
      return;
    }
    throw error;
  }
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (!isUnsupportedDirectoryFsyncError(error)) {
        throw error;
      }
    }
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectoryFsyncError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}
