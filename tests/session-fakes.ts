import * as grpc from "@grpc/grpc-js";
import { EventEmitter } from "node:events";

export class FakeAttachStream extends EventEmitter {
  written: any[] = [];
  ended = false;
  cancelled = false;

  constructor(private scripted: Array<() => any>) {
    super();
  }

  write(frame: any): boolean {
    this.written.push(frame);
    if (frame.start) {
      queueMicrotask(() => this.playNext());
    }
    return true;
  }

  end(): void {
    this.ended = true;
  }

  cancel(): void {
    this.cancelled = true;
  }

  private playNext(): void {
    const next = this.scripted.shift();
    if (!next) {
      return;
    }
    const response = next();
    if (response === "END") {
      this.emit("end");
      return;
    }
    if (response === "ERROR") {
      return;
    }
    this.emit("data", response);
    queueMicrotask(() => this.playNext());
  }
}

export function acceptedFrame(overrides: Partial<{ name: string; replayedBytes: number; historyDropped: boolean; cols: number; rows: number }> = {}) {
  return {
    accepted: {
      session: {
        name: overrides.name ?? "server",
        command: ["bash"],
        workingDir: "",
        status: 3,
        attached: true,
        startedAtUnixNanos: 1_700_000_000_000_000_000,
        lastActivityUnixNanos: 1_700_000_000_000_000_000,
        endedAtUnixNanos: 0,
        exit: undefined,
      },
      replayedBytes: overrides.replayedBytes ?? 0,
      historyDropped: overrides.historyDropped ?? false,
      cols: overrides.cols ?? 80,
      rows: overrides.rows ?? 24,
    },
  };
}

export class FakeSessionGuest {
  createSessionImpl: ((request: any, metadata: grpc.Metadata, options: unknown, callback: any) => void) | undefined;
  listSessionsImpl: ((request: any, metadata: grpc.Metadata, options: unknown, callback: any) => void) | undefined;
  killSessionImpl: ((request: any, metadata: grpc.Metadata, options: unknown, callback: any) => void) | undefined;
  attachSessionImpl: ((metadata: grpc.Metadata) => FakeAttachStream) | undefined;

  createRequests: any[] = [];
  listRequests: any[] = [];
  killRequests: any[] = [];
  metadataLog: grpc.Metadata[] = [];

  createSession = (request: any, metadata: grpc.Metadata, options: unknown, callback: any): any => {
    this.createRequests.push(request);
    this.metadataLog.push(metadata);
    if (this.createSessionImpl) {
      this.createSessionImpl(request, metadata, options, callback);
    } else {
      queueMicrotask(() =>
        callback(null, {
          session: {
            name: request.name,
            command: request.command,
            workingDir: request.workingDir,
            status: 1,
            attached: false,
            startedAtUnixNanos: 1_700_000_000_000_000_000,
            lastActivityUnixNanos: 1_700_000_000_000_000_000,
            endedAtUnixNanos: 0,
            exit: undefined,
          },
        }),
      );
    }
    return new EventEmitter();
  };

  listSessions = (request: any, metadata: grpc.Metadata, options: unknown, callback: any): any => {
    this.listRequests.push(request);
    this.metadataLog.push(metadata);
    if (this.listSessionsImpl) {
      this.listSessionsImpl(request, metadata, options, callback);
    } else {
      queueMicrotask(() => callback(null, { sessions: [], sandboxSuspended: false }));
    }
    return new EventEmitter();
  };

  killSession = (request: any, metadata: grpc.Metadata, options: unknown, callback: any): any => {
    this.killRequests.push(request);
    this.metadataLog.push(metadata);
    if (this.killSessionImpl) {
      this.killSessionImpl(request, metadata, options, callback);
    } else {
      queueMicrotask(() =>
        callback(null, {
          session: {
            name: request.name,
            command: [],
            workingDir: "",
            status: 5,
            attached: false,
            startedAtUnixNanos: 1_700_000_000_000_000_000,
            lastActivityUnixNanos: 1_700_000_000_000_000_000,
            endedAtUnixNanos: 1_700_000_001_000_000_000,
            exit: { exitCode: 0, signaled: false, signal: 0 },
          },
        }),
      );
    }
    return new EventEmitter();
  };

  attachSession = (metadata: grpc.Metadata): FakeAttachStream => {
    this.metadataLog.push(metadata);
    if (this.attachSessionImpl) {
      return this.attachSessionImpl(metadata);
    }
    return new FakeAttachStream([() => acceptedFrame(), () => "END"]);
  };
}
