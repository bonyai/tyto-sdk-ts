import * as grpc from "@grpc/grpc-js";
import { randomUUID } from "node:crypto";

import { InvalidRequestError } from "./errors.js";
import { mapRpcError } from "./grpc-errors.js";
import { Deadline } from "./transport.js";
import type { Sandbox } from "./sandbox.js";
import { PreviewAuthMode } from "./proto/tyto/runtime/v1/preview.js";
import type { PreviewInfo as ProtoPreviewInfo } from "./proto/tyto/runtime/v1/tapi.js";

const MIN_PREVIEW_PORT = 1024;
const MAX_PREVIEW_PORT = 65535;
const MAX_PREVIEW_NAME_BYTES = 80;
const TOKEN_QUERY_PARAM = "bonya_token";

/** How a preview URL admits a request. */
export enum PreviewAuth {
  /** The sandbox's data-plane capability admits the request, as a bearer token or via the browser exchange. */
  TOKEN = "token",
  /** No authentication. Anyone holding the URL reaches the service. */
  PUBLIC = "public",
}

const AUTH_TO_PROTO: Record<PreviewAuth, PreviewAuthMode> = {
  [PreviewAuth.TOKEN]: PreviewAuthMode.PREVIEW_AUTH_MODE_TOKEN,
  [PreviewAuth.PUBLIC]: PreviewAuthMode.PREVIEW_AUTH_MODE_PUBLIC,
};

const PROTO_TO_AUTH = new Map<PreviewAuthMode, PreviewAuth>([
  [PreviewAuthMode.PREVIEW_AUTH_MODE_TOKEN, PreviewAuth.TOKEN],
  [PreviewAuthMode.PREVIEW_AUTH_MODE_PUBLIC, PreviewAuth.PUBLIC],
]);

/** A published preview URL for one guest port. */
export interface Preview {
  readonly id: string;
  readonly sandboxId: string;
  readonly port: number;
  readonly auth: PreviewAuth;
  readonly name: string;
  readonly url: string;
  readonly createdAt: Date;
}

export function previewFromInfo(info: ProtoPreviewInfo): Preview {
  const record = info.record;
  if (!record) {
    throw new InvalidRequestError("preview response is missing its record");
  }
  const created = Number(record.createdAtUnixNanos ?? 0);
  return {
    id: record.previewId ?? "",
    sandboxId: record.sandboxId ?? "",
    port: record.port ?? 0,
    // An unrecognised mode is reported as TOKEN rather than guessed open: a
    // client from a future release must never describe a locked preview as
    // public.
    auth: PROTO_TO_AUTH.get(record.authMode ?? PreviewAuthMode.PREVIEW_AUTH_MODE_UNSPECIFIED) ?? PreviewAuth.TOKEN,
    name: record.name ?? "",
    url: info.url ?? "",
    createdAt: new Date(created / 1e6),
  };
}

export interface CreatePreviewOptions {
  auth?: PreviewAuth;
  name?: string;
  idempotencyKey?: string;
}

/**
 * Preview URL operations for one sandbox. These are TApi calls
 * authenticated with the API key, not data-plane calls, so the
 * capability-refresh wrapper that guards exec and files does not apply
 * here -- there is no capability in play on the request.
 */
