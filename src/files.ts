import * as grpc from "@grpc/grpc-js";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  CapabilityRejectedError,
  FilesystemLimitError,
  InvalidRequestError,
  SandboxDeletedError,
  SandboxFailedError,
} from "./errors.js";
import { mapRpcError } from "./grpc-errors.js";
import { Deadline } from "./transport.js";
import { Status } from "./types.js";
import type { Sandbox } from "./sandbox.js";
import type { FileInfo as ProtoFileInfo } from "./proto/tyto/runtime/v1/guest.js";
import { FileKind as ProtoFileKind } from "./proto/tyto/runtime/v1/guest.js";

export const TRANSFER_CHUNK_BYTES = 64 * 1024;

export enum FileKind {
  FILE = "file",
  DIRECTORY = "directory",
  SYMLINK = "symlink",
  OTHER = "other",
}

export interface FileInfo {
  readonly path: string;
  readonly name: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly mode: number;
  readonly modifiedAt: Date;
}

/**
 * Dedicated sandbox filesystem RPC surface. `read` buffers subject to the
 * client's memory cap. `upload` and `download` stream in 64 KiB chunks
 * without a total transfer cap.
 */
export class SandboxFiles {
  private readonly sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
  }

  async read(rawPath: string): Promise<Uint8Array> {
    const remotePath = validateRemotePath(rawPath);
    return this.withCapabilityRefresh(async () => {
      const sandbox = this.sandbox;
      const stream = this.stub().readFile({ sandboxId: sandbox.id, path: remotePath }, this.metadata(), {
        deadline: Deadline.start(sandbox._client._timeout).deadlineDate(),
      });
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const response of stream as AsyncIterable<{ data: Buffer }>) {
          const chunk = response.data ?? Buffer.alloc(0);
          total += chunk.length;
          if (total > sandbox._client._filesystemReadLimit) {
            stream.cancel();
            throw new FilesystemLimitError("filesystem read exceeded client memory limit", {
              sandboxId: sandbox.id,
              operationId: sandbox.operationId,
            });
          }
          chunks.push(chunk);
        }
      } catch (error) {
        if (error instanceof FilesystemLimitError) {
          throw error;
        }
        throw this.mapError(error);
      }
      return new Uint8Array(Buffer.concat(chunks));
    });
  }

  async write(rawPath: string, data: Uint8Array | string): Promise<void> {
    const remotePath = validateRemotePath(rawPath);
    const payload = normalizeWriteData(data);
    await this.writeStream(() => this.writeFrames(remotePath, payload));
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    const validatedRemote = validateRemotePath(remotePath);
    const source = await fsPromises.readFile(localPath);
    await this.writeStream(() => this.writeFrames(validatedRemote, source));
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const validatedRemote = validateRemotePath(remotePath);
    const destination = path.resolve(localPath);
    const parent = path.dirname(destination);
    const temp = path.join(parent, `.${path.basename(destination)}.bonya-download-${randomUUID()}.tmp`);
    let replaced = false;
    try {
      const handle = await fsPromises.open(temp, "wx");
      try {
        await this.downloadToHandle(validatedRemote, handle);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsPromises.rename(temp, destination);
      replaced = true;
      await fsyncParent(parent);
    } finally {
      if (!replaced) {
        await fsPromises.unlink(temp).catch(() => undefined);
      }
    }
  }

  async list(rawPath: string): Promise<FileInfo[]> {
    const remotePath = validateRemotePath(rawPath);
    return this.withCapabilityRefresh(async () => {
      const sandbox = this.sandbox;
      const stream = this.stub().listDirectory({ sandboxId: sandbox.id, path: remotePath }, this.metadata(), {
        deadline: Deadline.start(sandbox._client._timeout).deadlineDate(),
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
        throw this.mapError(error);
      }
      return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    });
  }

  async stat(rawPath: string): Promise<FileInfo> {
    const remotePath = validateRemotePath(rawPath);
    return this.withCapabilityRefresh(async () => {
      const sandbox = this.sandbox;
      let response: { file?: ProtoFileInfo };
      try {
        response = await unaryCall(
          this.stub().statFile,
          { sandboxId: sandbox.id, path: remotePath },
          this.metadata(),
          Deadline.start(sandbox._client._timeout),
        );
      } catch (error) {
        throw this.mapError(error);
      }
      if (!response.file) {
        throw new InvalidRequestError("StatFile response is missing file metadata");
      }
      return fileInfoFromProto(response.file);
    });
  }

  async mkdir(rawPath: string): Promise<void> {
    const remotePath = validateRemotePath(rawPath);
    await this.unaryMutation("makeDirectory", { sandboxId: this.sandbox.id, path: remotePath });
  }

  async remove(rawPath: string, recursive = false): Promise<void> {
    const remotePath = validateRemotePath(rawPath);
    await this.unaryMutation("removeFile", { sandboxId: this.sandbox.id, path: remotePath, recursive });
  }

  async move(source: string, destination: string): Promise<void> {
    const sourcePath = validateRemotePath(source);
    const destinationPath = validateRemotePath(destination);
    await this.unaryMutation("moveFile", { sandboxId: this.sandbox.id, sourcePath, destinationPath });
  }

  private writeFrames(remotePath: string, payload: Uint8Array): Array<{ start?: unknown; chunk?: unknown }> {
    const frames: Array<{ start?: unknown; chunk?: unknown }> = [
      { start: { sandboxId: this.sandbox.id, path: remotePath } },
    ];
    for (let offset = 0; offset < payload.length; offset += TRANSFER_CHUNK_BYTES) {
      frames.push({ chunk: { data: Buffer.from(payload.slice(offset, offset + TRANSFER_CHUNK_BYTES)) } });
    }
    return frames;
  }

  private async writeStream(framesFactory: () => Array<{ start?: unknown; chunk?: unknown }>): Promise<void> {
    await this.withCapabilityRefresh(async () => {
      const sandbox = this.sandbox;
      await new Promise<void>((resolve, reject) => {
        const call = this.stub().writeFile(this.metadata(), { deadline: Deadline.start(sandbox._client._timeout).deadlineDate() }, (error) => {
          if (error) {
            reject(this.mapError(error));
            return;
          }
          resolve();
        });
        for (const frame of framesFactory()) {
          call.write(frame as never);
        }
        call.end();
      });
    });
  }

  private async downloadToHandle(remotePath: string, handle: fsPromises.FileHandle): Promise<void> {
    await this.withCapabilityRefresh(async () => {
      const sandbox = this.sandbox;
      const stream = this.stub().readFile({ sandboxId: sandbox.id, path: remotePath }, this.metadata(), {
        deadline: Deadline.start(sandbox._client._timeout).deadlineDate(),
      });
      try {
        for await (const response of stream as AsyncIterable<{ data: Buffer }>) {
          await handle.write(response.data ?? Buffer.alloc(0));
        }
      } catch (error) {
        throw this.mapError(error);
      }
    });
  }

  private async unaryMutation(
    methodName: "makeDirectory" | "removeFile" | "moveFile",
    request: Record<string, unknown>,
  ): Promise<void> {
    await this.withCapabilityRefresh(async () => {
      const sandbox = this.sandbox;
      const stub = this.stub() as unknown as Record<
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
            this.metadata(),
            { deadline: Deadline.start(sandbox._client._timeout).deadlineDate() },
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
        throw this.mapError(error);
      }
    });
  }

  private async withCapabilityRefresh<T>(call: () => Promise<T>): Promise<T> {
    this.ensureFilesAllowed();
    try {
      return await call();
    } catch (error) {
      if (error instanceof CapabilityRejectedError) {
        await this.sandbox._refreshCapabilityOnce();
        return call();
      }
      throw error;
    }
  }

  private ensureFilesAllowed(): void {
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

  private metadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    metadata.add("bonya-sandbox-id", this.sandbox.id);
    metadata.add("bonya-exec-capability", this.sandbox._capability);
    return metadata;
  }

  private mapError(error: unknown): unknown {
    const mapped = mapRpcError(error, {
      secrets: this.sandbox._client._secrets(this.sandbox._capability),
      sandboxId: this.sandbox.id,
      operationId: this.sandbox.operationId,
      filesystemRpc: true,
    });
    if (mapped instanceof SandboxDeletedError) {
      this.sandbox._deleted = true;
      this.sandbox.lastObservedStatus = Status.DELETED;
    }
    return mapped;
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

async function fsyncParent(parent: string): Promise<void> {
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
