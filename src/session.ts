import * as grpc from "@grpc/grpc-js";

import { InvalidRequestError, TimeoutError } from "./errors.js";
import { mapRpcError } from "./grpc-errors.js";
import { Deadline } from "./transport.js";
import { Exit, ExecEvent, Stderr, Stdout } from "./types.js";
import { GuestServiceClient, type ExecRequest, type ExecResponse } from "./proto/tyto/runtime/v1/guest.js";

const HALF_CLOSE = Symbol("half-close");
const END_REQUESTS = Symbol("end-requests");
type RequestItem = ExecRequest | typeof HALF_CLOSE | typeof END_REQUESTS;
type ResponseItem = ExecEvent | { error: unknown };

export interface ExecSessionOptions {
  sandboxId: string;
  operationId: string;
  command: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  tty?: boolean;
  cols?: number;
  rows?: number;
  stub: GuestServiceClient;
  capability: string;
  timeout: number;
  secrets: readonly (string | undefined)[];
  onError?: (error: unknown) => unknown;
}

/**
 * A live duplex Exec stream: a background reader drains gRPC responses into
 * a bounded async queue, while writes are pushed into a bounded outbound
 * queue drained by a request generator. Mirrors
 * sdks/python/src/tyto/_session.py:ExecSession.
 */
export class ExecSession implements AsyncIterable<ExecEvent> {
  private readonly sandboxId: string;
  private readonly operationId: string;
  private readonly tty: boolean;
  private readonly secrets: readonly (string | undefined)[];
  private readonly onError: ((error: unknown) => unknown) | undefined;
  private readonly deadline: Deadline;
  private readonly cleanupTimeoutMs: number;

  private closed = false;
  private stdinClosed = false;
  private cancelled = false;
  private requestEnded = false;

  private readonly outbound: RequestItem[] = [];
  private outboundWaiters: Array<() => void> = [];

  private readonly inbound: ResponseItem[] = [];
  private inboundWaiters: Array<() => void> = [];
  private readonly maxQueue = 16;

  private stream!: grpc.ClientDuplexStream<ExecRequest, ExecResponse>;
  private readerDone: Promise<void> | undefined;

  constructor(options: ExecSessionOptions) {
    const { tty, cols, rows } = validateStartTtyOptions(options.tty ?? false, options.cols ?? 0, options.rows ?? 0);
    this.sandboxId = options.sandboxId;
    this.operationId = options.operationId;
    this.tty = tty;
    this.secrets = options.secrets;
    this.onError = options.onError;
    this.deadline = Deadline.start(options.timeout);
    this.cleanupTimeoutMs = Math.min(5000, Math.max(500, options.timeout * 1000));

    const start: ExecRequest = {
      start: {
        command: [...options.command],
        env: options.env ? { ...options.env } : {},
        workingDir: options.cwd ?? "",
        tty,
        cols,
        rows,
      },
    };
    this.outbound.push(start);

    const metadata = new grpc.Metadata();
    metadata.add("bonya-sandbox-id", options.sandboxId);
    metadata.add("bonya-exec-capability", options.capability);

    this.stream = options.stub.exec(metadata);
    this.stream.on("data", (response: ExecResponse) => this.handleResponse(response));
    this.stream.on("end", () => this.handleStreamEnd());
    this.stream.on("error", (error: unknown) => this.handleStreamError(error));
    this.pumpOutbound();
  }

  [Symbol.asyncIterator](): AsyncIterator<ExecEvent> {
    return {
      next: async (): Promise<IteratorResult<ExecEvent>> => {
        const item = await this.takeInbound();
        if (item === END_REQUESTS) {
          return { done: true, value: undefined };
        }
        if (this.isErrorItem(item)) {
          throw item.error;
        }
        return { done: false, value: item as ExecEvent };
      },
    };
  }

  write(data: Uint8Array): void {
    if (this.closed || this.cancelled) {
      throw new InvalidRequestError("Exec session is closed", { sandboxId: this.sandboxId });
    }
    if (this.stdinClosed) {
      throw new InvalidRequestError("stdin is closed", { sandboxId: this.sandboxId });
    }
    this.pushOutbound({ stdin: { data: Buffer.from(data) } });
  }

  closeStdin(): void {
    if (this.stdinClosed) {
      return;
    }
    this.stdinClosed = true;
    this.pushOutbound(HALF_CLOSE);
  }

  resize(options: { cols: number; rows: number }): void {
    const cols = validateResizeDimension("cols", options.cols);
    const rows = validateResizeDimension("rows", options.rows);
    if (!this.tty) {
      throw new InvalidRequestError("resize requires a tty Exec session", { sandboxId: this.sandboxId });
    }
    if (this.closed || this.cancelled) {
      throw new InvalidRequestError("Exec session is closed", { sandboxId: this.sandboxId });
    }
    if (this.stdinClosed) {
      throw new InvalidRequestError("stdin is closed", { sandboxId: this.sandboxId });
    }
    this.pushOutbound({ resize: { cols, rows } });
  }

