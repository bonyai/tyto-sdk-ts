import * as grpc from "@grpc/grpc-js";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Tyto } from "../src/client.js";
import {
  CapabilityRejectedError,
  CrossFilesystemMoveError,
  FilesystemError,
  FilesystemLimitError,
  RemoteFileExistsError,
  RemoteFileNotFoundError,
} from "../src/errors.js";
import { FileKind } from "../src/files.js";
import { TRANSFER_CHUNK_BYTES } from "../src/files.js";
import { makeFakeTransport, RpcFailure, type FakeTransport } from "./fakes.js";

/**
 * Minimal async-iterable event emitter mirroring grpc-js's
 * ClientReadableStream (a Node Readable in object mode): `for await` reads
 * 'data' events until 'end', and rejects on 'error'.
 */
class AsyncIterableEmitter<T> extends EventEmitter {
  [Symbol.asyncIterator](): AsyncIterator<T> {
    const buffered: T[] = [];
    const waiters: Array<(result: IteratorResult<T>) => void> = [];
    let ended = false;
    let failure: unknown;

    this.on("data", (item: T) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value: item });
      } else {
        buffered.push(item);
      }
    });
    this.on("end", () => {
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()!({ done: true, value: undefined as unknown as T });
      }
    });
    this.on("error", (error: unknown) => {
      failure = error;
      ended = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift()!;
        // Reject is modeled by throwing from next(); resolve with a marker
        // that next() recognizes and rethrows.
        waiter({ done: true, value: undefined as unknown as T });
      }
    });

    return {
      next: (): Promise<IteratorResult<T>> => {
        if (buffered.length > 0) {
          return Promise.resolve({ done: false, value: buffered.shift() as T });
        }
        if (ended) {
          if (failure) {
            return Promise.reject(failure);
          }
          return Promise.resolve({ done: true, value: undefined as unknown as T });
        }
        return new Promise((resolve, reject) => {
          waiters.push((result) => {
            if (result.done && failure) {
              reject(failure);
              return;
            }
            resolve(result);
          });
        });
      },
    };
  }
}

class FakeReadableStream extends AsyncIterableEmitter<{ data: Buffer }> {
  cancelled = false;
  constructor(chunks: Buffer[], error?: grpc.ServiceError) {
    super();
    queueMicrotask(() => {
      if (error) {
        this.emit("error", error);
        return;
      }
      for (const chunk of chunks) {
        this.emit("data", { data: chunk });
      }
      this.emit("end");
    });
  }
  cancel(): void {
    this.cancelled = true;
  }
}

class FakeListStream extends AsyncIterableEmitter<{ file: unknown }> {
  constructor(files: unknown[], error?: grpc.ServiceError) {
    super();
    queueMicrotask(() => {
      if (error) {
        this.emit("error", error);
        return;
      }
      for (const file of files) {
        this.emit("data", { file });
      }
      this.emit("end");
    });
  }
  cancel(): void {}
}

class FakeWriteCall extends EventEmitter {
  written: unknown[] = [];
  constructor(
    private onEnd: (frames: unknown[]) => { error?: grpc.ServiceError; response?: unknown },
    private callback: (error: grpc.ServiceError | null, response?: unknown) => void,
  ) {
    super();
  }
  write(frame: unknown): boolean {
    this.written.push(frame);
    return true;
  }
  end(): void {
    const { error, response } = this.onEnd(this.written);
    queueMicrotask(() => this.callback(error ?? null, response));
  }
}

class FakeFilesystemGuest {
  readChunks: Buffer[] = [Buffer.from("bin\0"), Buffer.from([0xff])];
  listFiles: unknown[] = [];
  statFileFixture = {
    path: "/tmp/blob",
    name: "blob",
    kind: 1,
    size: 5,
    mode: 0o100640,
    modifiedAtUnixNanos: 1_700_000_000_123_456_789,
  };
  readError: grpc.ServiceError | undefined;
  writeError: grpc.ServiceError | undefined;
  listError: grpc.ServiceError | undefined;
  statError: grpc.ServiceError | undefined;
  mkdirError: grpc.ServiceError | undefined;
  removeError: grpc.ServiceError | undefined;
  moveError: grpc.ServiceError | undefined;

