import { resolveConfig, type TytoOptions } from "./config.js";
import { HttpClient } from "./http.js";
import { AuthResource } from "./resources/auth.js";
import { type Nest, NestsResource } from "./resources/nests.js";
import {
  TopLevelPreviewsResource,
} from "./resources/previews.js";
import { TopLevelSnapshotsResource } from "./resources/snapshots.js";
import type { CreateNestOptions, User } from "./types.js";

function parseRemote(remote: string): { nestName: string; remotePath: string } {
  const colon = remote.indexOf(":");
  if (colon < 0) {
    throw new Error(
      `Invalid remote path "${remote}": expected "nestName:path"`,
    );
  }
  return { nestName: remote.slice(0, colon), remotePath: remote.slice(colon + 1) };
}

export class Tyto {
  readonly auth: AuthResource;
  readonly nests: NestsResource;
  readonly previews: TopLevelPreviewsResource;
  readonly snapshots: TopLevelSnapshotsResource;

  private readonly http: HttpClient;

  constructor(opts?: TytoOptions) {
    const config = resolveConfig(opts);
    this.http = new HttpClient(config);
    this.auth = new AuthResource(this.http);
    this.nests = new NestsResource(this.http, config);
    this.previews = new TopLevelPreviewsResource(this.http);
    this.snapshots = new TopLevelSnapshotsResource(this.http);
  }

  async create(opts: CreateNestOptions): Promise<Nest> {
    return this.nests.create(opts);
  }

  async put(localPath: string, remote: string): Promise<void> {
    const { nestName, remotePath } = parseRemote(remote);
    const nest = await this.nests.getByName(nestName);
    await nest.put(localPath, remotePath);
  }

  async get(remote: string, localPath: string): Promise<void> {
    const { nestName, remotePath } = parseRemote(remote);
    const nest = await this.nests.getByName(nestName);
    await nest.get(remotePath, localPath);
  }

  async health(): Promise<{ ok: boolean }> {
    return this.http.get<{ ok: boolean }>("/healthz");
  }

  async ready(): Promise<{ ok: boolean }> {
    return this.http.get<{ ok: boolean }>("/readyz");
  }

  async me(): Promise<User> {
    return this.http.get<User>("/me");
  }
}
