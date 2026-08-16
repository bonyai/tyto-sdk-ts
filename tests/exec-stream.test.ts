import * as grpc from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";

import { CapabilityRejectedError, InvalidRequestError } from "../src/errors.js";
import { Exit, Stderr, Stdout, Status } from "../src/types.js";
import { FakeExecStream, makeClient, makeFakeTransport, RpcFailure } from "./fakes.js";

describe("Sandbox.exec (buffered)", () => {
  it("collects stdout/stderr and exit, decoding stderr with replacement", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const result = await sandbox.exec("printf ready");

    expect(result.stdout).toBe("ready");
    expect(result.ok).toBe(true);
    expect(transport.guest.calls).toBe(1);
  });

  it("check=true throws ExecFailedError on non-zero exit and carries the result", async () => {
    const transport = makeFakeTransport();
    transport.guest.execImpl = () => new FakeExecStream([{ exit: { exitCode: 2, signaled: false, signal: 0 } }]);
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await expect(sandbox.exec(["false"], { check: true })).rejects.toMatchObject({
      result: { exitCode: 2 },
    });
  });

  it("writes stdin and half-closes when input is provided", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const result = await sandbox.exec(["cat"], { input: "snowman: ☃\n" });
    expect(result.stdout).toBe("ready");
    expect(transport.guest.lastStream!.written.map((w: any) => Object.keys(w)[0])).toEqual(["start", "stdin"]);
    expect(Buffer.from(transport.guest.lastStream!.written[1].stdin.data).toString("utf-8")).toBe("snowman: ☃\n");
  });

  it("rejects input when tty=true", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });
    await expect(sandbox.exec(["sh"], { tty: true, input: "" })).rejects.toThrow(InvalidRequestError);
    expect(transport.guest.calls).toBe(0);
  });

  it("validates env keys/values and cwd before any RPC", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });
    transport.guest.calls = 0;

    await expect(sandbox.exec(["true"], { env: { "": "value" } })).rejects.toThrow(InvalidRequestError);
    await expect(sandbox.exec(["true"], { env: { "A=B": "value" } })).rejects.toThrow(InvalidRequestError);
    await expect(sandbox.exec(["true"], { cwd: "" })).rejects.toThrow(InvalidRequestError);
    expect(transport.guest.calls).toBe(0);
  });

  it("serializes env and cwd onto the start frame", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await sandbox.exec(["python3", "worker.py"], { env: { MODE: "development" }, cwd: "/workspace" });

    const start = transport.guest.lastStream!.written[0].start;
    expect(start.command).toEqual(["python3", "worker.py"]);
    expect(start.env).toEqual({ MODE: "development" });
    expect(start.workingDir).toBe("/workspace");
  });
});

describe("Sandbox.execStream (streaming)", () => {
  it("emits Stdout, Stderr, then Exit and supports half-close via write/closeStdin", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const session = sandbox.execStream(["cat"]);
    session.write(new TextEncoder().encode("input\n"));
    session.closeStdin();

    const events = [];
    for await (const event of session) {
      events.push(event);
    }

    expect(events[0]).toBeInstanceOf(Stdout);
    expect(events[1]).toBeInstanceOf(Stderr);
    expect(events[2]).toBeInstanceOf(Exit);
  });

  it("rejects tty dimension combinations", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    expect(() => sandbox.execStream(["sh"], { tty: true, cols: 80 })).toThrow(InvalidRequestError);
    expect(() => sandbox.execStream(["sh"], { tty: true, cols: 0, rows: 24 })).toThrow(InvalidRequestError);
    expect(() => sandbox.execStream(["sh"], { tty: true, cols: 513, rows: 24 })).toThrow(InvalidRequestError);
    expect(() => sandbox.execStream(["sh"], { tty: false, cols: 80, rows: 24 })).toThrow(InvalidRequestError);
  });

  it("rejects exec on a failed sandbox locally, without an RPC", async () => {
    const transport = makeFakeTransport();
    transport.tapi.sourceStatuses["sbx-1"] = Status.FAILED;
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.get("sbx-1");

    await expect(sandbox.exec(["printf", "x"])).rejects.toThrow();
    expect(transport.guest.calls).toBe(0);
  });

  it("propagates a capability rejection without retry on exec", async () => {
    const transport = makeFakeTransport();
    transport.guest.fail = true;
    transport.guest.failure = new RpcFailure(grpc.status.PERMISSION_DENIED, "exec capability rejected secret-cap");
    const client = makeClient(transport);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await expect(sandbox.exec(["false"])).rejects.toBeInstanceOf(CapabilityRejectedError);
    expect(transport.guest.calls).toBe(1);
  });
});