  readRequests: any[] = [];
  writeFramesLog: any[][] = [];
  listRequests: any[] = [];
  statRequests: any[] = [];
  mkdirRequests: any[] = [];
  removeRequests: any[] = [];
  moveRequests: any[] = [];
  metadataLog: grpc.Metadata[] = [];

  statCallCount = 0;

  readFile = (request: any, metadata: grpc.Metadata): any => {
    this.readRequests.push(request);
    this.metadataLog.push(metadata);
    const error = this.readError;
    this.readError = undefined;
    return new FakeReadableStream(this.readChunks, error);
  };

  writeFile = (metadata: grpc.Metadata, _options: unknown, callback: any): any => {
    this.metadataLog.push(metadata);
    const error = this.writeError;
    this.writeError = undefined;
    return new FakeWriteCall((frames) => {
      this.writeFramesLog.push(frames);
      if (error) {
        return { error };
      }
      const total = frames
        .filter((f: any) => f.chunk)
        .reduce((sum: number, f: any) => sum + f.chunk.data.length, 0);
      return { response: { bytesWritten: total } };
    }, callback);
  };

  listDirectory = (request: any, metadata: grpc.Metadata): any => {
    this.listRequests.push(request);
    this.metadataLog.push(metadata);
    const error = this.listError;
    this.listError = undefined;
    return new FakeListStream(this.listFiles, error);
  };

  statFile = (request: any, metadata: grpc.Metadata, _options: unknown, callback: any): any => {
    this.statRequests.push(request);
    this.metadataLog.push(metadata);
    this.statCallCount += 1;
    const error = this.statError;
    this.statError = undefined;
    queueMicrotask(() => (error ? callback(error) : callback(null, { file: this.statFileFixture })));
    return new EventEmitter();
  };

  makeDirectory = (request: any, metadata: grpc.Metadata, _options: unknown, callback: any): any => {
    this.mkdirRequests.push(request);
    this.metadataLog.push(metadata);
    const error = this.mkdirError;
    this.mkdirError = undefined;
    queueMicrotask(() => (error ? callback(error) : callback(null, {})));
    return new EventEmitter();
  };

  removeFile = (request: any, metadata: grpc.Metadata, _options: unknown, callback: any): any => {
    this.removeRequests.push(request);
    this.metadataLog.push(metadata);
    const error = this.removeError;
    this.removeError = undefined;
    queueMicrotask(() => (error ? callback(error) : callback(null, {})));
    return new EventEmitter();
  };

  moveFile = (request: any, metadata: grpc.Metadata, _options: unknown, callback: any): any => {
    this.moveRequests.push(request);
    this.metadataLog.push(metadata);
    const error = this.moveError;
    this.moveError = undefined;
    queueMicrotask(() => (error ? callback(error) : callback(null, {})));
    return new EventEmitter();
  };
}

