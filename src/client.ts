import * as grpc from "@grpc/grpc-js";
import { randomUUID } from "node:crypto";

import {
  InvalidRequestError,
  SandboxCreationFailedError,
  SandboxCreationTimeoutError,
  SandboxNotFoundError,
  TimeoutError,
} from "./errors.js";
import { isRetryableTransportError, mapRpcError } from "./grpc-errors.js";
import { Sandbox, Snapshot, type DeleteResult, type ResumeResult } from "./sandbox.js";
import { type CreatePreviewOptions, type Preview } from "./previews.js";
import {
  type AttachSessionOptions,
  type CreateSessionOptions,
  type SessionInfo,
  type SessionList,
  type SessionStream,
} from "./sessions.js";
import {
  ChannelFactory,
  ChannelPool,
  Deadline,
  DEFAULT_ENDPOINT,
  NormalizedEndpoint,
  channelCredentials,
  clientFromPooledChannel,
  normalizeEndpoint,
  sleepWithDeadline,
} from "./transport.js";
import { Status, Wait } from "./types.js";
import {
  CreateWait,
  TApiServiceClient,
  TerminalState,
  type TApiGetSandboxResponse,
  type TApiListOrganizationsResponse,
  type TApiListSandboxesResponse,
  type TApiOrganization,
  type TApiSandboxMetadata,
  type TApiServiceCreateResponse,
} from "./proto/tyto/runtime/v1/tapi.js";
import { GuestServiceClient } from "./proto/tyto/runtime/v1/guest.js";

/**
 * gRPC metadata carrier for org context. The REST surface names the same
 * value `X-Bonya-Organization-ID`; omitting either resolves to the caller's
 * personal organization.
 */
export const ORGANIZATION_METADATA_KEY = "bonya-organization-id";

export type WaitInput = Wait | "ready" | "none";

/** The subset of TApiServiceClient methods the SDK calls, all unary. */
type UnaryMethod<Req, Res> = (
  request: Req,
  metadata: grpc.Metadata,
  callback: (error: grpc.ServiceError | null, response: Res) => void,
) => grpc.ClientUnaryCall;

export interface TapiStub {
  create: UnaryMethod<unknown, TApiServiceCreateResponse>;
  getSandbox: UnaryMethod<unknown, TApiGetSandboxResponse>;
  listSandboxes: UnaryMethod<unknown, TApiListSandboxesResponse>;
  resumeSandbox: UnaryMethod<unknown, unknown>;
  createSnapshot: UnaryMethod<unknown, unknown>;
  deleteSnapshot: UnaryMethod<unknown, unknown>;
  deleteSandbox: UnaryMethod<unknown, unknown>;
  reissueCapability: UnaryMethod<unknown, unknown>;
  createPreview: UnaryMethod<unknown, unknown>;
  deletePreview: UnaryMethod<unknown, unknown>;
  listPreviews: UnaryMethod<unknown, unknown>;
  listOrganizations: UnaryMethod<unknown, TApiListOrganizationsResponse>;
}

const TAPI_METHOD_NAMES = [
  "create",
  "getSandbox",
  "listSandboxes",
  "resumeSandbox",
  "createSnapshot",
  "deleteSnapshot",
  "deleteSandbox",
  "reissueCapability",
  "createPreview",
  "deletePreview",
  "listPreviews",
  "listOrganizations",
] as const;

/**
 * Wraps a TApi stub so org context is attached to every RPC by
 * construction, instead of being passed at each call site. The SDK makes
 * eleven TApi calls across four modules; a per-call-site approach risks a
 * future call silently omitting the header. When no organization is
 * configured, the client hands out the bare stub instead of this wrapper,
 * so an unconfigured call is byte-identical to what the SDK sent before org
 * context existed.
 */
function wrapWithOrgContext(stub: TApiServiceClient, metadataEntries: readonly [string, string][]): TapiStub {
  const stubRecord = stub as unknown as Record<string, UnaryMethod<unknown, unknown>>;
  const wrapped: Record<string, UnaryMethod<unknown, unknown>> = {};
  for (const name of TAPI_METHOD_NAMES) {
    const original = stubRecord[name];
    if (!original) {
      continue;
    }
    wrapped[name] = (request, metadata, callback) => {
      for (const [key, value] of metadataEntries) {
        metadata.add(key, value);
      }
      return original.call(stub, request, metadata, callback);
    };
  }
  return wrapped as unknown as TapiStub;
}

