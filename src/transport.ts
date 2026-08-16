import * as fs from "node:fs";
import * as grpc from "@grpc/grpc-js";

import { ConnectionError, InvalidRequestError, TimeoutError } from "./errors.js";

/**
 * The endpoint used when neither the `endpoint` option nor BONYA_ENDPOINT
 * names one. Self-hosted deployments must set one of those explicitly.
 */
export const DEFAULT_ENDPOINT = "https://api.tyto.run";

export interface NormalizedEndpoint {
  /** Canonical https URL, with trailing slash and empty path stripped. */
  readonly url: string;
  /** authority[:port][/path] target grpc-js dials. */
  readonly target: string;
}

/**
 * Validates and normalizes an endpoint URL. Mirrors
 * sdks/python/src/tyto/_transport.py:normalize_endpoint: https-only, no
 * userinfo, no query/fragment, a resolvable host, and a well-formed port.
 */
export function normalizeEndpoint(endpoint: string): NormalizedEndpoint {
  const raw = endpoint.trim();
  if (!raw) {
    throw new InvalidRequestError("endpoint is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InvalidRequestError("endpoint is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidRequestError("endpoint must use https");
  }
  if (parsed.username || parsed.password) {
    throw new InvalidRequestError("endpoint must not include credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new InvalidRequestError("endpoint must not include query strings or fragments");
  }
  if (!parsed.hostname) {
    throw new InvalidRequestError("endpoint requires a host");
  }
  const port = parsed.port;
  if (port !== "" && !/^\d+$/.test(port)) {
    throw new InvalidRequestError("endpoint has a malformed port");
  }

  const host = parsed.hostname;
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const authorityWithPort = port ? `${authority}:${port}` : authority;
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path === "/") {
    path = "";
  }
  const url = `https://${authorityWithPort}${path}`;
  const target = `${authorityWithPort}${path}`;
  return { url, target };
}

/** Reads an optional PEM CA bundle and builds gRPC channel credentials. */
export function channelCredentials(caBundle: string | undefined): grpc.ChannelCredentials {
  let rootCertificates: Buffer | null = null;
  if (caBundle) {
    try {
      rootCertificates = fs.readFileSync(caBundle);
    } catch {
      throw new InvalidRequestError("ca_bundle could not be read");
    }
  }
  return grpc.credentials.createSsl(rootCertificates);
}

export interface ClosableChannel {
  close(): void;
}

export type ChannelFactory = (
  endpoint: NormalizedEndpoint,
  credentials: grpc.ChannelCredentials,
) => ClosableChannel;

/**
 * Caches one grpc.Channel per normalized endpoint URL, closed together by
 * close(). Generated grpc-js clients (via `makeGenericClientConstructor`)
 * require `new (address: string, credentials, options?)` and build their own
 * channel internally, so a pooled channel cannot be passed as that
 * constructor's first argument directly. Instead, each stub factory passes
 * this pooled channel through the `channelOverride` client option, which
 * grpc-js supports precisely for sharing one channel across multiple
 * generated clients.
 */
export class ChannelPool {
  private readonly credentials: grpc.ChannelCredentials;
  private readonly factory: ChannelFactory;
  private closed = false;
  private readonly channels = new Map<string, ClosableChannel>();

  constructor(credentials: grpc.ChannelCredentials, factory?: ChannelFactory) {
    this.credentials = credentials;
    this.factory = factory ?? ChannelPool.newChannel;
  }

  get(endpoint: NormalizedEndpoint): ClosableChannel {
    if (this.closed) {
      throw new InvalidRequestError("client is closed");
    }
    let channel = this.channels.get(endpoint.url);
    if (!channel) {
      channel = this.factory(endpoint, this.credentials);
      this.channels.set(endpoint.url, channel);
    }
    return channel;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const channels = Array.from(this.channels.values());
    this.channels.clear();
    for (const channel of channels) {
      channel.close();
    }
  }

  private static newChannel(
    endpoint: NormalizedEndpoint,
    credentials: grpc.ChannelCredentials,
  ): ClosableChannel {
    return new grpc.Channel(endpoint.target, credentials, {}) as unknown as ClosableChannel;
  }
}

/** Constructs a generated grpc-js client sharing an existing pooled channel. */
export function clientFromPooledChannel<T>(
  ctor: new (address: string, credentials: grpc.ChannelCredentials, options?: Partial<grpc.ClientOptions>) => T,
  channel: ClosableChannel,
  credentials: grpc.ChannelCredentials,
): T {
  return new ctor("", credentials, { channelOverride: channel as unknown as grpc.Channel });
}

/** A monotonic per-operation deadline shared across retries of one call. */
export class Deadline {
  readonly expiresAt: number;

  private constructor(expiresAt: number) {
    this.expiresAt = expiresAt;
  }

  static start(timeout: number | undefined): Deadline {
    if (timeout === undefined) {
      return new Deadline(Number.POSITIVE_INFINITY);
    }
    if (timeout <= 0) {
      throw new TimeoutError("operation deadline exhausted");
    }
    return new Deadline(monotonicNow() + timeout * 1000);
  }

  /** Remaining time in seconds, as grpc-js deadlines expect a Date or milliseconds-from-epoch. */
  remaining(): number {
    const remainingMs = this.expiresAt - monotonicNow();
    if (remainingMs <= 0) {
      throw new TimeoutError("operation deadline exhausted");
    }
    return remainingMs / 1000;
  }

  /** A wall-clock Date suitable for grpc-js call deadlines. */
  deadlineDate(): Date {
    return new Date(Date.now() + this.remaining() * 1000);
  }
}

function monotonicNow(): number {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1000 + nanoseconds / 1e6;
}

export function redact(value: string): string {
  return value ? "[redacted]" : value;
}

const PATH_PATTERN = /(?<!\S)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+/g;

/**
 * Redacts secrets and path-like substrings from an error message. Mirrors
 * sdks/python/src/tyto/_transport.py:sanitize_message.
 */
export function sanitizeMessage(message: unknown, secrets: readonly (string | undefined)[]): string {
  let text = String(message);
  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join("[redacted]");
    }
  }
  text = text.replace(PATH_PATTERN, "[redacted-path]");
  return text;
}

export function sleepWithDeadline(seconds: number, deadline: Deadline): Promise<void> {
  const remainingMs = Math.max(0, deadline.expiresAt - monotonicNow());
  const waitMs = Math.min(seconds * 1000, remainingMs);
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

// Re-exported so callers that only need typed errors do not need to import
// errors.ts directly for this one case.
export { ConnectionError };
