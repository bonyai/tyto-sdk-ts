import * as grpc from "@grpc/grpc-js";

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
  SessionExistsError,
  SessionNotFoundError,
  TimeoutError,
  TytoError,
} from "./errors.js";
import { sanitizeMessage } from "./transport.js";

const RETRYABLE_CODES = new Set<grpc.status>([grpc.status.UNAVAILABLE]);

const FILESYSTEM_CAPABILITY_REJECTION_MESSAGES = new Set([
  "filesystem capability rejected",
  "filesystem capability sandbox binding rejected",
]);

/** A gRPC service error surfaced by @grpc/grpc-js, carrying a status code and details. */
export interface GrpcServiceError extends Error {
  code: grpc.status;
  details?: string;
}

export function isGrpcServiceError(error: unknown): error is GrpcServiceError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "number"
  );
}

export function isRetryableTransportError(error: unknown): boolean {
  return isGrpcServiceError(error) && RETRYABLE_CODES.has(error.code);
}

export interface MapRpcErrorOptions {
  secrets?: readonly (string | undefined)[];
  sandboxId?: string | undefined;
  operationId?: string | undefined;
  idempotencyKey?: string | undefined;
  create?: boolean;
  execRpc?: boolean;
  filesystemRpc?: boolean;
  sessionRpc?: boolean;
}

/**
 * Maps a raw error (typically a gRPC ServiceError) to a typed TytoError.
 * Mirrors sdks/python/src/tyto/_grpc_errors.py:map_rpc_error.
 */
export function mapRpcError(error: unknown, options: MapRpcErrorOptions = {}): TytoError {
  if (error instanceof TytoError) {
    return error;
  }
  const secrets = options.secrets ?? [];
  const { sandboxId, operationId, idempotencyKey, create, execRpc, filesystemRpc, sessionRpc } = options;

  if (!isGrpcServiceError(error)) {
    return new ServiceError(sanitizeMessage(error instanceof Error ? error.message : error, secrets), {
      sandboxId,
      operationId,
      idempotencyKey,
    });
  }

  const code = error.code;
  const details = sanitizeMessage(error.details || grpc.status[code], secrets);

  if (filesystemRpc && code === grpc.status.DEADLINE_EXCEEDED) {
    return new FilesystemError(details, { sandboxId, operationId });
  }
  if (filesystemRpc && code === grpc.status.UNAVAILABLE) {
    return new FilesystemError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.DEADLINE_EXCEEDED) {
    const ErrorClass = create ? SandboxCreationTimeoutError : TimeoutError;
    return new ErrorClass(details, { sandboxId, operationId, idempotencyKey });
  }
  if (code === grpc.status.UNAVAILABLE) {
    return new ConnectionError(details, { sandboxId, operationId, idempotencyKey });
  }
  if (code === grpc.status.UNAUTHENTICATED) {
    return new AuthenticationError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.INVALID_ARGUMENT) {
    return new InvalidRequestError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.NOT_FOUND && filesystemRpc) {
    return new RemoteFileNotFoundError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.NOT_FOUND && sessionRpc) {
    return new SessionNotFoundError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.NOT_FOUND) {
    return new SandboxNotFoundError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.ALREADY_EXISTS && filesystemRpc) {
    return new RemoteFileExistsError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.ALREADY_EXISTS && sessionRpc) {
    return new SessionExistsError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.PERMISSION_DENIED && execRpc) {
    return new CapabilityRejectedError(
      "exec capability was rejected; capability refresh/reconnect is unavailable in this SDK version",
      { sandboxId, operationId },
    );
  }
  if (code === grpc.status.PERMISSION_DENIED && filesystemRpc && FILESYSTEM_CAPABILITY_REJECTION_MESSAGES.has(details)) {
    return new CapabilityRejectedError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.PERMISSION_DENIED && filesystemRpc) {
    return new FilesystemError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.PERMISSION_DENIED && sessionRpc) {
    return new CapabilityRejectedError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.FAILED_PRECONDITION && details.includes("sandbox_deleted")) {
    return new SandboxDeletedError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.FAILED_PRECONDITION && details.includes("sandbox_suspended")) {
    return new SandboxSuspendedError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.FAILED_PRECONDITION && details.includes("sandbox_failed")) {
    return new SandboxFailedError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.ABORTED && filesystemRpc) {
    return new FilesystemError(details, { sandboxId, operationId, idempotencyKey });
  }
  if (code === grpc.status.ABORTED) {
    return new SandboxBusyError(details, { sandboxId, operationId, idempotencyKey });
  }
  if (code === grpc.status.FAILED_PRECONDITION && create) {
    return new SandboxCreationFailedError(details, { sandboxId, operationId, idempotencyKey });
  }
  if (code === grpc.status.FAILED_PRECONDITION && execRpc) {
    return new ServiceError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.FAILED_PRECONDITION && filesystemRpc && details.includes("cross_filesystem_move")) {
    return new CrossFilesystemMoveError(details, { sandboxId, operationId });
  }
  if (code === grpc.status.RESOURCE_EXHAUSTED && filesystemRpc) {
    return new FilesystemLimitError(details, { sandboxId, operationId });
  }
  if (filesystemRpc) {
    return new FilesystemError(details, { sandboxId, operationId });
  }
  return new ServiceError(details, { sandboxId, operationId, idempotencyKey });
}
