import { describe, expect, it } from "vitest";

import { InvalidRequestError, SandboxNotFoundError } from "../src/errors.js";
import { Wait } from "../src/types.js";
import { makeClient, makeFakeTransport, makeMetadata } from "./fakes.js";

describe("sandbox names", () => {
  it("sends the requested name and returns it", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    const sandbox = await client.sandboxes.create({
      template: "ubuntu-24.04",
      wait: Wait.NONE,
      idempotencyKey: "idem-1",
      name: "my-box",
    });

    expect((transport.tapi.createRequests[0] as any).name).toBe("my-box");
    expect(sandbox.name).toBe("my-box");
  });

  // With no name given the service generates one, and the SDK has to surface
  // it or the caller never learns what their sandbox is called.
  it("surfaces a generated name", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    const sandbox = await client.sandboxes.create({
      template: "ubuntu-24.04",
      wait: Wait.NONE,
      idempotencyKey: "idem-1",
    });

    expect((transport.tapi.createRequests[0] as any).name).toBe("");
    expect(sandbox.name).toBe("brave-cedar-6268");
  });

  it("forwards the name filter on list", async () => {
    const transport = makeFakeTransport();
    transport.tapi.listPages = [
      { sandboxes: [makeMetadata("sbx-1", { name: "my-box" })], nextPageToken: "" },
    ];
    const client = makeClient(transport);

    const summaries = [];
    for await (const summary of client.sandboxes.list({ name: "my-box" })) {
      summaries.push(summary);
    }

    expect((transport.tapi.listRequests[0] as any).name).toBe("my-box");
    expect(summaries.map((s) => s.name)).toEqual(["my-box"]);
  });

  it("resolves a name to a sandbox", async () => {
    const transport = makeFakeTransport();
    transport.tapi.listPages = [
      { sandboxes: [makeMetadata("sbx-1", { name: "my-box" })], nextPageToken: "" },
    ];
    const client = makeClient(transport);

    const sandbox = await client.sandboxes.getByName("my-box");

    expect(sandbox.id).toBe("sbx-1");
    // The name is only used to find the id; the fetch itself is by id.
    expect((transport.tapi.getRequests[0] as any).sandboxId).toBe("sbx-1");
  });

  it("reports when no sandbox carries the name", async () => {
    const transport = makeFakeTransport();
    transport.tapi.listPages = [{ sandboxes: [], nextPageToken: "" }];
    const client = makeClient(transport);

    await expect(client.sandboxes.getByName("absent")).rejects.toBeInstanceOf(SandboxNotFoundError);
  });

  // Names are not unique, and silently picking one would let a later delete
  // destroy an arbitrary sandbox.
  it("refuses to guess between duplicates", async () => {
    const transport = makeFakeTransport();
    transport.tapi.listPages = [
      {
        sandboxes: [makeMetadata("sbx-1", { name: "shared" }), makeMetadata("sbx-2", { name: "shared" })],
        nextPageToken: "",
      },
    ];
    const client = makeClient(transport);

    await expect(client.sandboxes.getByName("shared")).rejects.toBeInstanceOf(InvalidRequestError);
    expect(transport.tapi.getRequests).toEqual([]);
  });

  it("requires a name", async () => {
    const client = makeClient(makeFakeTransport());

    await expect(client.sandboxes.getByName("")).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
