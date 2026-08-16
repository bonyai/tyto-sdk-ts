import { EventEmitter } from "node:events";
import * as grpc from "@grpc/grpc-js";

import { Tyto, type TytoOptions } from "../src/client.js";
import { Status } from "../src/types.js";
import { TerminalState } from "../src/proto/tyto/runtime/v1/tapi.js";
import { PreviewAuthMode } from "../src/proto/tyto/runtime/v1/preview.js";

/** A gRPC-shaped error usable as the `error` argument of any fake callback. */
export class RpcFailure extends Error implements grpc.ServiceError {
  code: grpc.status;
  details: string;
  metadata: grpc.Metadata;

  constructor(code: grpc.status, details = "failed") {
    super(details);
    this.code = code;
    this.details = details;
    this.metadata = new grpc.Metadata();
  }
}

export function statusToTerminalState(status: Status): TerminalState {
  const mapping: Record<Status, TerminalState> = {
    [Status.CREATING]: TerminalState.TERMINAL_STATE_CREATING,
    [Status.RUNNING]: TerminalState.TERMINAL_STATE_RUNNING,
    [Status.SUSPENDING]: TerminalState.TERMINAL_STATE_SUSPENDING,
    [Status.SUSPENDED]: TerminalState.TERMINAL_STATE_SUSPENDED,
    [Status.RESUMING]: TerminalState.TERMINAL_STATE_RESUMING,
    [Status.FAILED]: TerminalState.TERMINAL_STATE_FAILED,
    [Status.DELETED]: TerminalState.TERMINAL_STATE_DELETED,
  };
  return mapping[status];
}

export function makeMetadata(
  sandboxId: string,
  options: { operationId?: string; status?: Status; code?: string; message?: string; name?: string } = {},
) {
  return {
    sandboxId,
    operationId: options.operationId ?? `op-${sandboxId}`,
    resolvedTemplateId: "ubuntu-24.04",
    resolvedTemplateVersion: "dev",
    observed: {
      state: statusToTerminalState(options.status ?? Status.RUNNING),
      code: options.code ?? "",
      message: options.message ?? "",
    },
    name: options.name ?? "",
  };
}

type UnaryCallback<Res> = (error: grpc.ServiceError | null, response?: Res) => void;
type UnaryMethod<Req, Res> = (request: Req, metadata: grpc.Metadata, callback: UnaryCallback<Res>) => grpc.ClientUnaryCall;

function queue<T>(): { items: T[]; push: (item: T) => void; shift: () => T | undefined; isEmpty: () => boolean } {
  const items: T[] = [];
  return {
    items,
    push: (item: T) => items.push(item),
    shift: () => items.shift(),
    isEmpty: () => items.length === 0,
  };
}

export class FakeTapi {
  createErrors = queue<grpc.ServiceError>();
  deleteErrors = queue<grpc.ServiceError>();
  getErrors = queue<grpc.ServiceError>();
  listErrors = queue<grpc.ServiceError>();
  resumeErrors = queue<grpc.ServiceError>();
  snapshotCreateErrors = queue<grpc.ServiceError>();
  snapshotDeleteErrors = queue<grpc.ServiceError>();
  reissueErrors = queue<grpc.ServiceError>();
  previewCreateErrors = queue<grpc.ServiceError>();
  previewDeleteErrors = queue<grpc.ServiceError>();
  previewListErrors = queue<grpc.ServiceError>();
  listOrganizationsErrors = queue<grpc.ServiceError>();

  createRequests: unknown[] = [];
  deleteRequests: unknown[] = [];
  getRequests: unknown[] = [];
  listRequests: unknown[] = [];
  resumeRequests: unknown[] = [];
  snapshotCreateRequests: unknown[] = [];
  snapshotDeleteRequests: unknown[] = [];
  reissueRequests: unknown[] = [];
  previewCreateRequests: any[] = [];
  previewDeleteRequests: any[] = [];
  previewListRequests: any[] = [];
  listOrganizationsRequests: any[] = [];

