import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { WebSocket } from "ws";
import type { HttpClient } from "../http.js";
import type { ResolvedConfig } from "../config.js";
import { packDir, unpackDir } from "../tar.js";
import { connectWs } from "../ws.js";
import { FileSystem } from "./files.js";
import { SessionsResource } from "./sessions.js";
import { HoldsResource } from "./holds.js";
import { PreviewsResource } from "./previews.js";
import { SnapshotsResource } from "./snapshots.js";
import type {
  CreateNestOptions,
  ForkOptions,
  ForkResponse,
  NestData,
  NestLifecycle,
  NestStatus,
  RestoreResponse,
  WakeOptions,
  WakeResponse,
} from "../types.js";

export class Nest {
  readonly fs: FileSystem;
  readonly sessions: SessionsResource;
  readonly previews: PreviewsResource;
  readonly snapshots: SnapshotsResource;
  readonly holds: HoldsResource;

  private _data: NestData;

  constructor(
    data: NestData,
    private readonly http: HttpClient,
    private readonly config: ResolvedConfig,
  ) {
    this._data = data;
    this.fs = new FileSystem(data.id, http);
    this.sessions = new SessionsResource(data.id, http, config);
    this.previews = new PreviewsResource(data.id, http);
    this.snapshots = new SnapshotsResource(data.id, http);
    this.holds = new HoldsResource(data.id, http);
  }

  get id(): string {
    return this._data.id;
  }
  get user_id(): string {
    return this._data.user_id;
  }
  get name(): string {
    return this._data.name;
  }
  get template(): string {
    return this._data.template;
  }
  get status(): NestStatus {
    return this._data.status;
  }
  get repo_url(): string | undefined {
    return this._data.repo_url;
  }
  get error_message(): string | undefined {
    return this._data.error_message;
  }
  get sleep_source(): string | undefined {
    return this._data.sleep_source;
  }
  get lifecycle_error(): string | undefined {
    return this._data.lifecycle_error;
  }
  get last_activity_at(): string | undefined {
    return this._data.last_activity_at;
  }
  get last_wake_at(): string | undefined {
    return this._data.last_wake_at;
  }
  get created_at(): string {
    return this._data.created_at;
  }
  get updated_at(): string {
    return this._data.updated_at;
  }

  get data(): NestData {
    return this._data;
  }

  async start(): Promise<Nest | WakeResponse> {
    const result = await this.http.post<NestData | WakeResponse>(
      `/nest/${this._data.id}/start`,
    );
    if ("user_id" in result) {
      this._data = result as NestData;
      return this;
    }
    return result as WakeResponse;
  }

  async stop(): Promise<Nest> {
    const data = await this.http.post<NestData>(`/nest/${this._data.id}/stop`);
    this._data = data;
    return this;
  }

  async wake(opts?: WakeOptions): Promise<WakeResponse> {
    return this.http.post<WakeResponse>(`/nest/${this._data.id}/wake`, opts);
  }

  async delete(): Promise<NestData | undefined> {
    return this.http.delete<NestData | undefined>(`/nest/${this._data.id}`);
  }

  async lifecycle(): Promise<NestLifecycle> {
    return this.http.get<NestLifecycle>(`/nest/${this._data.id}/lifecycle`);
  }

  async restore(snapshotId: string): Promise<RestoreResponse> {
    return this.http.post<RestoreResponse>(`/nest/${this._data.id}/restore`, {
      snapshot_id: snapshotId,
    });
  }

  async fork(opts: ForkOptions): Promise<ForkResponse> {
    return this.http.post<ForkResponse>(`/nest/${this._data.id}/fork`, opts);
  }

  async run(
    argv: string[],
    opts?: { cwd?: string; cols?: number; rows?: number },
  ): Promise<string> {
    const session = await this.sessions.create({
      tty: true,
      argv,
      cwd: opts?.cwd,
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
    });
    return new Promise((resolve, reject) => {
      const ws = session.attach();
      const chunks: Buffer[] = [];
      ws.on("message", (data) => {
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      });
      ws.on("close", () => resolve(Buffer.concat(chunks).toString()));
      ws.on("error", reject);
    });
  }

  async put(localPath: string, remotePath: string): Promise<void> {
    const info = await stat(localPath);
    if (info.isDirectory()) {
      const data = await packDir(localPath);
      await this.fs.write(remotePath, data, "dir");
    } else {
      const data = await readFile(localPath);
      await this.fs.write(remotePath, data, "file");
    }
  }

  async get(remotePath: string, localPath: string): Promise<void> {
    const result = await this.fs.read(remotePath);
    if (result.kind === "dir") {
      await unpackDir(result.data, localPath);
    } else {
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, result.data);
    }
  }

  console(): WebSocket {
    return connectWs(this.config, `/nest/${this._data.id}/console`);
  }

  exec(): WebSocket {
    return connectWs(this.config, `/nest/${this._data.id}/exec`);
  }
}

export class NestsResource {
  constructor(
    private readonly http: HttpClient,
    private readonly config: ResolvedConfig,
  ) {}

  async create(opts: CreateNestOptions): Promise<Nest> {
    const data = await this.http.post<NestData>("/nest/", opts);
    return new Nest(data, this.http, this.config);
  }

  async list(): Promise<Nest[]> {
    const data = await this.http.get<NestData[]>("/nest/");
    return data.map((d) => new Nest(d, this.http, this.config));
  }

  async get(id: string): Promise<Nest> {
    const data = await this.http.get<NestData>(`/nest/${id}`);
    return new Nest(data, this.http, this.config);
  }

  async getByName(name: string): Promise<Nest> {
    const nests = await this.list();
    const found = nests.find((n) => n.name === name);
    if (!found) throw new Error(`No nest found with name "${name}"`);
    return found;
  }
}