/**
 * Wraps a TApi stub without attaching org context, preserving `this`
 * binding on each method the same way wrapWithOrgContext does. Generated
 * grpc-js clients rely on instance state inside their unary methods, so
 * handing out the stub's methods detached from the instance (e.g. via a
 * bare `stub as TapiStub` cast) breaks at call time even though it
 * type-checks.
 */
function bareStub(stub: TApiServiceClient): TapiStub {
  const stubRecord = stub as unknown as Record<string, UnaryMethod<unknown, unknown>>;
  const wrapped: Record<string, UnaryMethod<unknown, unknown>> = {};
  for (const name of TAPI_METHOD_NAMES) {
    const original = stubRecord[name];
    if (!original) {
      continue;
    }
    wrapped[name] = (request, metadata, callback) => original.call(stub, request, metadata, callback);
  }
  return wrapped as unknown as TapiStub;
}

/** Promisifies a standard grpc-js unary call: method(request, metadata, callback). */
export function callUnary<Req, Res>(
  method: UnaryMethod<Req, Res>,
  request: Req,
  metadata: grpc.Metadata,
  deadline: Deadline,
): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    const call = method(request, metadata, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
    // grpc-js unary calls accept a deadline via CallOptions, not directly on
    // ClientUnaryCall; cancellation on deadline is handled by the caller's
    // Deadline bookkeeping (mirrors the Python SDK's timeout=... per call).
    void deadline;
    void call;
  });
}

export type TapiStubFactory = (channel: unknown) => TApiServiceClient;
export type GuestStubFactory = (channel: unknown) => GuestServiceClient;

export interface TytoOptions {
  apiKey?: string;
  endpoint?: string;
  caBundle?: string;
  organizationId?: string;
  timeout?: number;
  maxRetries?: number;
  filesystemReadLimit?: number;
  /** @internal test hook */
  _channelFactory?: ChannelFactory;
  /** @internal test hook */
  _tapiStubFactory?: TapiStubFactory;
  /** @internal test hook */
  _guestStubFactory?: GuestStubFactory;
}

export class Tyto {
  /** @internal */ _apiKey: string;
  /** @internal */ _endpoint: NormalizedEndpoint;
  /** @internal */ _organizationId: string | undefined;
  /** @internal */ _timeout: number;
  /** @internal */ _maxRetries: number;
  /** @internal */ _filesystemReadLimit: number;
  /** @internal */ _pool: ChannelPool;
  /** @internal */ _credentials: grpc.ChannelCredentials;
  /** @internal */ _tapiStubFactory: TapiStubFactory;
  /** @internal */ _guestStubFactory: GuestStubFactory | undefined;

  readonly sandboxes: SandboxCollection;

  constructor(options: TytoOptions = {}) {
    const apiKey = options.apiKey ?? process.env["BONYA_API_KEY"];
    if (!apiKey) {
      throw new InvalidRequestError("api_key is required");
    }
    this._apiKey = apiKey;

    const endpointValue = options.endpoint ?? process.env["BONYA_ENDPOINT"] ?? DEFAULT_ENDPOINT;
    this._endpoint = normalizeEndpoint(endpointValue);

    const caBundleValue = options.caBundle ?? process.env["BONYA_CA_BUNDLE"];
    this._organizationId = resolveOrganizationId(options.organizationId);

    const timeout = options.timeout ?? 30;
    if (timeout <= 0) {
      throw new InvalidRequestError("timeout must be positive");
    }
    this._timeout = timeout;

    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new InvalidRequestError("max_retries must be non-negative");
    }
    this._maxRetries = maxRetries;

    const filesystemReadLimit = options.filesystemReadLimit ?? 64 * 1024 * 1024;
    if (!Number.isInteger(filesystemReadLimit) || filesystemReadLimit < 0) {
      throw new InvalidRequestError("filesystem_read_limit must be a non-negative integer");
    }
    this._filesystemReadLimit = filesystemReadLimit;

    this._credentials = channelCredentials(caBundleValue);
    this._pool = new ChannelPool(this._credentials, options._channelFactory);
    this._tapiStubFactory =
      options._tapiStubFactory ??
      ((channel) => clientFromPooledChannel(TApiServiceClient, channel as never, this._credentials));
    this._guestStubFactory = options._guestStubFactory;

