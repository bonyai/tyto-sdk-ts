import * as grpc from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  CapabilityRejectedError,
  ConnectionError,
  CrossFilesystemMoveError,
  FilesystemError,
  FilesystemLimitError,
  InvalidRequestError,
  RemoteFileExistsError,
  RemoteFileNotFoundError,
  SandboxBusyError,
  SandboxCreationFailedError,
  SandboxCreationTimeoutError,
  SandboxDeletedError,
  SandboxFailedError,
  SandboxNotFoundError,
  SandboxSuspendedError,
  ServiceError,
  SessionExists,
  SessionNotFoundError,
  TimeoutError,
} from "../src/errors.js";
import { isRetryableTransportError, mapRpcError } from "../src/grpc-errors.js";
import { RpcFailure } from "./fakes.js";

describe("isRetryableTransportError", () => {
  it("is true only for UNAVAILABLE", () => {
    expect(isRetryableTransportError(new RpcFailure(grpc.status.UNAVAILABLE))).toBe(true);
    expect(isRetryableTransportError(new RpcFailure(grpc.status.DEADLINE_EXCEEDED))).toBe(false);
    expect(isRetryableTransportError(new Error("plain"))).toBe(false);
  });
});

describe("mapRpcError", () => {
  it("maps UNAVAILABLE to ConnectionError", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.UNAVAILABLE, "down"))).toBeInstanceOf(ConnectionError);
  });

  it("maps DEADLINE_EXCEEDED to TimeoutError, or SandboxCreationTimeoutError when create=true", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.DEADLINE_EXCEEDED))).toBeInstanceOf(TimeoutError);
    expect(mapRpcError(new RpcFailure(grpc.status.DEADLINE_EXCEEDED), { create: true })).toBeInstanceOf(
      SandboxCreationTimeoutError,
    );
  });

  it("maps UNAUTHENTICATED to AuthenticationError", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.UNAUTHENTICATED))).toBeInstanceOf(AuthenticationError);
  });

  it("maps INVALID_ARGUMENT to InvalidRequestError", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.INVALID_ARGUMENT))).toBeInstanceOf(InvalidRequestError);
  });

  it("maps NOT_FOUND contextually", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.NOT_FOUND))).toBeInstanceOf(SandboxNotFoundError);
    expect(mapRpcError(new RpcFailure(grpc.status.NOT_FOUND), { filesystemRpc: true })).toBeInstanceOf(RemoteFileNotFoundError);
    expect(mapRpcError(new RpcFailure(grpc.status.NOT_FOUND), { sessionRpc: true })).toBeInstanceOf(SessionNotFoundError);
  });

  it("maps ALREADY_EXISTS contextually", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.ALREADY_EXISTS), { filesystemRpc: true })).toBeInstanceOf(
      RemoteFileExistsError,
    );
    expect(mapRpcError(new RpcFailure(grpc.status.ALREADY_EXISTS), { sessionRpc: true })).toBeInstanceOf(SessionExists);
  });

  it("maps PERMISSION_DENIED contextually", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.PERMISSION_DENIED), { execRpc: true })).toBeInstanceOf(
      CapabilityRejectedError,
    );
    expect(
      mapRpcError(new RpcFailure(grpc.status.PERMISSION_DENIED, "filesystem capability rejected"), { filesystemRpc: true }),
    ).toBeInstanceOf(CapabilityRejectedError);
    expect(
      mapRpcError(new RpcFailure(grpc.status.PERMISSION_DENIED, "stat file failed: permission denied"), {
        filesystemRpc: true,
      }),
    ).toBeInstanceOf(FilesystemError);
    expect(mapRpcError(new RpcFailure(grpc.status.PERMISSION_DENIED), { sessionRpc: true })).toBeInstanceOf(
      CapabilityRejectedError,
    );
  });

  it("maps FAILED_PRECONDITION by message substring", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.FAILED_PRECONDITION, "sandbox_deleted"))).toBeInstanceOf(
      SandboxDeletedError,
    );
    expect(mapRpcError(new RpcFailure(grpc.status.FAILED_PRECONDITION, "sandbox_suspended"))).toBeInstanceOf(
      SandboxSuspendedError,
    );
    expect(mapRpcError(new RpcFailure(grpc.status.FAILED_PRECONDITION, "sandbox_failed"))).toBeInstanceOf(SandboxFailedError);
    expect(mapRpcError(new RpcFailure(grpc.status.FAILED_PRECONDITION, "boom"), { create: true })).toBeInstanceOf(
      SandboxCreationFailedError,
    );
    expect(
      mapRpcError(new RpcFailure(grpc.status.FAILED_PRECONDITION, "cross_filesystem_move"), { filesystemRpc: true }),
    ).toBeInstanceOf(CrossFilesystemMoveError);
  });

  it("maps ABORTED contextually", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.ABORTED))).toBeInstanceOf(SandboxBusyError);
    expect(mapRpcError(new RpcFailure(grpc.status.ABORTED), { filesystemRpc: true })).toBeInstanceOf(FilesystemError);
  });

  it("maps RESOURCE_EXHAUSTED for filesystem to FilesystemLimitError", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.RESOURCE_EXHAUSTED), { filesystemRpc: true })).toBeInstanceOf(
      FilesystemLimitError,
    );
  });

  it("falls back to FilesystemError for any other filesystem code, ServiceError otherwise", () => {
    expect(mapRpcError(new RpcFailure(grpc.status.INTERNAL, "disk failed"), { filesystemRpc: true })).toBeInstanceOf(
      FilesystemError,
    );
    expect(mapRpcError(new RpcFailure(grpc.status.INTERNAL))).toBeInstanceOf(ServiceError);
  });

  it("passes a TytoError through unchanged", () => {
    const original = new InvalidRequestError("already typed");
    expect(mapRpcError(original)).toBe(original);
  });

  it("wraps a non-grpc error as ServiceError with a sanitized message", () => {
    const mapped = mapRpcError(new Error("boom secret-token"), { secrets: ["secret-token"] });
    expect(mapped).toBeInstanceOf(ServiceError);
    expect(mapped.message).not.toContain("secret-token");
  });

  it("redacts secrets from the mapped message", () => {
    const mapped = mapRpcError(new RpcFailure(grpc.status.UNAVAILABLE, "still down secret-api"), {
      secrets: ["secret-api"],
    });
    expect(mapped.message).not.toContain("secret-api");
  });

  it("carries sandboxId/operationId/idempotencyKey through", () => {
    const mapped = mapRpcError(new RpcFailure(grpc.status.NOT_FOUND), {
      sandboxId: "sbx-1",
      operationId: "op-1",
      idempotencyKey: "idem-1",
    });
    expect(mapped.sandboxId).toBe("sbx-1");
    expect(mapped.operationId).toBe("op-1");
  });
});