export class SandboxPreviews {
  private readonly sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
  }

  /**
   * Publishes a preview URL for a guest port. On success the sandbox's
   * stored capability is replaced with the one returned, because the
   * preview scope is newer than the token a sandbox was created with.
   */
  async create(port: number, options: CreatePreviewOptions = {}): Promise<Preview> {
    if (!Number.isInteger(port)) {
      throw new InvalidRequestError("port must be an integer", { sandboxId: this.sandbox.id });
    }
    if (port < MIN_PREVIEW_PORT || port > MAX_PREVIEW_PORT) {
      throw new InvalidRequestError(`port must be between ${MIN_PREVIEW_PORT} and ${MAX_PREVIEW_PORT}`, {
        sandboxId: this.sandbox.id,
      });
    }
    const auth = options.auth ?? PreviewAuth.TOKEN;
    if (!(auth in AUTH_TO_PROTO)) {
      throw new InvalidRequestError("auth must be a PreviewAuth", { sandboxId: this.sandbox.id });
    }
    const displayName = options.name ?? "";
    if (Buffer.byteLength(displayName, "utf-8") > MAX_PREVIEW_NAME_BYTES) {
      throw new InvalidRequestError(`name exceeds ${MAX_PREVIEW_NAME_BYTES} bytes`, { sandboxId: this.sandbox.id });
    }
    const key = options.idempotencyKey ?? randomUUID();
    if (!key) {
      throw new InvalidRequestError("idempotency key must be non-empty", { sandboxId: this.sandbox.id });
    }

    const request = {
      apiKey: this.sandbox._client._apiKey,
      sandboxId: this.sandbox.id,
      port,
      authMode: AUTH_TO_PROTO[auth],
      name: displayName,
      idempotencyKey: key,
    };
    const deadline = Deadline.start(this.sandbox._client._timeout);
    let response: { preview?: ProtoPreviewInfo; capabilityJws?: string };
    try {
      response = (await callUnary(this.sandbox._client._tapiStub().createPreview, request, new grpc.Metadata(), deadline)) as {
        preview?: ProtoPreviewInfo;
        capabilityJws?: string;
      };
    } catch (error) {
      throw mapRpcError(error, { secrets: this.sandbox._client._secrets(this.sandbox._capability), sandboxId: this.sandbox.id });
    }

    if (response.capabilityJws) {
      this.sandbox._capability = response.capabilityJws;
    }
    if (!response.preview?.record?.previewId) {
      throw new InvalidRequestError("CreatePreview response is missing the preview identity", {
        sandboxId: this.sandbox.id,
        idempotencyKey: key,
      });
    }
    return previewFromInfo(response.preview);
  }

  /** Every published preview for this sandbox. */
  async list(): Promise<Preview[]> {
    const request = { apiKey: this.sandbox._client._apiKey, sandboxId: this.sandbox.id };
    const deadline = Deadline.start(this.sandbox._client._timeout);
    let response: { previews?: ProtoPreviewInfo[] };
    try {
      response = (await callUnary(this.sandbox._client._tapiStub().listPreviews, request, new grpc.Metadata(), deadline)) as {
        previews?: ProtoPreviewInfo[];
      };
    } catch (error) {
      throw mapRpcError(error, { secrets: this.sandbox._client._secrets(this.sandbox._capability), sandboxId: this.sandbox.id });
    }
    return (response.previews ?? []).map(previewFromInfo);
  }

  /** Revokes a preview URL. */
  async delete(previewId: string): Promise<void> {
    if (!previewId) {
      throw new InvalidRequestError("preview id is required", { sandboxId: this.sandbox.id });
    }
    const request = { apiKey: this.sandbox._client._apiKey, sandboxId: this.sandbox.id, previewId };
    const deadline = Deadline.start(this.sandbox._client._timeout);
    try {
      await callUnary(this.sandbox._client._tapiStub().deletePreview, request, new grpc.Metadata(), deadline);
    } catch (error) {
      throw mapRpcError(error, { secrets: this.sandbox._client._secrets(this.sandbox._capability), sandboxId: this.sandbox.id });
    }
  }

  /**
   * A one-time URL that logs a browser into a token-mode preview. Raises on
   * a public preview, which has no token to exchange and whose plain `url`
   * already works. Never share this URL: anyone who receives it holds the
   * sandbox's data-plane capability until it expires.
   */
  browserUrl(preview: Preview): string {
    if (preview.auth === PreviewAuth.PUBLIC) {
      throw new InvalidRequestError("a public preview needs no token; use preview.url", { sandboxId: this.sandbox.id });
    }
    const capability = this.sandbox._capability;
    if (!capability) {
      throw new InvalidRequestError("no capability is available for this sandbox", { sandboxId: this.sandbox.id });
    }
    const separator = preview.url.includes("?") ? "&" : "?";
    return `${preview.url}${separator}${TOKEN_QUERY_PARAM}=${capability}`;
  }
}

function callUnary<Req, Res>(
  method: (
    request: Req,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: Res) => void,
  ) => grpc.ClientUnaryCall,
  request: Req,
  metadata: grpc.Metadata,
  deadline: Deadline,
): Promise<Res> {
  void deadline;
  return new Promise((resolve, reject) => {
    method(request, metadata, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}