    this.sandboxes = new SandboxCollection(this);
  }

  close(): void {
    this._pool.close();
  }

  get organizationId(): string | undefined {
    return this._organizationId;
  }

  /**
   * Changes which organization this client's calls act on. Takes effect
   * immediately: _tapiStub() reads _organizationId fresh on every call
   * rather than baking it into a stub built once, so there is no
   * cached-channel staleness to guard against the way the Go SDK's
   * dial-time interceptor had to.
   *
   * An empty value is an error rather than a silent fallback to the
   * personal organization, matching the constructor's own
   * BONYA_ORGANIZATION_ID handling.
   */
  set organizationId(value: string) {
    this._organizationId = resolveOrganizationId(value);
  }

  /**
   * Lists the organizations this client's api_key's user belongs to,
   * including the personal one every account has. Unlike sandboxes.list this
   * is not paginated: TApi returns every membership in one response.
   */
  async listOrganizations(): Promise<Organization[]> {
    const request = { apiKey: this._apiKey };
    const deadline = Deadline.start(this._timeout);
    let attempts = 0;
    let backoff = 0.05;
    for (;;) {
      try {
        const response = await callUnary(this._tapiStub().listOrganizations, request, new grpc.Metadata(), deadline);
        return (response.organizations ?? []).map(organizationFromProto);
      } catch (exc) {
        if (!isRetryableTransportError(exc) || attempts >= this._maxRetries) {
          throw mapRpcError(exc, { secrets: this._secrets() });
        }
        attempts += 1;
        await sleepWithDeadline(backoff, deadline);
        backoff = Math.min(backoff * 2, 0.5);
      }
    }
  }

  // Flat, client-level sandbox methods -- client.createSandbox(...)
  // alongside client.sandboxes.create(...). Both spellings exist and both
  // stay: some callers read better with the namespace (grouping every
  // sandbox operation under one property is what makes sandbox.files and
  // sandbox.sessions discoverable next to it), others read better as a verb
  // straight off the client. Every method here is a thin, no-behavior
  // delegation to the SandboxCollection method of the same operation, so
  // there is exactly one implementation to keep correct.
  //
  // This flattening stops at the client. sandbox.files, sandbox.sessions,
  // and sandbox.previews keep their namespaces.

  /** sandboxes.create(). */
  createSandbox(options: CreateSandboxOptions): Promise<Sandbox> {
    return this.sandboxes.create(options);
  }

  /** sandboxes.get(). */
  getSandbox(sandboxId: string): Promise<Sandbox> {
    return this.sandboxes.get(sandboxId);
  }

  /** sandboxes.getByName(). */
  getSandboxByName(name: string): Promise<Sandbox> {
    return this.sandboxes.getByName(name);
  }

  /** sandboxes.list(). */
  listSandboxes(options: ListSandboxesOptions = {}): AsyncIterableIterator<SandboxSummary> {
    return this.sandboxes.list(options);
  }

  /**
   * sandboxes.delete(): a single id-only RPC, with no local handle to check
   * for an already-known deletion. sandbox.delete() is the handle-aware
   * form, and is what a Sandbox obtained from createSandbox() or
   * getSandbox() should generally use instead, so that a repeat call is a
   * local no-op rather than a second RPC.
   */
  deleteSandbox(sandboxId: string): Promise<DeleteResult> {
    return this.sandboxes.delete(sandboxId);
  }

  /**
   * sandboxes.resume(): a single id-only RPC, with no local handle to
   * update afterward. sandbox.resume() is the handle-aware form, and is
   * what a Sandbox should generally use instead, so that its exec
   * capability and endpoint are refreshed for the next call rather than
   * left stale.
   */
  resumeSandbox(sandboxId: string, options: { idempotencyKey?: string } = {}): Promise<ResumeResult> {
    return this.sandboxes.resume(sandboxId, options);
  }

  // Flat, client-level forms of sandbox.sessions, sandbox.previews, and
  // sandbox.snapshot(). Unlike the sandbox-collection methods above, each of
  // these needs a resolved Sandbox to call through -- sessions and previews
  // are scoped to one sandbox's RPC surface, and snapshot creation checks
  // the sandbox's last observed status -- so every method here does a
  // getSandbox() first and then delegates, which costs one extra round trip
  // compared to already holding the handle. Call sandbox.sessions.create()
  // (or the equivalent) directly instead when a Sandbox is already in hand,
  // such as right after createSandbox().

  /** getSandbox() followed by sandbox.sessions.create(). */
  async createSession(
    sandboxId: string,
    name: string,
    command: readonly string[],
    options: CreateSessionOptions = {},
  ): Promise<SessionInfo> {
    const sandbox = await this.getSandbox(sandboxId);
    return sandbox.sessions.create(name, command, options);
  }

  /** getSandbox() followed by sandbox.sessions.list(). */
  async listSessions(sandboxId: string): Promise<SessionList> {
    const sandbox = await this.getSandbox(sandboxId);
    return sandbox.sessions.list();
  }

  /** getSandbox() followed by sandbox.sessions.kill(). */
  async killSession(
    sandboxId: string,
    name: string,
    options: { signal?: string; graceMs?: number } = {},
  ): Promise<SessionInfo> {
    const sandbox = await this.getSandbox(sandboxId);
    return sandbox.sessions.kill(name, options);
  }

  /** getSandbox() followed by sandbox.sessions.attach(). */
  async attachSession(sandboxId: string, name: string, options: AttachSessionOptions = {}): Promise<SessionStream> {
    const sandbox = await this.getSandbox(sandboxId);
    return sandbox.sessions.attach(name, options);
  }

  /** getSandbox() followed by sandbox.previews.create(). */
  async createPreview(sandboxId: string, port: number, options: CreatePreviewOptions = {}): Promise<Preview> {
    const sandbox = await this.getSandbox(sandboxId);
    return sandbox.previews.create(port, options);
  }

  /** getSandbox() followed by sandbox.previews.list(). */
  async listPreviews(sandboxId: string): Promise<Preview[]> {
    const sandbox = await this.getSandbox(sandboxId);
    return sandbox.previews.list();
  }

  /** getSandbox() followed by sandbox.previews.delete(). */
  async deletePreview(sandboxId: string, previewId: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    return sandbox.previews.delete(previewId);
  }

  /** getSandbox() followed by sandbox.snapshot(). */
  async createSnapshot(sandboxId: string, options: { idempotencyKey?: string } = {}): Promise<Snapshot> {
    const sandbox = await this.getSandbox(sandboxId);
    return sandbox.snapshot(options);
  }

  /**
   * getSandbox() followed by sandbox.snapshot()'s Snapshot.delete(): there
   * is no sandbox-level deleteSnapshot() to call through to, since a
   * snapshot's own delete() is what every language's SDK treats as
   * canonical, so this constructs the same Snapshot handle and deletes it.
   */
  async deleteSnapshot(sandboxId: string, snapshotId: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    const snapshot = new Snapshot({ client: this, snapshotId, sourceSandboxId: sandbox.id });
    return snapshot.delete();
  }

  /** @internal */
  _tapiStub(): TapiStub {
    const stub = this._tapiStubFactory(this._pool.get(this._endpoint));
    if (this._organizationId === undefined) {
      return bareStub(stub);
    }
    return wrapWithOrgContext(stub, [[ORGANIZATION_METADATA_KEY, this._organizationId]]);
  }

  /** @internal */
  _execStub(endpoint: string): GuestServiceClient {
    const normalized = normalizeEndpoint(endpoint);
    const factory =
      this._guestStubFactory ??
      ((channel) => clientFromPooledChannel(GuestServiceClient, channel as never, this._credentials));
    return factory(this._pool.get(normalized));
  }

  /** @internal */
  _secrets(...extra: (string | undefined)[]): string[] {
    return [this._apiKey, ...extra].filter((value): value is string => Boolean(value));
  }
}

