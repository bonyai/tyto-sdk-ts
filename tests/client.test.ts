import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as grpc from "@grpc/grpc-js";

import { Tyto } from "../src/client.js";
import { InvalidRequestError, SandboxNotFoundError } from "../src/errors.js";
import { Status } from "../src/types.js";
import { Wait } from "../src/types.js";
import { FakeGuest, makeClient, makeFakeTransport, RpcFailure } from "./fakes.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env["BONYA_API_KEY"] = "secret-api";
  delete process.env["BONYA_ENDPOINT"];
  delete process.env["BONYA_ORGANIZATION_ID"];
  delete process.env["BONYA_CA_BUNDLE"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("Tyto configuration", () => {
  it("requires an api key", () => {
    delete process.env["BONYA_API_KEY"];
    expect(() => new Tyto({ endpoint: "https://api.example.test" })).toThrow(InvalidRequestError);
  });

  it("falls back to environment variables", () => {
    process.env["BONYA_ENDPOINT"] = "https://env.example.test";
    const transport = makeFakeTransport();
    const client = new Tyto({ _channelFactory: transport.channelFactory, _tapiStubFactory: transport.tapiStubFactory });
    expect(client.sandboxes).toBeDefined();
    client.close();
  });

  it("rejects non-https, userinfo, query, and malformed-port endpoints", () => {
    expect(() => new Tyto({ apiKey: "k", endpoint: "http://example.test" })).toThrow(InvalidRequestError);
    expect(() => new Tyto({ apiKey: "k", endpoint: "https://u:p@example.test" })).toThrow(InvalidRequestError);
    expect(() => new Tyto({ apiKey: "k", endpoint: "https://example.test/path?q=1" })).toThrow(InvalidRequestError);
    expect(() => new Tyto({ apiKey: "k", endpoint: "https://example.test:bad" })).toThrow(InvalidRequestError);
  });

  it("requires a positive timeout and non-negative retries/read limit", () => {
    expect(() => new Tyto({ apiKey: "k", endpoint: "https://example.test", timeout: 0 })).toThrow(InvalidRequestError);
    expect(() => new Tyto({ apiKey: "k", endpoint: "https://example.test", maxRetries: -1 })).toThrow(InvalidRequestError);
    expect(() => new Tyto({ apiKey: "k", endpoint: "https://example.test", filesystemReadLimit: -1 })).toThrow(
      InvalidRequestError,
    );
  });

  it("rejects a blank organization_id from argument or environment", () => {
    for (const blank of ["", "   ", "\t"]) {
      expect(() => new Tyto({ apiKey: "k", endpoint: "https://example.test", organizationId: blank })).toThrow(
        InvalidRequestError,
      );
      process.env["BONYA_ORGANIZATION_ID"] = blank;
      expect(() => new Tyto({ apiKey: "k", endpoint: "https://example.test" })).toThrow(InvalidRequestError);
      delete process.env["BONYA_ORGANIZATION_ID"];
    }
  });

  it("trims organization_id without shape checking, argument wins over env", () => {
    const client = new Tyto({ apiKey: "k", endpoint: "https://example.test", organizationId: "  org-padded  " });
    expect(client.organizationId).toBe("org-padded");
    client.close();

    process.env["BONYA_ORGANIZATION_ID"] = "org-from-env";
    const envClient = new Tyto({ apiKey: "k", endpoint: "https://example.test" });
    expect(envClient.organizationId).toBe("org-from-env");
    envClient.close();

    const explicit = new Tyto({ apiKey: "k", endpoint: "https://example.test", organizationId: "org-explicit" });
    expect(explicit.organizationId).toBe("org-explicit");
    explicit.close();
  });
});

describe("SandboxCollection.create", () => {
  it("maps the response, retries on UNAVAILABLE with the same request, and pools channels", async () => {
    const transport = makeFakeTransport();
    transport.tapi.createErrors.push(new RpcFailure(grpc.status.UNAVAILABLE, "try again"));
    const client = makeClient(transport);

    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04", wait: Wait.NONE, idempotencyKey: "idem-1" });

    expect(sandbox.id).toBe("sbx-1");
    expect(sandbox.lastObservedStatus).toBe(Status.CREATING);
    expect(transport.tapi.createRequests).toHaveLength(2);
    expect(transport.tapi.createRequests[0]).toEqual(transport.tapi.createRequests[1]);
    const request = transport.tapi.createRequests[0] as any;
    expect(request.apiKey).toBe("secret-api");
    expect(request.idempotencyKey).toBe("idem-1");
    expect(request.template.templateId).toBe("ubuntu-24.04");

    const result = await sandbox.exec("printf ready");
    expect(result.stdout).toBe("ready");
    expect(transport.guest.calls).toBe(1);
    expect(transport.channels.map((c) => c.endpoint)).toEqual([
      "https://api.example.test",
      "https://exec.example.test/edge",
    ]);
    client.close();
    expect(transport.channels.every((c) => c.closed)).toBe(true);
  });

  it("requires a non-empty template", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    await expect(client.sandboxes.create({ template: "" })).rejects.toThrow(InvalidRequestError);
  });

  it("rejects a response missing exec_endpoint", async () => {
    const transport = makeFakeTransport();
    transport.tapi.create = (request, _metadata, callback) => {
      transport.tapi.createRequests.push(request);
      callback(null, { operationId: "op", sandboxId: "sbx", execCapabilityJws: "cap" });
      return new EventEmitter() as unknown as grpc.ClientUnaryCall;
    };
    const client = makeClient(transport);
    await expect(client.sandboxes.create({ template: "ubuntu-24.04", idempotencyKey: "idem" })).rejects.toThrow(
      InvalidRequestError,
    );
  });
});

