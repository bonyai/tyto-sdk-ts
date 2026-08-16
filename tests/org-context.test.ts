import * as grpc from "@grpc/grpc-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ORGANIZATION_METADATA_KEY } from "../src/client.js";
import { Wait } from "../src/types.js";
import { makeClient, makeFakeTransport, RpcFailure } from "./fakes.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env["BONYA_API_KEY"] = "secret-api";
  delete process.env["BONYA_ORGANIZATION_ID"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** Wraps FakeTapi's methods to record the metadata object each call received. */
function recordMetadata(tapi: ReturnType<typeof makeFakeTransport>["tapi"]): Map<string, grpc.Metadata | undefined> {
  const recorded = new Map<string, grpc.Metadata | undefined>();
  const methodNames = [
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
  for (const name of methodNames) {
    const original = (tapi as unknown as Record<string, Function>)[name] as Function;
    (tapi as unknown as Record<string, Function>)[name] = (request: unknown, metadata: grpc.Metadata, callback: unknown) => {
      recorded.set(name, metadata);
      return original.call(tapi, request, metadata, callback);
    };
  }
  return recorded;
}

const EVERY_TAPI_RPC = [
  "create",
  "getSandbox",
  "listSandboxes",
  "createPreview",
  "listPreviews",
  "deletePreview",
  "createSnapshot",
  "deleteSnapshot",
  "reissueCapability",
  "resumeSandbox",
  "deleteSandbox",
  "listOrganizations",
].sort();

async function driveEveryTapiRpc(client: ReturnType<typeof makeClient>): Promise<void> {
  const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04", wait: Wait.NONE, idempotencyKey: "idem-1" });
  await client.sandboxes.get("sbx-1");
  for await (const _ of client.sandboxes.list()) {
    // drain
  }
  await sandbox.previews.create(3000, { name: "web" });
  await sandbox.previews.list();
  await sandbox.previews.delete("pv-aaaaaaaaaaaaaaaaaaaaaaaaaa");
  const snapshot = await sandbox.snapshot({ idempotencyKey: "idem-snap" });
  await snapshot.delete();
  await sandbox.reissueCapability();
  await sandbox.resume({ idempotencyKey: "idem-resume" });
  await sandbox.delete();
  await client.listOrganizations();
}

describe("organization context", () => {
  it("reaches every TApi RPC when configured", async () => {
    const transport = makeFakeTransport();
    const recorded = recordMetadata(transport.tapi);
    const client = makeClient(transport, { organizationId: "org-1111" });

    await driveEveryTapiRpc(client);

    expect([...recorded.keys()].sort()).toEqual(EVERY_TAPI_RPC);
    for (const [method, metadata] of recorded) {
      expect(metadata, `${method} sent no metadata`).toBeDefined();
      expect(metadata!.get(ORGANIZATION_METADATA_KEY)).toEqual(["org-1111"]);
    }
  });

  it("sends no organization metadata at all when unconfigured", async () => {
    const transport = makeFakeTransport();
    const recorded = recordMetadata(transport.tapi);
    const client = makeClient(transport, { organizationId: undefined });
    expect(client.organizationId).toBeUndefined();

    await driveEveryTapiRpc(client);

    expect([...recorded.keys()].sort()).toEqual(EVERY_TAPI_RPC);
    for (const [method, metadata] of recorded) {
      // Metadata objects are always passed (grpc-js requires one), but an
      // unconfigured client must never add the organization key to it.
      expect(metadata!.get(ORGANIZATION_METADATA_KEY), method).toEqual([]);
    }
  });

  it("never reaches guest RPCs, and leaves capability metadata untouched", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport, { organizationId: "org-2222" });
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04", wait: Wait.NONE });

    await sandbox.exec(["true"]);

    const guestMetadata = transport.guest.lastMetadata!;
    expect(guestMetadata.get(ORGANIZATION_METADATA_KEY)).toEqual([]);
    expect(guestMetadata.get("bonya-sandbox-id")).toEqual(["sbx-1"]);
    expect(guestMetadata.get("bonya-exec-capability").length).toBeGreaterThan(0);
  });

  it("falls back to the environment, and an explicit argument wins", async () => {
    const transport = makeFakeTransport();
    const recorded = recordMetadata(transport.tapi);
    process.env["BONYA_ORGANIZATION_ID"] = "org-from-env";
    const client = makeClient(transport, { organizationId: undefined });
    expect(client.organizationId).toBe("org-from-env");

    await client.sandboxes.get("sbx-1");
    expect(recorded.get("getSandbox")!.get(ORGANIZATION_METADATA_KEY)).toEqual(["org-from-env"]);

    const explicit = makeClient(transport, { organizationId: "org-explicit" });
    expect(explicit.organizationId).toBe("org-explicit");
  });

  it("survives a retried RPC", async () => {
    const transport = makeFakeTransport();
    const recorded = recordMetadata(transport.tapi);
    const client = makeClient(transport, { organizationId: "org-3333" });
    transport.tapi.getErrors.push(new RpcFailure(grpc.status.UNAVAILABLE, "try again"));

    await client.sandboxes.get("sbx-1");

    expect(recorded.get("getSandbox")!.get(ORGANIZATION_METADATA_KEY)).toEqual(["org-3333"]);
  });

  it("setter affects the next call, including for a client that already made calls", async () => {
    const transport = makeFakeTransport();
    const recorded = recordMetadata(transport.tapi);
    const client = makeClient(transport, { organizationId: "org-before" });

    await client.sandboxes.get("sbx-1");
    expect(recorded.get("getSandbox")!.get(ORGANIZATION_METADATA_KEY)).toEqual(["org-before"]);

    client.organizationId = "org-after";
    expect(client.organizationId).toBe("org-after");

    await client.sandboxes.get("sbx-1");
    expect(recorded.get("getSandbox")!.get(ORGANIZATION_METADATA_KEY)).toEqual(["org-after"]);
  });

  it("setter rejects an empty value", () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport, { organizationId: "org-before" });

    expect(() => {
      client.organizationId = "";
    }).toThrow();
    expect(client.organizationId).toBe("org-before");
  });
});
