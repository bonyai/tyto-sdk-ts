import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { WebSocket } from "ws";
import type { HttpClient } from "../http.js";
import type { ResolvedConfig } from "../config.js";
import { packDir, unpackDir } from "../tar.js";
import { connectWs } from "../ws.js";
import { FileSystem } from "./files.js";
import { type Session, SessionsResource } from "./sessions.js";
import { HoldsResource } from "./holds.js";
import { PreviewsResource } from "./previews.js";
import { SnapshotsResource } from "./snapshots.js";
import type {
  CreateNestOptions,
  CreatePreviewOptions,
  CreateSessionOptions,
  CreateSnapshotOptions,
  DeleteSnapshotOptions,
  DeleteSnapshotResponse,
  ForkOptions,
  ForkResponse,
  NestData,
  NestLifecycle,
  NestStatus,
  PreviewData,
  RestoreResponse,
  SnapshotData,
  WakeOptions,
  WakeResponse,
} from "../types.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Single-quote a string for safe interpolation into a bash command. */
function shquote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

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

  /**
   * Run a command in the nest and return its captured output.
   *
   * The API runs managed sessions to completion server-side and only exposes
   * live output over a WebSocket, which is racy for short commands (the session
   * can finish before the stream attaches, yielding HTTP 410). So we redirect
   * the command's stdout+stderr and exit code to files, poll the filesystem
   * until the exit-code file appears, then read the output back over the
   * (reliable) filesystem API. No WebSocket required.
   */
  async run(
    argv: string[],
    opts?: { cwd?: string; cols?: number; rows?: number; timeoutMs?: number },
  ): Promise<string> {
    const workDir = "/home/tyto/.tyto-run";
    const runId = randomBytes(8).toString("hex");
    const outAbs = `${workDir}/${runId}.out`;
    const rcAbs = `${workDir}/${runId}.rc`;
    const outRel = `.tyto-run/${runId}.out`;
    const rcRel = `.tyto-run/${runId}.rc`;

    const cwd = opts?.cwd ?? "/home/tyto";
    const inner = argv.map(shquote).join(" ");
    const script =
      `mkdir -p ${shquote(workDir)}; ` +
      `{ cd ${shquote(cwd)} && ${inner} ; } > ${shquote(outAbs)} 2>&1; ` +
      `echo $? > ${shquote(rcAbs)}`;

    await this.sessions.create({
      tty: true,
      argv: ["bash", "-lc", script],
      cwd: opts?.cwd,
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
    });

    // The exit-code file is written only after the command completes, so its
    // presence is an unambiguous "done" signal. (Session status is unreliable
    // here: a quiet tty session reports "idle" while still running.)
    const deadline = Date.now() + (opts?.timeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        if ((await this.fs.read(rcRel)).data.toString("utf8").trim()) break;
      } catch {
        // exit-code file not written yet
      }
    }

    try {
      return (await this.fs.read(outRel)).data.toString("utf8");
    } catch {
      return "";
    }
  }

  async createSnapshot(opts?: CreateSnapshotOptions): Promise<SnapshotData> {
    return this.snapshots.create(opts);
  }

  async deleteSnapshot(
    snapshotId: string,
    opts?: DeleteSnapshotOptions,
  ): Promise<DeleteSnapshotResponse> {
    return this.http.delete<DeleteSnapshotResponse>(
      `/snapshots/${snapshotId}`,
      opts as Record<string, string | number | boolean | undefined>,
    );
  }

  async createSession(opts: CreateSessionOptions): Promise<Session> {
    return this.sessions.create(opts);
  }

  async createPreview(opts: CreatePreviewOptions): Promise<PreviewData> {
    return this.previews.create(opts);
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

}