  cancel(): void {
    if (this.closed || this.cancelled) {
      return;
    }
    this.cancelled = true;
    this.stdinClosed = true;
    if (!this.requestEnded) {
      // Drop any pending half-close so cancel is the last frame sent.
      const idx = this.outbound.indexOf(HALF_CLOSE);
      if (idx >= 0) {
        this.outbound.splice(idx, 1);
      }
      this.pushOutboundCleanup({ cancel: {} });
      this.pushOutboundCleanup(END_REQUESTS);
    } else {
      this.stream.cancel();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.cancel();
  }

  private handleResponse(response: ExecResponse): void {
    const event = responseEvent(response, this.sandboxId);
    this.pushInbound(event);
    if (event instanceof Exit) {
      this.pushInbound(END_REQUESTS);
      this.markTerminal();
    }
  }

  private handleStreamEnd(): void {
    this.pushInbound(END_REQUESTS);
  }

  private handleStreamError(error: unknown): void {
    if (this.closed || this.cancelled) {
      this.pushInbound(END_REQUESTS);
      return;
    }
    const mapped = this.onError
      ? this.onError(error)
      : mapRpcError(error, {
          secrets: this.secrets,
          sandboxId: this.sandboxId,
          operationId: this.operationId,
          execRpc: true,
        });
    this.pushInbound({ error: mapped });
  }

  private markTerminal(): void {
    this.closed = true;
    this.stdinClosed = true;
    this.pushInboundCleanup(END_REQUESTS);
  }

  private pumpOutbound(): void {
    (async () => {
      try {
        for (;;) {
          const item = await this.takeOutbound();
          if (item === HALF_CLOSE || item === END_REQUESTS) {
            return;
          }
          this.stream.write(item as ExecRequest);
        }
      } finally {
        this.requestEnded = true;
        this.stream.end();
      }
    })().catch(() => {
      // Stream write errors surface via the 'error' event handler.
    });
  }

  private pushOutbound(item: RequestItem): void {
    this.outbound.push(item);
    this.drainOutboundWaiters();
  }

  private pushOutboundCleanup(item: RequestItem): void {
    this.outbound.push(item);
    this.drainOutboundWaiters();
  }

  private async takeOutbound(): Promise<RequestItem> {
    for (;;) {
      const item = this.outbound.shift();
      if (item !== undefined) {
        return item;
      }
      await new Promise<void>((resolve) => this.outboundWaiters.push(resolve));
    }
  }

  private drainOutboundWaiters(): void {
    const waiters = this.outboundWaiters;
    this.outboundWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private pushInbound(item: ResponseItem | typeof END_REQUESTS): void {
    if (this.inbound.length >= this.maxQueue) {
      // Bounded, best-effort: drop oldest rather than deadlock the reader
      // callback (grpc-js delivers 'data' synchronously off the event loop).
      this.inbound.shift();
    }
    this.inbound.push(item as ResponseItem);
    this.drainInboundWaiters();
  }

  private pushInboundCleanup(item: ResponseItem | typeof END_REQUESTS): void {
    this.inbound.push(item as ResponseItem);
    this.drainInboundWaiters();
  }

  private async takeInbound(): Promise<ResponseItem | typeof END_REQUESTS> {
    const item = this.inbound.shift();
    if (item !== undefined) {
      return item as ResponseItem | typeof END_REQUESTS;
    }
    const remaining = this.deadline.expiresAt - now();
    if (remaining <= 0) {
      this.cancel();
      throw new TimeoutError("Exec timed out", { sandboxId: this.sandboxId, operationId: this.operationId });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancel();
        reject(new TimeoutError("Exec timed out", { sandboxId: this.sandboxId, operationId: this.operationId }));
      }, remaining);
      this.inboundWaiters.push(() => {
        clearTimeout(timer);
        const next = this.inbound.shift();
        resolve((next ?? END_REQUESTS) as ResponseItem | typeof END_REQUESTS);
      });
    });
  }

  private drainInboundWaiters(): void {
    if (this.inboundWaiters.length === 0) {
      return;
    }
    const waiter = this.inboundWaiters.shift();
    waiter?.();
  }

  private isErrorItem(item: ResponseItem | typeof END_REQUESTS): item is { error: unknown } {
    return typeof item === "object" && item !== null && "error" in item;
  }
}

function responseEvent(response: ExecResponse, sandboxId: string): ExecEvent {
  if (response.stdout) {
    return new Stdout(new Uint8Array(response.stdout.data));
  }
  if (response.stderr) {
    return new Stderr(new Uint8Array(response.stderr.data));
  }
  if (response.exit) {
    return new Exit(response.exit.exitCode, response.exit.signaled, response.exit.signal);
  }
  throw new InvalidRequestError("Exec response contained no frame", { sandboxId });
}

export function validateResizeDimension(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new InvalidRequestError(`${name} must be a positive integer <= 512`);
  }
  if (value < 1 || value > 512) {
    throw new InvalidRequestError(`${name} must be a positive integer <= 512`);
  }
  return value;
}

function validateStartTtyOptions(tty: boolean, cols: number, rows: number): { tty: boolean; cols: number; rows: number } {
  if (typeof tty !== "boolean") {
    throw new InvalidRequestError("tty must be a boolean");
  }
  if (!Number.isInteger(cols)) {
    throw new InvalidRequestError("cols must be a positive integer <= 512");
  }
  if (!Number.isInteger(rows)) {
    throw new InvalidRequestError("rows must be a positive integer <= 512");
  }
  if (!tty) {
    if (cols !== 0 || rows !== 0) {
      throw new InvalidRequestError("tty dimensions require tty=True");
    }
    return { tty: false, cols: 0, rows: 0 };
  }
  if (cols === 0 && rows === 0) {
    return { tty: true, cols: 0, rows: 0 };
  }
  return { tty: true, cols: validateResizeDimension("cols", cols), rows: validateResizeDimension("rows", rows) };
}

function now(): number {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1000 + nanoseconds / 1e6;
}
