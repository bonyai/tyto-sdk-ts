/** Options shared by every TytoError constructor. */
export interface TytoErrorOptions {
  sandboxId?: string | undefined;
  operationId?: string | undefined;
  idempotencyKey?: string | undefined;
}

/** Base class for every SDK error. */
export class TytoError extends Error {
  readonly sandboxId: string | undefined;
  readonly operationId: string | undefined;
  readonly idempotencyKey: string | undefined;

  constructor(message: string, options: TytoErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.message = message;
    this.sandboxId = options.sandboxId;
    this.operationId = options.operationId;
    this.idempotencyKey = options.idempotencyKey;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * @deprecated Use {@link TytoErrorOptions}. This was the original name, from
 * when the SDK's package and client were both named Bonya. Removed in 2.0.
 */
export type BonyaErrorOptions = TytoErrorOptions;

/**
 * @deprecated Use {@link TytoError}. This was the original name, from when
 * the SDK's package and client were both named Bonya. It is the same class,
 * so `instanceof BonyaError` still matches everything `instanceof TytoError`
 * does. Removed in 2.0.
 */
export const BonyaError = TytoError;

export class AuthenticationError extends TytoError {}
export class InvalidRequestError extends TytoError {}
export class SandboxNotFoundError extends TytoError {}
export class SessionExistsError extends TytoError {}

/**
 * @deprecated Use {@link SessionExistsError}. This was the original name and
 * the only error in the package that did not end in `Error`, which made it the
 * odd one out and inconsistent with the Go and Python SDKs. It is the same
 * class, so `instanceof SessionExists` still matches. Removed in 2.0.
 */
export const SessionExists = SessionExistsError;
export class SessionNotFoundError extends TytoError {}
export class SandboxDeletedError extends TytoError {}
export class SandboxSuspendedError extends TytoError {}
export class SandboxBusyError extends TytoError {}
export class SandboxFailedError extends TytoError {}
export class SandboxCreationFailedError extends TytoError {}
export class SandboxCreationTimeoutError extends TytoError {}
export class CapabilityRejectedError extends TytoError {}
export class FilesystemError extends TytoError {}
export class RemoteFileNotFoundError extends FilesystemError {}
export class RemoteFileExistsError extends FilesystemError {}
export class CrossFilesystemMoveError extends FilesystemError {}
export class FilesystemLimitError extends FilesystemError {}

/** Minimal shape of ExecResult needed by ExecFailedError; avoids a cycle with sandbox.ts. */
export interface ExecFailedResult {
  readonly exitCode: number;
  readonly signaled: boolean;
  readonly signal: number;
  readonly sandboxId: string | undefined;
}

export class ExecFailedError extends TytoError {
  readonly result: ExecFailedResult;

  constructor(message: string, options: { result: ExecFailedResult }) {
    super(message, { sandboxId: options.result.sandboxId });
    this.result = options.result;
  }
}

/** Operation deadline expired. */
export class TimeoutError extends TytoError {}

/** Retryable transport failure exhausted retries. */
export class ConnectionError extends TytoError {}

/** Service or unexpected transport failure not covered by a more specific type. */
export class ServiceError extends TytoError {}