/**
 * @deprecated Use {@link TytoOptions}. This was the original name, from when
 * the SDK's package and client were both named Bonya. Removed in 2.0.
 */
export type BonyaOptions = TytoOptions;

/**
 * @deprecated Use {@link Tyto}. This was the original name, from when the
 * SDK's package and client were both named Bonya. It is the same class, so
 * `new Bonya(...)` and `instanceof Bonya` still work exactly like `Tyto` --
 * declared as both a value and a type (TypeScript keeps those in separate
 * namespaces) so `Bonya` still works as a type annotation too, the way the
 * original class name did. Removed in 2.0.
 */
export const Bonya = Tyto;
export type Bonya = Tyto;

export interface SandboxSummary {
  readonly id: string;
  readonly operationId: string;
  readonly template: string;
  readonly version: string;
  readonly lastObservedStatus: Status;
  readonly failureCode: string | undefined;
  readonly failureMessage: string | undefined;
  readonly name: string;
}

/** One organization the client's api_key's user belongs to. */
export interface Organization {
  readonly id: string;
  readonly name: string;
  /**
   * Marks the deterministic tenant an omitted organization context resolves
   * to. Every account has exactly one.
   */
  readonly personal: boolean;
  /** The caller's role in this organization: "owner" or "member". */
  readonly role: string;
  readonly createdAt: Date;
}

