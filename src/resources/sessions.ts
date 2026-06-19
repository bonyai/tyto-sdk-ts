import { WebSocket } from "ws";
import type { HttpClient } from "../http.js";
import type { ResolvedConfig } from "../config.js";
import { connectWs } from "../ws.js";
import type {
  CreateSessionOptions,
  KillSessionOptions,
  ListSessionsOptions,
  SessionData,
} from "../types.js";

export class Session {
  constructor(
    private _data: SessionData,
    private readonly nestId: string,
    private readonly http: HttpClient,
    private readonly config: ResolvedConfig,
  ) {}

  get id() {
    return this._data.id;
  }
  get nest_id() {
    return this._data.nest_id;
  }
  get tty() {
    return this._data.tty;
  }
  get command() {
    return this._data.command;
  }
  get cwd() {
    return this._data.cwd;
  }
  get status() {
    return this._data.status;
  }
  get attached() {
    return this._data.attached;
  }
  get started_at() {
    return this._data.started_at;
  }
  get last_activity_at() {
    return this._data.last_activity_at;
  }
  get exit_code() {
    return this._data.exit_code;
  }
  get ended_at() {
    return this._data.ended_at;
  }
  get attach_url() {
    return this._data.attach_url;
  }

  get data(): SessionData {
    return this._data;
  }

  async kill(opts?: KillSessionOptions): Promise<Session> {
    const data = await this.http.post<SessionData>(
      `/nest/${this.nestId}/sessions/${this._data.id}/kill`,
      opts,
    );
    this._data = data;
    return this;
  }

  attach(): WebSocket {
    return connectWs(
      this.config,
      `/nest/${this.nestId}/sessions/${this._data.id}/attach`,
    );
  }
}

export class SessionsResource {
  constructor(
    private readonly nestId: string,
    private readonly http: HttpClient,
    private readonly config: ResolvedConfig,
  ) {}

  async create(opts: CreateSessionOptions): Promise<Session> {
    const data = await this.http.post<SessionData>(
      `/nest/${this.nestId}/sessions`,
      opts,
    );
    return new Session(data, this.nestId, this.http, this.config);
  }

  async list(opts?: ListSessionsOptions): Promise<Session[]> {
    const data = await this.http.get<SessionData[]>(
      `/nest/${this.nestId}/sessions`,
      opts as Record<string, string | number | boolean | undefined>,
    );
    return data.map((d) => new Session(d, this.nestId, this.http, this.config));
  }
}
