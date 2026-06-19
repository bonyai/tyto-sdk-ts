import { TytoError } from "./errors.js";

export interface TytoOptions {
  apiKey?: string;
  apiUrl?: string;
}

export interface ResolvedConfig {
  apiKey: string;
  apiUrl: string;
}

export function resolveConfig(opts?: TytoOptions): ResolvedConfig {
  const apiKey = opts?.apiKey ?? process.env["TYTO_API_KEY"] ?? "";
  if (!apiKey) {
    throw new TytoError(
      "apiKey is required. Pass it as an option or set the TYTO_API_KEY environment variable.",
    );
  }
  const apiUrl = (
    opts?.apiUrl ??
    process.env["TYTO_API_URL"] ??
    "https://api.tyto.run"
  ).replace(/\/$/, "");
  return { apiKey, apiUrl };
}