  sourceTenants: Record<string, string> = { "sbx-1": "tenant-a" };
  sourceStatuses: Record<string, Status> = { "sbx-1": Status.RUNNING };
  apiKeyTenants: Record<string, string> = { "secret-api": "tenant-a" };
  getCapability = "fresh-get-cap";
  getEndpoint = "https://exec.example.test/edge";
  reissueCapabilityValue = "fresh-reissue-cap";
  listPages: any[] = [];
  snapshots: Record<string, string> = {};
  previewDomain = ".preview.example.test";
  previewCapabilityValue = "fresh-preview-cap";
  previews: Record<string, any> = {};
  nextPreviewId = "pv-aaaaaaaaaaaaaaaaaaaaaaaaaa";
  /**
   * Stands in for the name the service generates when a create request
   * leaves the name blank.
   */
  generatedName = "brave-cedar-6268";

  private failCode: grpc.status | undefined;

  create: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.createRequests.push(request);
    const error = this.createErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    callback(null, {
      operationId: "op-1",
      sandboxId: "sbx-1",
      execCapabilityJws: "secret-cap",
      execEndpoint: "https://exec.example.test/edge",
      resolvedTemplateId: "ubuntu-24.04",
      resolvedTemplateVersion: "dev",
      name: request.name || this.generatedName,
    });
    return fakeCall();
  };

  deleteSandbox: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.deleteRequests.push(request);
    const error = this.deleteErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    this.sourceStatuses[request.sandboxId] = Status.DELETED;
    callback(null, { sandboxId: request.sandboxId, alreadyDeleted: false });
    return fakeCall();
  };

  getSandbox: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.getRequests.push(request);
    const error = this.getErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    const tenant = this.apiKeyTenants[request.apiKey];
    if (tenant === undefined) {
      callback(new RpcFailure(grpc.status.UNAUTHENTICATED, "bad api key"));
      return fakeCall();
    }
    if (this.sourceTenants[request.sandboxId] !== tenant) {
      callback(new RpcFailure(grpc.status.NOT_FOUND, "sandbox missing"));
      return fakeCall();
    }
    const status = this.sourceStatuses[request.sandboxId] ?? Status.RUNNING;
    if (status === Status.DELETED) {
      callback(new RpcFailure(grpc.status.NOT_FOUND, "sandbox missing"));
      return fakeCall();
    }
    const response: any = { sandbox: makeMetadata(request.sandboxId, { status }) };
    if (status !== Status.FAILED) {
      response.execCapabilityJws = this.getCapability;
      response.execEndpoint = this.getEndpoint;
    }
    callback(null, response);
    return fakeCall();
  };

  listSandboxes: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.listRequests.push(request);
    const error = this.listErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    if (this.listPages.length > 0) {
      callback(null, this.listPages.shift());
      return fakeCall();
    }
    callback(null, {
      sandboxes: Object.entries(this.sourceStatuses)
        .filter(([, status]) => status !== Status.DELETED)
        .map(([sandboxId, status]) => makeMetadata(sandboxId, { status })),
      nextPageToken: "",
    });
    return fakeCall();
  };

  resumeSandbox: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.resumeRequests.push(request);
    const error = this.resumeErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    callback(null, {
      sandboxId: request.sandboxId,
      lifecycleOperationId: "lco-resume",
      alreadyRunning: false,
      execCapabilityJws: "fresh-cap",
      execEndpoint: "https://exec.example.test/edge",
    });
    return fakeCall();
  };

  createSnapshot: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.snapshotCreateRequests.push(request);
    const error = this.snapshotCreateErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    const tenant = this.apiKeyTenants[request.apiKey];
    if (tenant === undefined) {
      callback(new RpcFailure(grpc.status.UNAUTHENTICATED, "bad api key"));
      return fakeCall();
    }
    if (this.sourceTenants[request.sandboxId] !== tenant) {
      callback(new RpcFailure(grpc.status.NOT_FOUND, "sandbox missing"));
      return fakeCall();
    }
    const status = this.sourceStatuses[request.sandboxId];
    if (status === Status.DELETED) {
      callback(new RpcFailure(grpc.status.FAILED_PRECONDITION, "sandbox_deleted"));
      return fakeCall();
    }
    if (status === Status.SUSPENDED) {
      callback(new RpcFailure(grpc.status.FAILED_PRECONDITION, "sandbox_suspended"));
      return fakeCall();
    }
    if (status !== Status.RUNNING) {
      callback(new RpcFailure(grpc.status.FAILED_PRECONDITION, "sandbox_failed"));
      return fakeCall();
    }
    const digest = simpleHash(`${tenant}\0${request.sandboxId}\0${request.idempotencyKey}`);
    const snapshotId = `snp-${digest}`;
    this.snapshots[snapshotId] = tenant;
    callback(null, { snapshotId, sourceSandboxId: request.sandboxId, alreadyCreated: false });
    return fakeCall();
  };

  deleteSnapshot: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.snapshotDeleteRequests.push(request);
    const error = this.snapshotDeleteErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    const tenant = this.apiKeyTenants[request.apiKey];
    if (tenant !== undefined && this.snapshots[request.snapshotId] === tenant) {
      delete this.snapshots[request.snapshotId];
    }
    callback(null, { snapshotId: request.snapshotId });
    return fakeCall();
  };

  reissueCapability: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.reissueRequests.push(request);
    const error = this.reissueErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    const tenant = this.apiKeyTenants[request.apiKey];
    if (tenant === undefined) {
      callback(new RpcFailure(grpc.status.UNAUTHENTICATED, "bad api key"));
      return fakeCall();
    }
    if (this.sourceTenants[request.sandboxId] !== tenant) {
      callback(new RpcFailure(grpc.status.NOT_FOUND, "sandbox not found"));
      return fakeCall();
    }
    if (this.sourceStatuses[request.sandboxId] === Status.DELETED) {
      callback(new RpcFailure(grpc.status.FAILED_PRECONDITION, "sandbox_deleted"));
      return fakeCall();
    }
    callback(null, { capabilityJws: this.reissueCapabilityValue, expiresAtUnixNanos: 1 });
    return fakeCall();
  };

  private previewTenant(request: any): string {
    const tenant = this.apiKeyTenants[request.apiKey];
    if (tenant === undefined) {
      throw new RpcFailure(grpc.status.UNAUTHENTICATED, "bad api key");
    }
    if (this.sourceTenants[request.sandboxId] !== tenant) {
      throw new RpcFailure(grpc.status.NOT_FOUND, "sandbox not found");
    }
    return tenant;
  }

  private previewInfo(record: any) {
    return { record, url: `https://${record.previewId}${this.previewDomain}` };
  }

  createPreview: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.previewCreateRequests.push(request);
    const error = this.previewCreateErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    try {
      this.previewTenant(request);
    } catch (error) {
      callback(error as grpc.ServiceError);
      return fakeCall();
    }
    let mode = request.authMode;
    if (mode === PreviewAuthMode.PREVIEW_AUTH_MODE_UNSPECIFIED || mode === undefined) {
      mode = PreviewAuthMode.PREVIEW_AUTH_MODE_TOKEN;
    }
    const record = {
      previewId: this.nextPreviewId,
      sandboxId: request.sandboxId,
      port: request.port,
      authMode: mode,
      name: request.name,
      createdAtUnixNanos: 1_700_000_000_000_000_000,
    };
    this.previews[record.previewId] = record;
    callback(null, { preview: this.previewInfo(record), capabilityJws: this.previewCapabilityValue });
    return fakeCall();
  };

  deletePreview: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.previewDeleteRequests.push(request);
    const error = this.previewDeleteErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    try {
      this.previewTenant(request);
    } catch (error) {
      callback(error as grpc.ServiceError);
      return fakeCall();
    }
    const existed = this.previews[request.previewId] !== undefined;
    delete this.previews[request.previewId];
    callback(null, { previewId: request.previewId, alreadyDeleted: !existed });
    return fakeCall();
  };

  listPreviews: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.previewListRequests.push(request);
    const error = this.previewListErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    try {
      this.previewTenant(request);
    } catch (error) {
      callback(error as grpc.ServiceError);
      return fakeCall();
    }
    callback(null, { previews: Object.values(this.previews).map((record) => this.previewInfo(record)) });
    return fakeCall();
  };

  /**
   * None means listOrganizations returns its single-personal-org default;
   * set to override with a specific list, including empty.
   */
  organizations: any[] | undefined;

  listOrganizations: UnaryMethod<any, any> = (request, _metadata, callback) => {
    this.listOrganizationsRequests.push(request);
    const error = this.listOrganizationsErrors.shift();
    if (error) {
      callback(error);
      return fakeCall();
    }
    const organizations = this.organizations ?? [
      { organizationId: "org-personal", name: "personal", personal: true, role: "owner", createdAtUnixNanos: 1 },
    ];
    callback(null, { organizations });
    return fakeCall();
  };
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(24, "0").slice(0, 24);
}

