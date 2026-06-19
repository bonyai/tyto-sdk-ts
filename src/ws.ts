import { WebSocket } from "ws";
import type { ResolvedConfig } from "./config.js";

export function connectWs(config: ResolvedConfig, path: string): WebSocket {
  const wsUrl = config.apiUrl.replace(/^http/, "ws") + path;
  return new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
}
