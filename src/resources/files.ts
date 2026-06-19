import type { HttpClient } from "../http.js";
import type { FsKind, ReadFileResult } from "../types.js";

export class FileSystem {
  constructor(
    private readonly nestId: string,
    private readonly http: HttpClient,
  ) {}

  async write(
    path: string,
    data: Uint8Array | Buffer,
    kind: FsKind,
  ): Promise<void> {
    const contentType =
      kind === "dir" ? "application/x-tar" : "application/octet-stream";
    await this.http.putBinary(
      `/nest/${this.nestId}/fs/write`,
      data,
      contentType,
      { path, kind },
    );
  }

  async read(path: string): Promise<ReadFileResult> {
    return this.http.getBinary(`/nest/${this.nestId}/fs/read`, { path });
  }
}
