import type { HttpClient } from "../http.js";
import type {
  CreateSnapshotOptions,
  DeleteSnapshotOptions,
  DeleteSnapshotResponse,
  ForkOptions,
  ForkResponse,
  RestoreResponse,
  SnapshotData,
  SnapshotList,
} from "../types.js";

export class SnapshotsResource {
  constructor(
    private readonly nestId: string,
    private readonly http: HttpClient,
  ) {}

  async create(opts?: CreateSnapshotOptions): Promise<SnapshotData> {
    return this.http.post<SnapshotData>(
      `/nest/${this.nestId}/snapshots`,
      opts ?? {},
    );
  }

  async list(): Promise<SnapshotList> {
    return this.http.get<SnapshotList>(`/nest/${this.nestId}/snapshots`);
  }

  async restore(snapshotId: string): Promise<RestoreResponse> {
    return this.http.post<RestoreResponse>(`/nest/${this.nestId}/restore`, {
      snapshot_id: snapshotId,
    });
  }

  async fork(opts: ForkOptions): Promise<ForkResponse> {
    return this.http.post<ForkResponse>(`/nest/${this.nestId}/fork`, opts);
  }
}

export class TopLevelSnapshotsResource {
  constructor(private readonly http: HttpClient) {}

  async delete(
    snapshotId: string,
    opts?: DeleteSnapshotOptions,
  ): Promise<DeleteSnapshotResponse> {
    return this.http.delete<DeleteSnapshotResponse>(
      `/snapshots/${snapshotId}`,
      opts as Record<string, string | number | boolean | undefined>,
    );
  }
}