function organizationFromProto(organization: TApiOrganization): Organization {
  const created = Number(organization.createdAtUnixNanos ?? 0);
  return {
    id: organization.organizationId ?? "",
    name: organization.name ?? "",
    personal: organization.personal ?? false,
    role: organization.role ?? "",
    createdAt: new Date(created / 1e6),
  };
}

export interface CreateSandboxOptions {
  template: string;
  version?: string;
  wait?: WaitInput;
  idempotencyKey?: string;
  /**
   * Optional display name, at most 80 bytes. When omitted the service
   * generates a friendly one, returned on the resulting Sandbox. Names are
   * not unique.
   */
  name?: string;
}

export interface ListSandboxesOptions {
  states?: Iterable<Status>;
  limit?: number;
  /**
   * Filters to sandboxes carrying this exact name. Names are not unique, so
   * this can still match more than one.
   */
  name?: string;
}

export class SandboxCollection {
  private readonly client: Tyto;

  constructor(client: Tyto) {
    this.client = client;
  }

  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const { template, version, wait, idempotencyKey, name } = options;
    if (!template) {
      throw new InvalidRequestError("template is required");
    }
    const waitValue = normalizeWait(wait ?? Wait.READY);
    const key = idempotencyKey ?? randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

    const request = {
      apiKey: this.client._apiKey,
      idempotencyKey: key,
      template: { templateId: template, version: version ?? "", digest: "" },
      wait: waitValue === Wait.READY ? CreateWait.CREATE_WAIT_READY : CreateWait.CREATE_WAIT_NONE,
      network: undefined,
      name: name ?? "",
    };

