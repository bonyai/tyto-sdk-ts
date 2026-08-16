import * as grpc from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";

import { Tyto } from "../src/client.js";
import { InvalidRequestError, SessionExists, SessionNotFoundError } from "../src/errors.js";
import { Exit, Stdout } from "../src/types.js";
import { SessionEnded, SessionEndedReason, SessionStatus } from "../src/sessions.js";
import { makeFakeTransport, RpcFailure } from "./fakes.js";
import { acceptedFrame, FakeAttachStream, FakeSessionGuest } from "./session-fakes.js";

function makeSessionsClient(guest: FakeSessionGuest) {
  const transport = makeFakeTransport();
  transport.guestStubFactory = () => guest as unknown as any;
  const client = new Tyto({
    apiKey: "secret-api",
    endpoint: "https://api.example.test/",
    timeout: 2,
    maxRetries: 2,
    _channelFactory: transport.channelFactory,
    _tapiStubFactory: transport.tapiStubFactory,
    _guestStubFactory: transport.guestStubFactory,
  });
  return { client, transport };
}

describe("SandboxSessions", () => {
  it("create/list/kill return typed SessionInfo", async () => {
    const guest = new FakeSessionGuest();
    const { client } = makeSessionsClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const created = await sandbox.sessions.create("server", ["bash"], { cols: 120, rows: 40 });
    expect(created.name).toBe("server");
    expect(created.status).toBe(SessionStatus.STARTING);

    const list = await sandbox.sessions.list();
    expect(list.sandboxSuspended).toBe(false);

    const killed = await sandbox.sessions.kill("server");
    expect(killed.status).toBe(SessionStatus.KILLED);
    expect(killed.exit?.exitCode).toBe(0);
  });

  it("reports sandbox_suspended without blocking locally", async () => {
    const guest = new FakeSessionGuest();
    guest.listSessionsImpl = (_request, _metadata, _options, callback) =>
      callback(null, { sessions: [], sandboxSuspended: true });
    const { client } = makeSessionsClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const list = await sandbox.sessions.list();
    expect(list.sandboxSuspended).toBe(true);
  });

  it("validates name, command, and dimensions before the RPC", async () => {
    const guest = new FakeSessionGuest();
    const { client } = makeSessionsClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await expect(sandbox.sessions.create("", ["bash"])).rejects.toThrow(InvalidRequestError);
    await expect(sandbox.sessions.create("Server", ["bash"])).rejects.toThrow(InvalidRequestError);
    await expect(sandbox.sessions.create("server", [])).rejects.toThrow(InvalidRequestError);
    await expect(sandbox.sessions.create("server", ["bash"], { cols: 600 })).rejects.toThrow(InvalidRequestError);
    expect(guest.createRequests).toHaveLength(0);
  });

  it("maps ALREADY_EXISTS to SessionExists and NOT_FOUND to SessionNotFoundError", async () => {
    const guest = new FakeSessionGuest();
    guest.createSessionImpl = (_r, _m, _o, callback) => callback(new RpcFailure(grpc.status.ALREADY_EXISTS, "exists"));
    guest.killSessionImpl = (_r, _m, _o, callback) => callback(new RpcFailure(grpc.status.NOT_FOUND, "missing"));
    const { client } = makeSessionsClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await expect(sandbox.sessions.create("server", ["bash"])).rejects.toThrow(SessionExists);
    await expect(sandbox.sessions.kill("missing")).rejects.toThrow(SessionNotFoundError);
  });

  it("attaches, surfaces replay metadata immediately, and iterates output then exit", async () => {
    const guest = new FakeSessionGuest();
    guest.attachSessionImpl = () =>
      new FakeAttachStream([
        () => acceptedFrame({ replayedBytes: 42, historyDropped: true }),
        () => ({ output: { data: Buffer.from("hello") } }),
        () => ({ exit: { exitCode: 0, signaled: false, signal: 0 } }),
      ]);
    const { client } = makeSessionsClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const stream = await sandbox.sessions.attach("server");
    expect(stream.replayedBytes).toBe(42);
    expect(stream.historyDropped).toBe(true);
    expect(stream.info.name).toBe("server");

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events[0]).toBeInstanceOf(Stdout);
    expect(events[1]).toBeInstanceOf(Exit);
  });

  it("does not end the stream on OutputDropped", async () => {
    const guest = new FakeSessionGuest();
    guest.attachSessionImpl = () =>
      new FakeAttachStream([
        () => acceptedFrame(),
        () => ({ outputDropped: { droppedBytes: 128 } }),
        () => ({ output: { data: Buffer.from("after") } }),
        () => "END",
      ]);
    const { client } = makeSessionsClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const stream = await sandbox.sessions.attach("server");
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
  });

  it("reports the ended reason and terminates on takeover", async () => {
    const guest = new FakeSessionGuest();
    guest.attachSessionImpl = () =>
      new FakeAttachStream([() => acceptedFrame(), () => ({ ended: { reason: 2 } })]);
    const { client } = makeSessionsClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    const stream = await sandbox.sessions.attach("server");
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect((events[0] as SessionEnded).reason).toBe(SessionEndedReason.TAKEOVER);
  });

  it("refreshes once on UNAUTHENTICATED for unary session calls", async () => {
    const guest = new FakeSessionGuest();
    let calls = 0;
    guest.listSessionsImpl = (_r, _m, _o, callback) => {
      calls += 1;
      if (calls === 1) {
        callback(new RpcFailure(grpc.status.UNAUTHENTICATED, "expired"));
        return;
      }
      callback(null, { sessions: [], sandboxSuspended: false });
    };
    const { client, transport } = makeSessionsClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await sandbox.sessions.list();
    expect(transport.tapi.reissueRequests).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("never refreshes on PERMISSION_DENIED for unary session calls", async () => {
    const guest = new FakeSessionGuest();
    guest.listSessionsImpl = (_r, _m, _o, callback) => callback(new RpcFailure(grpc.status.PERMISSION_DENIED, "denied"));
    const { client, transport } = makeSessionsClient(guest);
    const sandbox = await client.sandboxes.create({ template: "ubuntu-24.04" });

    await expect(sandbox.sessions.list()).rejects.toThrow();
    expect(transport.tapi.reissueRequests).toHaveLength(0);
  });
});
