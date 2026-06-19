import type { HttpClient } from "../http.js";
import type {
  AuthStartRequest,
  AuthStartResponse,
  AuthPollResponse,
} from "../types.js";

export class AuthResource {
  constructor(private readonly http: HttpClient) {}

  async startCli(opts?: AuthStartRequest): Promise<AuthStartResponse> {
    return this.http.post<AuthStartResponse>("/auth/cli/start", opts ?? {});
  }

  async pollCli(deviceCode: string): Promise<AuthPollResponse> {
    return this.http.post<AuthPollResponse>("/auth/cli/poll", {
      device_code: deviceCode,
    });
  }
}
