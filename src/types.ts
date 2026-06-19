export type NestStatus =
  | "creating"
  | "running"
  | "stopped"
  | "suspended"
  | "deleting"
  | "deleted"
  | "error";

export type NestTemplate =
  | "ubuntu-24-dev"
  | "ubuntu-dev"
  | "ubuntu-noble-langs"
  | "ubuntu-2604-v01"
  | "ubuntu-latest-twe-v01";

export type SessionStatus = "running" | "exited" | "killed" | "lost" | "idle";

export type PreviewAuth = "private" | "public";

export type FsKind = "file" | "dir";

export interface User {
  id: string;
  email: string;
}

export interface AuthStartRequest {
  client?: string;
  hostname?: string;
}

export interface AuthStartResponse {
  login_url: string;
  device_code: string;
  expires_in: number;
}

export interface AuthPollResponse {
  status: "pending" | "approved";
  api_key?: string;
  user?: User;
}

export interface NestData {
  id: string;
  user_id: string;
  name: string;
  template: string;
  status: NestStatus;
  repo_url?: string;
  error_message?: string;
  sleep_source?: string;
  lifecycle_error?: string;
  last_activity_at?: string;
  last_wake_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateNestOptions {
  name: string;
  template?: NestTemplate;
  repo_url?: string;
}

export interface WakeOptions {
  reason?: string;
}

export interface WakeResponse {
  nest_id?: string;
  from?: string;
  to?: string;
  path?: string;
  reason?: string;
  duration_ms?: number;
}

export interface NestLifecycle {
  nest_id?: string;
  status?: string;
  sleep_source?: string;
  last_activity_at?: string;
  last_wake_at?: string;
  lifecycle_error?: string;
}

export interface CreateSessionOptions {
  tty: boolean;
  argv: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface ListSessionsOptions {
  all?: boolean;
  history?: boolean;
}

export interface SessionData {
  id?: number;
  nest_id?: string;
  tty?: boolean;
  command?: string;
  cwd?: string;
  status?: SessionStatus;
  attached?: number;
  started_at?: string;
  last_activity_at?: string;
  exit_code?: number;
  ended_at?: string;
  attach_url?: string;
}

export interface KillSessionOptions {
  signal?: string;
  grace_ms?: number;
}

export interface CreatePreviewOptions {
  port: number;
  auth?: PreviewAuth;
  public?: boolean;
  name?: string;
}

export interface PreviewData {
  id?: string;
  nest_id?: string;
  name?: string;
  port?: number;
  auth?: PreviewAuth;
  public?: boolean;
  url?: string;
  path_url?: string;
  created_at?: string;
  expires_at?: string;
  revoked_at?: string;
  expires_in?: number;
}

export interface CreateSnapshotOptions {
  name?: string;
  description?: string;
  stop_if_running?: boolean;
}

export interface SnapshotData {
  id?: string;
  nest_id?: string;
  user_id?: string;
  name?: string;
  description?: string;
  state?: string;
  template_id?: string;
  logical_dirty_bytes?: number;
  apparent_bytes?: number;
  physical_bytes?: number;
  reclaimable_bytes?: number;
  reclaimable_status?: string;
  index_status?: string;
  created_at?: string;
}

export interface SnapshotList {
  nest_id?: string;
  snapshots?: SnapshotData[];
}

export interface RestoreResponse {
  nest_id?: string;
  restored_from?: string;
  status?: string;
  message?: string;
}

export interface ForkOptions {
  name: string;
  stop_if_running?: boolean;
  restart_source?: boolean;
}

export interface ForkResponse {
  id?: string;
  name?: string;
  source_nest_id?: string;
  status?: string;
  template_id?: string;
  source_restarted?: boolean;
  source_restart_error?: string;
  storage?: {
    copy_method?: string;
    physical_bytes_added_now?: number;
  };
}

export interface DeleteSnapshotOptions {
  dry_run?: boolean;
}

export interface DeleteSnapshotResponse {
  snapshot_id?: string;
  can_delete?: boolean;
  would_free_bytes?: number;
  would_remain_shared_bytes?: number;
  reclaimable_status?: string;
  blocked_by?: string[];
  deleted?: boolean;
}

export interface HoldOptions {
  ttl?: string;
  reason?: string;
  source?: string;
}

export interface KeepaliveHoldData {
  nest_id?: string;
  name?: string;
  source?: string;
  reason?: string;
  expires_at?: string;
  last_heartbeat_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ReadFileResult {
  data: Buffer;
  kind: FsKind;
}
