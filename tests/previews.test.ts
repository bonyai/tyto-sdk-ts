import * as grpc from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";

import { InvalidRequestError } from "../src/errors.js";
import { PreviewAuth, previewFromInfo } from "../src/previews.js";
import { PreviewAuthMode } from "../src/proto/tyto/runtime/v1/preview.js";
import { Wait } from "../src/types.js";
import { makeClient, makeFakeTransport, RpcFailure } from "./fakes.js";

async function makeSandbox() {
  const transport = makeFakeTransport();
  const client = makeClient(transport);
  const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04", wait: Wait.NONE, idempotencyKey: "idem-1" });
  return { sandbox, transport };
}

describe("SandboxPreviews", () => {
  it("returns the published preview", async () => {
    const { sandbox, transport } = await makeSandbox();

    const preview = await sandbox.previews.create(3000, { name: "web" });

    expect(preview.id).toBe(transport.tapi.nextPreviewId);
    expect(preview.sandboxId).toBe(sandbox.id);
    expect(preview.port).toBe(3000);
    expect(preview.auth).toBe(PreviewAuth.TOKEN);
    expect(preview.name).toBe("web");
    expect(preview.url).toBe(`https://${preview.id}.preview.example.test`);
    expect(preview.createdAt.getFullYear()).toBe(2023);

    const sent = transport.tapi.previewCreateRequests.at(-1);
    expect(sent.sandboxId).toBe(sandbox.id);
    expect(sent.authMode).toBe(PreviewAuthMode.PREVIEW_AUTH_MODE_TOKEN);
    expect(sent.idempotencyKey).toBeTruthy();
  });

  it("replaces the stored capability", async () => {
    const { sandbox, transport } = await makeSandbox();
    const before = (sandbox as any)._capability;
    transport.tapi.previewCapabilityValue = "cap-with-preview-scope";

    await sandbox.previews.create(3000);

    expect(before).not.toBe("cap-with-preview-scope");
    expect((sandbox as any)._capability).toBe("cap-with-preview-scope");
  });

  it("forwards public mode explicitly", async () => {
    const { sandbox, transport } = await makeSandbox();

    const preview = await sandbox.previews.create(8080, { auth: PreviewAuth.PUBLIC });

    expect(preview.auth).toBe(PreviewAuth.PUBLIC);
    expect(transport.tapi.previewCreateRequests.at(-1).authMode).toBe(PreviewAuthMode.PREVIEW_AUTH_MODE_PUBLIC);
  });

  it.each([
    [80, {}],
    [0, {}],
    [70000, {}],
    [3000, { name: "x".repeat(81) }],
  ] as const)("validates before calling the server: port=%s", async (port, options) => {
    const { sandbox, transport } = await makeSandbox();
    await expect(sandbox.previews.create(port, options)).rejects.toThrow(InvalidRequestError);
    expect(transport.tapi.previewCreateRequests).toHaveLength(0);
  });

  it("round-trips list and delete", async () => {
    const { sandbox, transport } = await makeSandbox();
    const created = await sandbox.previews.create(3000, { name: "web" });

    const listed = await sandbox.previews.list();
    expect(listed.map((p) => p.id)).toEqual([created.id]);
    expect(listed[0]!.url).toBe(created.url);

    await sandbox.previews.delete(created.id);
    expect(await sandbox.previews.list()).toEqual([]);
    expect(transport.tapi.previewDeleteRequests.at(-1).previewId).toBe(created.id);
  });

  it("requires a preview id to delete", async () => {
    const { sandbox, transport } = await makeSandbox();
    await expect(sandbox.previews.delete("")).rejects.toThrow(InvalidRequestError);
    expect(transport.tapi.previewDeleteRequests).toHaveLength(0);
  });

  it("browser_url carries the current capability", async () => {
    const { sandbox, transport } = await makeSandbox();
    transport.tapi.previewCapabilityValue = "cap-abc";
    const preview = await sandbox.previews.create(3000);

    const url = sandbox.previews.browserUrl(preview);
    expect(url).toBe(`${preview.url}?bonya_token=cap-abc`);
  });

  it("refuses a browser_url exchange for a public preview", async () => {
    const { sandbox } = await makeSandbox();
    const preview = await sandbox.previews.create(8080, { auth: PreviewAuth.PUBLIC });
    expect(() => sandbox.previews.browserUrl(preview)).toThrow(InvalidRequestError);
  });

  it("maps preview RPC errors to typed errors", async () => {
    const { sandbox, transport } = await makeSandbox();
    transport.tapi.previewCreateErrors.push(new RpcFailure(grpc.status.INVALID_ARGUMENT, "port must be between 1024 and 65535"));
    await expect(sandbox.previews.create(3000)).rejects.toThrow(InvalidRequestError);
  });

  it("does not leak the capability in preview error messages", async () => {
    const { sandbox, transport } = await makeSandbox();
    const secret = (sandbox as any)._capability as string;
    transport.tapi.previewListErrors.push(new RpcFailure(grpc.status.INVALID_ARGUMENT, `bad token ${secret}`));

    await expect(sandbox.previews.list()).rejects.toSatisfy((error: unknown) => !(error as Error).message.includes(secret));
  });

  it("reports an unknown auth mode as TOKEN", () => {
    const info = {
      record: {
        previewId: "pv-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        sandboxId: "sbx-1",
        port: 3000,
        authMode: 99 as PreviewAuthMode,
        name: "",
        createdAtUnixNanos: 0,
      },
      url: "https://example.test",
    };
    expect(previewFromInfo(info).auth).toBe(PreviewAuth.TOKEN);
  });
});