    const deadline = Deadline.start(this.client._timeout);
    let attempts = 0;
    let backoff = 0.05;
    for (;;) {
      try {
        const response = await callUnary(this.client._tapiStub().create, request, new grpc.Metadata(), deadline);
        return sandboxFromCreate(this.client, response, waitValue, key);
      } catch (exc) {
        if (!isRetryableTransportError(exc) || attempts >= this.client._maxRetries) {
          if (exc instanceof TimeoutError) {
            throw new SandboxCreationTimeoutError(exc.message, { idempotencyKey: key });
          }
          throw mapRpcError(exc, { secrets: this.client._secrets(key), idempotencyKey: key, create: true });
        }
        attempts += 1;
        await sleepWithDeadline(backoff, deadline);
        backoff = Math.min(backoff * 2, 0.5);
      }
    }
  }

  async get(sandboxId: string): Promise<Sandbox> {
    if (!sandboxId) {
      throw new InvalidRequestError("sandbox_id is required");
    }
    const request = { apiKey: this.client._apiKey, sandboxId };
    const deadline = Deadline.start(this.client._timeout);
    let attempts = 0;
    let backoff = 0.05;
    for (;;) {
      try {
        const response = await callUnary(this.client._tapiStub().getSandbox, request, new grpc.Metadata(), deadline);
        return sandboxFromGet(this.client, response, sandboxId);
      } catch (exc) {
        if (!isRetryableTransportError(exc) || attempts >= this.client._maxRetries) {
          throw mapRpcError(exc, { secrets: this.client._secrets(), sandboxId });
        }
        attempts += 1;
        await sleepWithDeadline(backoff, deadline);
        backoff = Math.min(backoff * 2, 0.5);
      }
    }
  }

  /**
   * Lists sandboxes lazily, paging as the returned async iterator is
   * consumed. `limit: 0` yields nothing without an RPC.
   */
  list(options: ListSandboxesOptions = {}): AsyncIterableIterator<SandboxSummary> {
    const stateValues = normalizeStateFilters(options.states);
    const limit = options.limit;
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 0) {
        throw new InvalidRequestError("limit must be a non-negative integer");
      }
    }
    if (limit === 0) {
      return (async function* empty() {
        // yields nothing
      })();
    }
    return this.listPages(stateValues, limit, options.name ?? "");
  }

  /**
   * Reconnects to an existing sandbox by name.
   *
   * Names are not unique. This resolves the name to a single sandbox and then
   * fetches it by id, and rejects rather than guessing when the name matches
   * more than one: picking one silently would let a later delete destroy an
   * arbitrary sandbox.
   */
  async getByName(name: string): Promise<Sandbox> {
    if (!name) {
      throw new InvalidRequestError("name is required");
    }
    // Two is enough to tell "one match" from "more than one" without paging
    // the whole organization.
    const matches: SandboxSummary[] = [];
    for await (const summary of this.list({ name, limit: 2 })) {
      matches.push(summary);
    }
    const [first, second] = matches;
    if (first === undefined) {
      throw new SandboxNotFoundError(`no sandbox is named ${name}`);
    }
    if (second !== undefined) {
      throw new InvalidRequestError(
        `more than one sandbox is named ${name}, including ${first.id} and ${second.id}; ` +
          "use get() with a sandbox id",
      );
    }
    return this.get(first.id);
  }

  /**
   * Deletes a sandbox by id in a single RPC, without first fetching a
   * handle. Backs the flat Tyto.deleteSandbox; Sandbox.delete() also calls
   * through to this and additionally short-circuits locally when called
   * twice on the same handle -- there is no handle here to remember that,
   * so a second call here always makes a second RPC, and its
   * alreadyDeleted reports what the server observed rather than what this
   * SDK remembers.
   */
  async delete(sandboxId: string): Promise<DeleteResult> {
    if (!sandboxId) {
      throw new InvalidRequestError("sandbox_id is required");
    }
    const request = { apiKey: this.client._apiKey, sandboxId };
    const deadline = Deadline.start(this.client._timeout);
    let attempts = 0;
    let backoff = 0.05;
    for (;;) {
      try {
        const response = await callUnary(this.client._tapiStub().deleteSandbox, request, new grpc.Metadata(), deadline);
        const typed = response as { sandboxId?: string; alreadyDeleted?: boolean };
        return {
          sandboxId: typed.sandboxId || sandboxId,
          alreadyDeleted: Boolean(typed.alreadyDeleted),
        };
      } catch (exc) {
        if (!isRetryableTransportError(exc) || attempts >= this.client._maxRetries) {
          throw mapRpcError(exc, { secrets: this.client._secrets(), sandboxId });
        }
        attempts += 1;
        await sleepWithDeadline(backoff, deadline);
        backoff = Math.min(backoff * 2, 0.5);
      }
    }
  }

  /**
   * Resumes a sandbox by id in a single RPC, without first fetching a
   * handle. Backs the flat Tyto.resumeSandbox; Sandbox.resume() also calls
   * through to the same RPC via resumeRaw(), additionally copying the
   * refreshed capability and exec endpoint onto its own handle, since only
   * a handle has those to update -- ResumeResult itself never carries them.
   */
  async resume(sandboxId: string, options: { idempotencyKey?: string } = {}): Promise<ResumeResult> {
    const [result] = await this.resumeRaw(sandboxId, options);
    return result;
  }

  /**
   * The one ResumeSandbox call site. Returns the raw response alongside the
   * mapped ResumeResult so Sandbox.resume() can read the capability and
   * exec endpoint fields ResumeResult does not expose, without a second
   * implementation of the retry loop.
   */
  async resumeRaw(
    sandboxId: string,
    options: { idempotencyKey?: string } = {},
  ): Promise<
    [
      ResumeResult,
      { sandboxId?: string; lifecycleOperationId?: string; alreadyRunning?: boolean; execCapabilityJws?: string; execEndpoint?: string },
    ]
  > {
    if (!sandboxId) {
      throw new InvalidRequestError("sandbox_id is required");
    }
    const key = options.idempotencyKey ?? randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const request = { apiKey: this.client._apiKey, sandboxId, idempotencyKey: key };
    const deadline = Deadline.start(this.client._timeout);
    let attempts = 0;
    let backoff = 0.05;
    for (;;) {
      try {
        const response = (await callUnary(
          this.client._tapiStub().resumeSandbox,
          request,
          new grpc.Metadata(),
          deadline,
        )) as {
          sandboxId?: string;
          lifecycleOperationId?: string;
          alreadyRunning?: boolean;
          execCapabilityJws?: string;
          execEndpoint?: string;
        };
        const result: ResumeResult = {
          sandboxId: response.sandboxId || sandboxId,
          lifecycleOperationId: response.lifecycleOperationId || "",
          alreadyRunning: Boolean(response.alreadyRunning),
        };
        return [result, response];
      } catch (exc) {
        if (!isRetryableTransportError(exc) || attempts >= this.client._maxRetries) {
          throw mapRpcError(exc, {
            secrets: this.client._secrets(),
            sandboxId,
            idempotencyKey: key,
          });
        }
        attempts += 1;
        await sleepWithDeadline(backoff, deadline);
        backoff = Math.min(backoff * 2, 0.5);
      }
    }
  }

  private async *listPages(
    stateValues: number[],
    limit: number | undefined,
    name: string,
  ): AsyncIterableIterator<SandboxSummary> {
    let yielded = 0;
    let pageToken = "";
    for (;;) {
      const pageSize = limit === undefined ? 0 : Math.min(100, limit - yielded);
      const request = {
        apiKey: this.client._apiKey,
        states: stateValues,
        pageSize,
        pageToken,
        name,
      };
      const deadline = Deadline.start(this.client._timeout);
      let attempts = 0;
      let backoff = 0.05;
      let response: TApiListSandboxesResponse;
      for (;;) {
        try {
          response = await callUnary(this.client._tapiStub().listSandboxes, request, new grpc.Metadata(), deadline);
          break;
        } catch (exc) {
          if (!isRetryableTransportError(exc) || attempts >= this.client._maxRetries) {
            throw mapRpcError(exc, { secrets: this.client._secrets(pageToken) });
          }
          attempts += 1;
          await sleepWithDeadline(backoff, deadline);
          backoff = Math.min(backoff * 2, 0.5);
        }
      }
      for (const sandbox of response.sandboxes ?? []) {
        if (limit !== undefined && yielded >= limit) {
          return;
        }
        yield summaryFromMetadata(sandbox);
        yielded += 1;
      }
      pageToken = response.nextPageToken ?? "";
      if (!pageToken || (limit !== undefined && yielded >= limit)) {
        return;
      }
    }
  }
}

