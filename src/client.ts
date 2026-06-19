import { resolveConfig, type TytoOptions } from "./config.js";
import { HttpClient } from "./http.js";
import { AuthResource } from "./resources/auth.js";
import { type Nest, NestsResource } from "./resources/nests.js";
import {
  TopLevelPreviewsResource,
} from "./resources/previews.js";
import { TopLevelSnapshotsResource } from "./resources/snapshots.js";
import type { CreateNestOptions, User } from "./types.js";

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
