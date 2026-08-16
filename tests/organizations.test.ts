import { describe, expect, it } from "vitest";

import { Status } from "../src/types.js";
import { makeClient, makeFakeTransport } from "./fakes.js";
import { FakeSessionGuest } from "./session-fakes.js";

describe("listOrganizations", () => {
  it("maps fields, including the personal flag and createdAt", async () => {
    const transport = makeFakeTransport();
    transport.tapi.organizations = [
      { organizationId: "org-personal", name: "personal", personal: true, role: "owner", createdAtUnixNanos: 1_000_000_000 },
      { organizationId: "org-team", name: "Acme", personal: false, role: "member", createdAtUnixNanos: 2_000_000_000 },
    ];
    const client = makeClient(transport);

    const organizations = await client.listOrganizations();

    expect(organizations).toHaveLength(2);
    const [personal, team] = organizations;
    expect(personal!.id).toBe("org-personal");
    expect(personal!.personal).toBe(true);
    expect(personal!.role).toBe("owner");
    expect(personal!.createdAt.getTime()).toBe(1000);

    expect(team!.id).toBe("org-team");
    expect(team!.name).toBe("Acme");
    expect(team!.personal).toBe(false);
    expect(team!.role).toBe("member");
  });

  it("returns an empty list when the caller belongs to no organizations", async () => {
    const transport = makeFakeTransport();
    transport.tapi.organizations = [];
    const client = makeClient(transport);

    const organizations = await client.listOrganizations();

    expect(organizations).toEqual([]);
  });
});

describe("flat sandbox methods", () => {
  it("createSandbox/getSandbox/getSandboxByName/listSandboxes reach the same sandbox as the namespaced form", async () => {
    const transport = makeFakeTransport();
    transport.tapi.generatedName = "flat-test";
    const client = makeClient(transport);

    const created = await client.createSandbox({ template: "ubuntu-24.04" });

    const viaNamespace = await client.sandboxes.get(created.id);
    expect(viaNamespace.id).toBe(created.id);

    const viaFlat = await client.getSandbox(created.id);
    expect(viaFlat.id).toBe(created.id);

    const byName = await client.getSandboxByName("flat-test");
    expect(byName.id).toBe(created.id);

    const summaries: string[] = [];
    for await (const summary of client.listSandboxes()) {
      summaries.push(summary.id);
    }
    expect(summaries).toEqual([created.id]);
  });

  it("deleteSandbox works without first fetching a handle", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    const result = await client.deleteSandbox("sbx-flat-delete");

    expect(result.sandboxId).toBe("sbx-flat-delete");
  });

  it("resumeSandbox works without first fetching a handle", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    const result = await client.resumeSandbox("sbx-flat-resume");

    expect(result.sandboxId).toBe("sbx-flat-resume");
  });

  it("sandbox.resume() still refreshes the handle after the shared-implementation refactor", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });
    sandbox.lastObservedStatus = Status.SUSPENDED;

    await sandbox.resume();

    expect(sandbox.lastObservedStatus).toBe(Status.RUNNING);
  });

  it("sandbox.delete() still short-circuits locally on a second call", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await sandbox.delete();
    const second = await sandbox.delete();

    expect(second.alreadyDeleted).toBe(true);
  });
});

describe("flat sandbox-scoped methods", () => {
  it("createSnapshot/deleteSnapshot resolve the handle then delegate", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const snapshot = await client.createSnapshot(sandbox.id, { idempotencyKey: "snap-key" });
    expect(snapshot.sourceSandboxId).toBe(sandbox.id);
    expect(transport.tapi.getRequests).toHaveLength(1);
    expect((transport.tapi.snapshotCreateRequests.at(-1) as any).idempotencyKey).toBe("snap-key");

    await client.deleteSnapshot(sandbox.id, snapshot.id);
    expect((transport.tapi.snapshotDeleteRequests.at(-1) as any).snapshotId).toBe(snapshot.id);
    expect((transport.tapi.snapshotDeleteRequests.at(-1) as any).sourceSandboxId).toBe(sandbox.id);
  });

  it("createPreview/listPreviews/deletePreview resolve the handle then delegate", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const preview = await client.createPreview(sandbox.id, 3000, { name: "web" });
    expect(preview.sandboxId).toBe(sandbox.id);

    const previews = await client.listPreviews(sandbox.id);
    expect(previews.some((p) => p.id === preview.id)).toBe(true);

    await client.deletePreview(sandbox.id, preview.id);
    expect(transport.tapi.previewDeleteRequests.at(-1).previewId).toBe(preview.id);
    expect(transport.tapi.previewDeleteRequests.at(-1).sandboxId).toBe(sandbox.id);
  });

  it("createSession/listSessions/killSession resolve the handle then delegate", async () => {
    const transport = makeFakeTransport();
    const guest = new FakeSessionGuest();
    transport.guestStubFactory = () => guest as unknown as any;
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const created = await client.createSession(sandbox.id, "server", ["bash"], { cols: 120, rows: 40 });
    expect(created.name).toBe("server");
    expect(transport.tapi.getRequests).toHaveLength(1);

    const list = await client.listSessions(sandbox.id);
    expect(list.sandboxSuspended).toBe(false);

    const killed = await client.killSession(sandbox.id, "server");
    expect(killed.status).toBe("killed");
  });
});
