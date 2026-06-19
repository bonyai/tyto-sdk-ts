import type { HttpClient } from "../http.js";
import type { CreatePreviewOptions, PreviewData } from "../types.js";

export class PreviewsResource {
  constructor(
    private readonly nestId: string,
    private readonly http: HttpClient,
  ) {}

  async create(opts: CreatePreviewOptions): Promise<PreviewData> {
    return this.http.post<PreviewData>(`/nest/${this.nestId}/previews`, opts);
  }

  async list(): Promise<PreviewData[]> {
    return this.http.get<PreviewData[]>(`/nest/${this.nestId}/previews`);
  }
}

export class TopLevelPreviewsResource {
  constructor(private readonly http: HttpClient) {}

  async get(id: string): Promise<PreviewData> {
    return this.http.get<PreviewData>(`/previews/${id}`);
  }

  async revoke(id: string): Promise<void> {
    return this.http.delete<void>(`/previews/${id}`);
  }
}