describe("SandboxCollection.get", () => {
  it("returns a usable sandbox without resuming", async () => {
    const transport = makeFakeTransport();
    transport.tapi.sourceStatuses["sbx-1"] = Status.SUSPENDED;
    const client = makeClient(transport);

    const sandbox = await client.sandboxes.get("sbx-1");

    expect(sandbox.id).toBe("sbx-1");
    expect(sandbox.lastObservedStatus).toBe(Status.SUSPENDED);
    expect(transport.tapi.getRequests).toHaveLength(1);
    expect(transport.tapi.resumeRequests).toHaveLength(0);
    const result = await sandbox.exec(["printf", "ready"]);
    expect(result.stdout).toBe("ready");
  });

  it("maps missing, deleted, and cross-tenant sandboxes to not-found", async () => {
    const transport = makeFakeTransport();
    transport.tapi.sourceTenants["deleted"] = "tenant-a";
    transport.tapi.sourceStatuses["deleted"] = Status.DELETED;
    transport.tapi.sourceTenants["cross-tenant"] = "tenant-b";
    transport.tapi.sourceStatuses["cross-tenant"] = Status.RUNNING;
    const client = makeClient(transport);

    for (const id of ["missing", "deleted", "cross-tenant"]) {
      await expect(client.sandboxes.get(id)).rejects.toThrow(SandboxNotFoundError);
    }
  });

  it("requires a non-empty sandbox id", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    await expect(client.sandboxes.get("")).rejects.toThrow(InvalidRequestError);
  });

  it("retries GetSandbox on UNAVAILABLE", async () => {
    const transport = makeFakeTransport();
    transport.tapi.getErrors.push(new RpcFailure(grpc.status.UNAVAILABLE, "try again"));
    const client = makeClient(transport);

    const sandbox = await client.sandboxes.get("sbx-1");
    expect(sandbox.id).toBe("sbx-1");
    expect(transport.tapi.getRequests).toHaveLength(2);
  });
});

describe("SandboxCollection.list", () => {
  it("is lazy, paginates, and honors a total limit", async () => {
    const transport = makeFakeTransport();
    transport.tapi.listPages = [
      {
        sandboxes: [
          { sandboxId: "sbx-3", operationId: "op-sbx-3", resolvedTemplateId: "ubuntu-24.04", resolvedTemplateVersion: "dev", observed: { state: 5, code: "", message: "" } },
          { sandboxId: "sbx-2", operationId: "op-sbx-2", resolvedTemplateId: "ubuntu-24.04", resolvedTemplateVersion: "dev", observed: { state: 7, code: "", message: "" } },
        ],
        nextPageToken: "secret-token",
      },
      {
        sandboxes: [
          { sandboxId: "sbx-1", operationId: "op-sbx-1", resolvedTemplateId: "ubuntu-24.04", resolvedTemplateVersion: "dev", observed: { state: 2, code: "create_failed", message: "disk full" } },
        ],
        nextPageToken: "",
      },
    ];
    const client = makeClient(transport);

    const iterator = client.sandboxes.list({ limit: 3 });
    expect(transport.tapi.listRequests).toHaveLength(0);

    const summaries = [];
    for await (const summary of iterator) {
      summaries.push(summary);
    }

    expect(summaries.map((s) => s.id)).toEqual(["sbx-3", "sbx-2", "sbx-1"]);
    expect(summaries[2]).toMatchObject({
      id: "sbx-1",
      lastObservedStatus: Status.FAILED,
      failureCode: "create_failed",
      failureMessage: "disk full",
    });
    expect(transport.tapi.listRequests).toHaveLength(2);
    expect((transport.tapi.listRequests[0] as any).pageSize).toBe(3);
    expect((transport.tapi.listRequests[1] as any).pageToken).toBe("secret-token");
  });

  it("limit 0 yields nothing without an RPC", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    const results = [];
    for await (const summary of client.sandboxes.list({ limit: 0 })) {
      results.push(summary);
    }
    expect(results).toHaveLength(0);
    expect(transport.tapi.listRequests).toHaveLength(0);
  });

  it("rejects Status.DELETED as a filter and a negative limit", () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    expect(() => client.sandboxes.list({ states: [Status.DELETED] })).toThrow(InvalidRequestError);
    expect(() => client.sandboxes.list({ limit: -1 })).toThrow(InvalidRequestError);
  });
});

describe("exec never retries and redacts the capability", () => {
  it("propagates CapabilityRejectedError without retry and redacts secrets", async () => {
    const transport = makeFakeTransport();
    transport.guest.fail = true;
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await expect(sandbox.exec(["false"])).rejects.toThrow();
    expect(transport.guest.calls).toBe(1);
  });
});