function resolveOrganizationId(organizationId: string | undefined): string | undefined {
  const value = organizationId !== undefined ? organizationId : process.env["BONYA_ORGANIZATION_ID"];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidRequestError("organization_id must be a non-empty string");
  }
  return value.trim();
}

function normalizeWait(wait: WaitInput): Wait {
  const value: string = wait;
  if (value === "ready") {
    return Wait.READY;
  }
  if (value === "none") {
    return Wait.NONE;
  }
  throw new InvalidRequestError("wait must be 'ready' or 'none'");
}

function normalizeStateFilters(states: Iterable<Status> | undefined): number[] {
  if (states === undefined) {
    return [];
  }
  const values: number[] = [];
  for (const state of states) {
    if (state === Status.DELETED) {
      throw new InvalidRequestError("Status.DELETED is not a valid list filter");
    }
    values.push(statusToTerminalState(state));
  }
  return values;
}

function sandboxFromCreate(client: Tyto, response: TApiServiceCreateResponse, wait: Wait, key: string): Sandbox {
  const execEndpoint = response.execEndpoint ?? "";
  const capability = response.execCapabilityJws ?? "";
  const sandboxId = response.sandboxId ?? "";
  const operationId = response.operationId ?? "";
  if (!sandboxId || !operationId) {
    throw new InvalidRequestError("Create response is missing sandbox identity", { idempotencyKey: key });
  }
  if (!execEndpoint) {
    throw new InvalidRequestError("Create response is missing exec_endpoint", {
      sandboxId,
      operationId,
      idempotencyKey: key,
    });
  }
  if (!capability) {
    throw new InvalidRequestError("Create response is missing exec capability", {
      sandboxId,
      operationId,
      idempotencyKey: key,
    });
  }
  const terminal = response.terminal;
  if (terminal && terminal.state === TerminalState.TERMINAL_STATE_FAILED) {
    throw new SandboxCreationFailedError(terminal.message || "sandbox creation failed", {
      sandboxId,
      operationId,
      idempotencyKey: key,
    });
  }
  return new Sandbox({
    client,
    sandboxId,
    operationId,
    template: response.resolvedTemplateId ?? "",
    version: response.resolvedTemplateVersion ?? "",
    status: wait === Wait.READY ? Status.RUNNING : Status.CREATING,
    execEndpoint,
    capability,
    name: response.name ?? "",
  });
}