function makeFilesClient(guest: FakeFilesystemGuest, readLimit = 64 * 1024 * 1024): { client: Tyto; transport: FakeTransport } {
  const transport = makeFakeTransport();
  transport.guestStubFactory = () => guest as unknown as any;
  const client = new Tyto({
    apiKey: "secret-api",
    endpoint: "https://api.example.test/",
    timeout: 2,
    maxRetries: 2,
    filesystemReadLimit: readLimit,
    _channelFactory: transport.channelFactory,
    _tapiStubFactory: transport.tapiStubFactory,
    _guestStubFactory: transport.guestStubFactory,
  });
  return { client, transport };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bonya-ts-test-"));
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

describe("SandboxFiles", () => {
  it("reads binary content, writes utf-8/binary, and stats metadata", async () => {
    const guest = new FakeFilesystemGuest();
    const { client } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const data = await sandbox.files.read("/tmp/blob");
    expect(Buffer.from(data)).toEqual(Buffer.concat([Buffer.from("bin\0"), Buffer.from([0xff])]));

    await sandbox.files.write("/tmp/empty", new Uint8Array());
    await sandbox.files.write("/tmp/text", "snowman: ☃");

    const info = await sandbox.files.stat("/tmp/blob");
    expect(info.kind).toBe(FileKind.FILE);
    expect(info.modifiedAt.getTime()).toBeCloseTo(1_700_000_000_123.456789, -1);

    expect(guest.readRequests[0].path).toBe("/tmp/blob");
    const textFrames = guest.writeFramesLog[1] as any[];
    expect(Buffer.from(textFrames[1].chunk.data).toString("utf-8")).toBe("snowman: ☃");
  });

  it("uploads in 64 KiB chunks and downloads atomically", async () => {
    const guest = new FakeFilesystemGuest();
    const { client } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const sourcePath = path.join(tmpDir, "source.bin");
    await fsPromises.writeFile(sourcePath, Buffer.concat([Buffer.alloc(TRANSFER_CHUNK_BYTES, "a"), Buffer.from("bbb")]));

    await sandbox.files.upload(sourcePath, "/tmp/source.bin");
    const chunks = (guest.writeFramesLog[0] as any[]).filter((f) => f.chunk).map((f) => f.chunk.data.length);
    expect(chunks).toEqual([TRANSFER_CHUNK_BYTES, 3]);

    const destination = path.join(tmpDir, "dest.bin");
    await fsPromises.writeFile(destination, "old");
    guest.readChunks = [Buffer.from("new"), Buffer.from([0x00, ...Buffer.from("data")])];

    await sandbox.files.download("/tmp/source.bin", destination);
    const result = await fsPromises.readFile(destination);
    expect(result).toEqual(Buffer.concat([Buffer.from("new"), Buffer.from([0x00]), Buffer.from("data")]));

    const entries = await fsPromises.readdir(tmpDir);
    expect(entries.some((name) => name.includes(".bonya-download-"))).toBe(false);
  });

  it("cleans up the temp file and preserves the destination on a pre-replace error", async () => {
    const guest = new FakeFilesystemGuest();
    guest.readError = new RpcFailure(grpc.status.NOT_FOUND, "open file failed: missing");
    const { client } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const destination = path.join(tmpDir, "dest.bin");
    await fsPromises.writeFile(destination, "old");

    await expect(sandbox.files.download("/tmp/missing", destination)).rejects.toThrow(RemoteFileNotFoundError);

    expect((await fsPromises.readFile(destination)).toString()).toBe("old");
    const entries = await fsPromises.readdir(tmpDir);
    expect(entries.some((name) => name.includes(".bonya-download-"))).toBe(false);
  });

  it("cancels the read stream and raises FilesystemLimitError before unbounded growth", async () => {
    const guest = new FakeFilesystemGuest();
    guest.readChunks = [Buffer.from("1234"), Buffer.from("5")];
    const { client } = makeFilesClient(guest, 4);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await expect(sandbox.files.read("/tmp/blob")).rejects.toThrow(FilesystemLimitError);
  });

  it("lists complete, sorted immediate children", async () => {
    const guest = new FakeFilesystemGuest();
    guest.listFiles = [
      { path: "/tmp/b", name: "b", kind: 2 },
      { path: "/tmp/a", name: "a", kind: 3 },
      { path: "/tmp/c", name: "c", kind: 4 },
    ];
    const { client } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const files = await sandbox.files.list("/tmp");
    expect(files.map((f) => f.name)).toEqual(["a", "b", "c"]);
    expect(files.map((f) => f.kind)).toEqual([FileKind.SYMLINK, FileKind.DIRECTORY, FileKind.OTHER]);
  });

  it.each([
    [new RpcFailure(grpc.status.NOT_FOUND, "missing"), RemoteFileNotFoundError, "stat"],
    [new RpcFailure(grpc.status.ALREADY_EXISTS, "destination already exists"), RemoteFileExistsError, "move"],
    [new RpcFailure(grpc.status.FAILED_PRECONDITION, "cross_filesystem_move"), CrossFilesystemMoveError, "move"],
    [new RpcFailure(grpc.status.RESOURCE_EXHAUSTED, "frame limit exceeded"), FilesystemLimitError, "read"],
    [new RpcFailure(grpc.status.INTERNAL, "disk failed"), FilesystemError, "mkdir"],
  ] as const)("maps filesystem errors: %#", async (error, errorClass, method) => {
    const guest = new FakeFilesystemGuest();
    if (method === "stat") guest.statError = error;
    else if (method === "move") guest.moveError = error;
    else if (method === "read") guest.readError = error;
    else guest.mkdirError = error;
    const { client } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const action =
      method === "stat"
        ? () => sandbox.files.stat("/tmp/missing")
        : method === "move"
          ? () => sandbox.files.move("/tmp/a", "/tmp/b")
          : method === "read"
            ? () => sandbox.files.read("/tmp/a")
            : () => sandbox.files.mkdir("/tmp/a");

    await expect(action()).rejects.toThrow(errorClass);
  });

  it("refreshes an unexpired token once on a filesystem capability rejection", async () => {
    const guest = new FakeFilesystemGuest();
    guest.statError = new RpcFailure(grpc.status.PERMISSION_DENIED, "filesystem capability rejected");
    const { client, transport } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const info = await sandbox.files.stat("/tmp/blob");

    expect(info.name).toBe("blob");
    expect(transport.tapi.getRequests).toHaveLength(1);
    expect((sandbox as any)._capability).toBe("fresh-get-cap");
    expect(guest.statRequests).toHaveLength(2);
  });

  it("refreshes once on a sandbox-binding rejection too", async () => {
    const guest = new FakeFilesystemGuest();
    guest.statError = new RpcFailure(grpc.status.PERMISSION_DENIED, "filesystem capability sandbox binding rejected");
    const { client, transport } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await sandbox.files.stat("/tmp/blob");
    expect(transport.tapi.getRequests).toHaveLength(1);
  });

  it("does not refresh on an ordinary permission-denied", async () => {
    const guest = new FakeFilesystemGuest();
    guest.statError = new RpcFailure(grpc.status.PERMISSION_DENIED, "stat file failed: permission denied");
    const { client, transport } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await expect(sandbox.files.stat("/root/secret")).rejects.toThrow(FilesystemError);
    expect(transport.tapi.getRequests).toHaveLength(0);
    expect(guest.statRequests).toHaveLength(1);
  });

  it("retries a capability rejection only once", async () => {
    const guest = new FakeFilesystemGuest();
    let calls = 0;
    const originalStat = guest.statFile.bind(guest);
    guest.statFile = (request: any, metadata: any, options: any, callback: any) => {
      calls += 1;
      if (calls <= 2) {
        guest.statError = new RpcFailure(grpc.status.PERMISSION_DENIED, "filesystem capability rejected");
      }
      return originalStat(request, metadata, options, callback);
    };
    const { client, transport } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await expect(sandbox.files.stat("/tmp/blob")).rejects.toThrow(CapabilityRejectedError);
    expect(transport.tapi.getRequests).toHaveLength(1);
  });

  it("does not retry a mutating call on UNAVAILABLE", async () => {
    const guest = new FakeFilesystemGuest();
    guest.moveError = new RpcFailure(grpc.status.UNAVAILABLE, "uncertain outcome");
    const { client, transport } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await expect(sandbox.files.move("/tmp/a", "/tmp/b")).rejects.toThrow(FilesystemError);
    expect(guest.moveRequests).toHaveLength(1);
    expect(transport.tapi.getRequests).toHaveLength(0);
  });

  it("serializes mkdir/remove/move requests", async () => {
    const guest = new FakeFilesystemGuest();
    const { client } = makeFilesClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await sandbox.files.mkdir("/tmp/a");
    await sandbox.files.remove("/tmp/a", true);
    await sandbox.files.move("/tmp/a", "/tmp/b");

    expect(guest.mkdirRequests[0].path).toBe("/tmp/a");
    expect(guest.removeRequests[0].recursive).toBe(true);
    expect(guest.moveRequests[0].sourcePath).toBe("/tmp/a");
    expect(guest.moveRequests[0].destinationPath).toBe("/tmp/b");
  });
});
