import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeClient, makeFakeTransport } from "./fakes.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env["BONYA_API_KEY"] = "secret-api";
  delete process.env["BONYA_ENDPOINT"];
  delete process.env["BONYA_ORGANIZATION_ID"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("listTemplates", () => {
  it("maps fields", async () => {
    const transport = makeFakeTransport();
    transport.tapi.templates = [
      {
        templateId: "bonya-dev",
        version: "2",
        digest: "sha256:aaa",
        isDefault: true,
        metadata: {
          description: "Dev image",
          os: "ubuntu",
          osVersion: "24.04",
          stacks: [{ name: "go", version: "1.25" }],
          agentCliSupport: ["codex"],
        },
      },
      { templateId: "bonya-dev", version: "1", digest: "sha256:bbb", isDefault: false },
    ];
    const client = makeClient(transport);

    const templates = await client.listTemplates();

    expect(templates).toHaveLength(2);
    expect(templates[0]).toMatchObject({ id: "bonya-dev", version: "2", digest: "sha256:aaa", isDefault: true });
    expect(templates[0]?.metadata.description).toBe("Dev image");
    expect(templates[0]?.metadata.os).toBe("ubuntu");
    expect(templates[0]?.metadata.stacks).toEqual([{ name: "go", version: "1.25" }]);
    expect(templates[0]?.metadata.agentCliSupport).toEqual(["codex"]);
    expect(templates[1]?.isDefault).toBe(false);
    client.close();
  });

  it("returns an empty array when the catalog is empty", async () => {
    const transport = makeFakeTransport();
    transport.tapi.templates = [];
    const client = makeClient(transport);

    const templates = await client.listTemplates();

    expect(templates).toEqual([]);
    client.close();
  });
});