function fakeCall(): grpc.ClientUnaryCall {
  return new EventEmitter() as unknown as grpc.ClientUnaryCall;
}

/** A fake duplex Exec stream driven by a scripted response list, or a custom behavior. */
export class FakeExecStream extends EventEmitter {
  written: any[] = [];
  ended = false;
  cancelled = false;

  private responded = false;

  constructor(private responses: any[] = []) {
    super();
  }

  write(chunk: any): boolean {
    this.written.push(chunk);
    // A real server starts responding once it sees the start frame; it does
    // not wait for the client to half-close or end the request stream.
    if (chunk.start && !this.responded) {
      this.responded = true;
      queueMicrotask(() => this.emitResponses());
    }
    return true;
  }

  end(): void {
    this.ended = true;
  }

  cancel(): void {
    this.cancelled = true;
  }

  private emitResponses(): void {
    for (const response of this.responses) {
      this.emit("data", response);
    }
    this.emit("end");
  }
}

export class FailingExecStream extends EventEmitter {
  written: any[] = [];
  cancelled = false;
  constructor(private error: grpc.ServiceError) {
    super();
    queueMicrotask(() => this.emit("error", this.error));
  }
  write(chunk: any): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): void {}
  cancel(): void {
    this.cancelled = true;
  }
}

