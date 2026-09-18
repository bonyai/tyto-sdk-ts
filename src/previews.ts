import { InvalidRequestError } from "./errors.js";
import { PreviewAuthMode } from "./proto/tyto/runtime/v1/preview.js";
import type { PreviewInfo as ProtoPreviewInfo } from "./proto/tyto/runtime/v1/tapi.js";

/** How a preview URL admits a request. */
export enum PreviewAuth {
  /** The sandbox's data-plane capability admits the request, as a bearer token or via the browser exchange. */
  TOKEN = "token",
  /** No authentication. Anyone holding the URL reaches the service. */
  PUBLIC = "public",
}

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
