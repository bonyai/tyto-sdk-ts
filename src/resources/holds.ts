import type { HttpClient } from "../http.js";
import type { HoldOptions, KeepaliveHoldData } from "../types.js";

export class HoldsResource {
  constructor(
    private readonly nestId: string,
    private readonly http: HttpClient,
  ) {}

  async list(): Promise<KeepaliveHoldData[]> {
    return this.http.get<KeepaliveHoldData[]>(`/nest/${this.nestId}/holds`);
  }

  async put(name: string, opts: HoldOptions): Promise<KeepaliveHoldData> {
    return this.http.put<KeepaliveHoldData>(
      `/nest/${this.nestId}/holds/${name}`,
      opts,
    );
  }

  async delete(name: string): Promise<void> {
    return this.http.delete<void>(`/nest/${this.nestId}/holds/${name}`);
  }

  async heartbeat(name: string, opts?: HoldOptions): Promise<KeepaliveHoldData> {
    return this.http.post<KeepaliveHoldData>(
      `/nest/${this.nestId}/holds/${name}/heartbeat`,
      opts,
    );
  }
}