function sandboxFromGet(client: Tyto, response: TApiGetSandboxResponse, requestedSandboxId: string): Sandbox {
  const metadata = response.sandbox;
  if (!metadata) {
    throw new InvalidRequestError("GetSandbox response is missing sandbox metadata", {
      sandboxId: requestedSandboxId,
    });
  }
  const sandboxId = metadata.sandboxId ?? "";
  const operationId = metadata.operationId ?? "";
  if (!sandboxId || !operationId) {
    throw new InvalidRequestError("GetSandbox response is missing sandbox identity", {
      sandboxId: requestedSandboxId,
    });
  }
  const status = statusFromMetadata(metadata);
  const execEndpoint = response.execEndpoint ?? "";
  const capability = response.execCapabilityJws ?? "";
  if (status === Status.FAILED) {
    return new Sandbox({
      client,
      sandboxId,
      operationId,
      template: metadata.resolvedTemplateId ?? "",
      version: metadata.resolvedTemplateVersion ?? "",
      status,
      execEndpoint: "",
      capability: "",
      failureCode: failureCode(metadata),
      failureMessage: failureMessage(metadata),
      name: metadata.name ?? "",
    });
  }
  if (!execEndpoint) {
    throw new InvalidRequestError("GetSandbox response is missing exec_endpoint", { sandboxId, operationId });
  }
  if (!capability) {
    throw new InvalidRequestError("GetSandbox response is missing exec capability", { sandboxId, operationId });
  }
  return new Sandbox({
    client,
    sandboxId,
    operationId,
    template: metadata.resolvedTemplateId ?? "",
    version: metadata.resolvedTemplateVersion ?? "",
    status,
    execEndpoint,
    capability,
    name: metadata.name ?? "",
  });
}

function summaryFromMetadata(metadata: TApiSandboxMetadata): SandboxSummary {
  return {
    id: metadata.sandboxId ?? "",
    operationId: metadata.operationId ?? "",
    template: metadata.resolvedTemplateId ?? "",
    version: metadata.resolvedTemplateVersion ?? "",
    lastObservedStatus: statusFromMetadata(metadata),
    failureCode: failureCode(metadata),
    failureMessage: failureMessage(metadata),
    name: metadata.name ?? "",
  };
}

function statusFromMetadata(metadata: TApiSandboxMetadata): Status {
  const observed = metadata.observed;
  const state = observed?.state ?? TerminalState.TERMINAL_STATE_UNSPECIFIED;
  return terminalStateToStatus(state);
}

function failureCode(metadata: TApiSandboxMetadata): string | undefined {
  return metadata.observed?.code || undefined;
}

function failureMessage(metadata: TApiSandboxMetadata): string | undefined {
  return metadata.observed?.message || undefined;
}

function terminalStateToStatus(state: TerminalState): Status {
  switch (state) {
    case TerminalState.TERMINAL_STATE_CREATING:
      return Status.CREATING;
    case TerminalState.TERMINAL_STATE_RUNNING:
      return Status.RUNNING;
    case TerminalState.TERMINAL_STATE_SUSPENDING:
      return Status.SUSPENDING;
    case TerminalState.TERMINAL_STATE_SUSPENDED:
      return Status.SUSPENDED;
    case TerminalState.TERMINAL_STATE_RESUMING:
      return Status.RESUMING;
    case TerminalState.TERMINAL_STATE_FAILED:
      return Status.FAILED;
    case TerminalState.TERMINAL_STATE_DELETED:
      return Status.DELETED;
    default:
      throw new InvalidRequestError("sandbox metadata contained an unsupported state");
  }
}

function statusToTerminalState(status: Status): TerminalState {
  switch (status) {
    case Status.CREATING:
      return TerminalState.TERMINAL_STATE_CREATING;
    case Status.RUNNING:
      return TerminalState.TERMINAL_STATE_RUNNING;
    case Status.SUSPENDING:
      return TerminalState.TERMINAL_STATE_SUSPENDING;
    case Status.SUSPENDED:
      return TerminalState.TERMINAL_STATE_SUSPENDED;
    case Status.RESUMING:
      return TerminalState.TERMINAL_STATE_RESUMING;
    case Status.FAILED:
      return TerminalState.TERMINAL_STATE_FAILED;
    default:
      throw new InvalidRequestError("unsupported status filter");
  }
}