export class FakeGuest {
  calls = 0;
  fail = false;
  failure: grpc.ServiceError | undefined;
  lastStream: FakeExecStream | undefined;
  lastMetadata: grpc.Metadata | undefined;
  execImpl: ((metadata: grpc.Metadata) => any) | undefined;

  exec = (metadata: grpc.Metadata): any => {
    this.calls += 1;
    this.lastMetadata = metadata;
    if (this.execImpl) {
      return this.execImpl(metadata);
    }
    if (this.fail) {
      return new FailingExecStream(this.failure ?? new RpcFailure(grpc.status.PERMISSION_DENIED, "exec capability rejected secret-cap"));
    }
    this.lastStream = new FakeExecStream([
      { stdout: { data: Buffer.from("ready") } },
      { stderr: { data: Buffer.from([0x77, 0x61, 0x72, 0x6e, 0xff]) } },
      { exit: { exitCode: 0, signaled: false, signal: 0 } },
    ]);
    return this.lastStream;
  };
}

export interface FakeTransport {
  channels: Array<{ endpoint: string; closed: boolean }>;
  tapi: FakeTapi;
  guest: FakeGuest;
  channelFactory: TytoOptions["_channelFactory"];
  tapiStubFactory: TytoOptions["_tapiStubFactory"];
  guestStubFactory: TytoOptions["_guestStubFactory"];
}

export function makeFakeTransport(): FakeTransport {
  const channels: Array<{ endpoint: string; closed: boolean }> = [];
  const tapi = new FakeTapi();
  const guest = new FakeGuest();
  return {
    channels,
    tapi,
    guest,
    channelFactory: (endpoint) => {
      const channel = { endpoint: endpoint.url, closed: false };
      channels.push(channel);
      return { close: () => (channel.closed = true) };
    },
    tapiStubFactory: () => tapi as unknown as any,
    guestStubFactory: () => guest as unknown as any,
  };
}

export function makeClient(transport: FakeTransport, options: Partial<TytoOptions> = {}): Tyto {
  return new Tyto({
    apiKey: "secret-api",
    endpoint: "https://api.example.test/",
    timeout: 2,
    maxRetries: 2,
    _channelFactory: transport.channelFactory,
    _tapiStubFactory: transport.tapiStubFactory,
    _guestStubFactory: transport.guestStubFactory,
    ...options,
  });
}
