import { InvalidRequestError } from "./errors.js";
import {
  TApiJobRunAction,
  TApiJobRunStatus,
  TApiJobRunTimelineStatus,
  TApiSandboxDisposition,
  TApiScheduleAction,
  TApiScheduleOverlap,
  type TApiJobRun,
  type TApiJobRunDetail,
  type TApiJobRunTimelineEntry,
  type TApiJobResult,
  type TApiJobSandboxSpec,
  type TApiJobSchedule,
  type TApiJobScriptSpec,
  type TApiJobSpec,
  type TApiScheduleSpec,
} from "./proto/tyto/runtime/v1/tapi.js";

/** What happens to a sandbox a job created once the run ends. Not meaningful for an existing sandbox. */
export enum Disposition {
  /** Delete the job-created sandbox once the run ends. This is the default. */
  DELETE = "delete",
  /** Leave the job-created sandbox in place once the run ends. */
  KEEP = "keep",
}

const DISPOSITION_TO_PROTO: Record<Disposition, TApiSandboxDisposition> = {
  [Disposition.DELETE]: TApiSandboxDisposition.TAPI_SANDBOX_DISPOSITION_DELETE,
  [Disposition.KEEP]: TApiSandboxDisposition.TAPI_SANDBOX_DISPOSITION_KEEP,
};

const DISPOSITION_FROM_PROTO = new Map<TApiSandboxDisposition, Disposition>([
  [TApiSandboxDisposition.TAPI_SANDBOX_DISPOSITION_DELETE, Disposition.DELETE],
  [TApiSandboxDisposition.TAPI_SANDBOX_DISPOSITION_KEEP, Disposition.KEEP],
]);

export enum JobRunStatus {
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELED = "canceled",
  TIMED_OUT = "timed_out",
  TERMINATED = "terminated",
}

const JOB_RUN_STATUS_FROM_PROTO = new Map<TApiJobRunStatus, JobRunStatus>([
  [TApiJobRunStatus.TAPI_JOB_RUN_STATUS_RUNNING, JobRunStatus.RUNNING],
  [TApiJobRunStatus.TAPI_JOB_RUN_STATUS_COMPLETED, JobRunStatus.COMPLETED],
  [TApiJobRunStatus.TAPI_JOB_RUN_STATUS_FAILED, JobRunStatus.FAILED],
  [TApiJobRunStatus.TAPI_JOB_RUN_STATUS_CANCELED, JobRunStatus.CANCELED],
  [TApiJobRunStatus.TAPI_JOB_RUN_STATUS_TIMED_OUT, JobRunStatus.TIMED_OUT],
  [TApiJobRunStatus.TAPI_JOB_RUN_STATUS_TERMINATED, JobRunStatus.TERMINATED],
]);

/** Something the caller may do to a job run right now, computed server-side. */
export enum JobRunAction {
  CANCEL = "cancel",
  RERUN = "rerun",
  RETRY = "retry",
  DELETE = "delete",
  DELETE_SANDBOX = "delete_sandbox",
}

const JOB_RUN_ACTION_FROM_PROTO = new Map<TApiJobRunAction, JobRunAction>([
  [TApiJobRunAction.TAPI_JOB_RUN_ACTION_CANCEL, JobRunAction.CANCEL],
  [TApiJobRunAction.TAPI_JOB_RUN_ACTION_RERUN, JobRunAction.RERUN],
  [TApiJobRunAction.TAPI_JOB_RUN_ACTION_RETRY, JobRunAction.RETRY],
  [TApiJobRunAction.TAPI_JOB_RUN_ACTION_DELETE, JobRunAction.DELETE],
  [TApiJobRunAction.TAPI_JOB_RUN_ACTION_DELETE_SANDBOX, JobRunAction.DELETE_SANDBOX],
]);

export enum JobRunTimelineStatus {
  SCHEDULED = "scheduled",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELED = "canceled",
}

const JOB_RUN_TIMELINE_STATUS_FROM_PROTO = new Map<TApiJobRunTimelineStatus, JobRunTimelineStatus>([
  [TApiJobRunTimelineStatus.TAPI_JOB_RUN_TIMELINE_STATUS_SCHEDULED, JobRunTimelineStatus.SCHEDULED],
  [TApiJobRunTimelineStatus.TAPI_JOB_RUN_TIMELINE_STATUS_RUNNING, JobRunTimelineStatus.RUNNING],
  [TApiJobRunTimelineStatus.TAPI_JOB_RUN_TIMELINE_STATUS_COMPLETED, JobRunTimelineStatus.COMPLETED],
  [TApiJobRunTimelineStatus.TAPI_JOB_RUN_TIMELINE_STATUS_FAILED, JobRunTimelineStatus.FAILED],
  [TApiJobRunTimelineStatus.TAPI_JOB_RUN_TIMELINE_STATUS_CANCELED, JobRunTimelineStatus.CANCELED],
]);

/** What a schedule fire does when the previous run from the same schedule is still going. */
export enum ScheduleOverlap {
  /** Drop the new fire. This is the default. */
  SKIP = "skip",
  /** Queue at most one fire to run after the current one finishes. */
  BUFFER_ONE = "buffer_one",
  /** Let fires run concurrently without limit. */
  ALLOW_ALL = "allow_all",
}

const SCHEDULE_OVERLAP_TO_PROTO: Record<ScheduleOverlap, TApiScheduleOverlap> = {
  [ScheduleOverlap.SKIP]: TApiScheduleOverlap.TAPI_SCHEDULE_OVERLAP_SKIP,
  [ScheduleOverlap.BUFFER_ONE]: TApiScheduleOverlap.TAPI_SCHEDULE_OVERLAP_BUFFER_ONE,
  [ScheduleOverlap.ALLOW_ALL]: TApiScheduleOverlap.TAPI_SCHEDULE_OVERLAP_ALLOW_ALL,
};

const SCHEDULE_OVERLAP_FROM_PROTO = new Map<TApiScheduleOverlap, ScheduleOverlap>([
  [TApiScheduleOverlap.TAPI_SCHEDULE_OVERLAP_SKIP, ScheduleOverlap.SKIP],
  [TApiScheduleOverlap.TAPI_SCHEDULE_OVERLAP_BUFFER_ONE, ScheduleOverlap.BUFFER_ONE],
  [TApiScheduleOverlap.TAPI_SCHEDULE_OVERLAP_ALLOW_ALL, ScheduleOverlap.ALLOW_ALL],
]);

/** Something the caller may do to a job schedule right now, computed server-side. */
export enum ScheduleAction {
  PAUSE = "pause",
  RESUME = "resume",
  TRIGGER = "trigger",
  UPDATE = "update",
  DELETE = "delete",
}

const SCHEDULE_ACTION_FROM_PROTO = new Map<TApiScheduleAction, ScheduleAction>([
  [TApiScheduleAction.TAPI_SCHEDULE_ACTION_PAUSE, ScheduleAction.PAUSE],
  [TApiScheduleAction.TAPI_SCHEDULE_ACTION_RESUME, ScheduleAction.RESUME],
  [TApiScheduleAction.TAPI_SCHEDULE_ACTION_TRIGGER, ScheduleAction.TRIGGER],
  [TApiScheduleAction.TAPI_SCHEDULE_ACTION_UPDATE, ScheduleAction.UPDATE],
  [TApiScheduleAction.TAPI_SCHEDULE_ACTION_DELETE, ScheduleAction.DELETE],
]);

/** A script to run inline instead of `cmd`. */
export interface JobScriptSpec {
  body: Buffer;
  interpreter?: string;
  args?: readonly string[];
  filename?: string;
}

/** A new sandbox for a job to create, in place of targeting an existing one. */
export interface JobSandboxSpec {
  template: string;
  version?: string;
  name?: string;
}

/**
 * A job's definition: what to run, and where. Exactly one of
 * `existingSandboxId`/`newSandbox` is required, and exactly one of
 * `cmd`/`script` is required.
 */
export interface JobSpec {
  existingSandboxId?: string;
  newSandbox?: JobSandboxSpec;
  cmd?: readonly string[];
  script?: JobScriptSpec;
  /** Runs after the sandbox is ready and before cmd/script. A non-zero exit stops the job. */
  preRunScript?: JobScriptSpec;
  env?: Readonly<Record<string, string>>;
  path?: string;
  stdin?: Buffer;
  commandTimeoutSeconds?: number;
  runDeadlineSeconds?: number;
  maxOutputBytes?: number;
  /** Defaults to Disposition.DELETE. Not meaningful for existingSandboxId. */
  disposition?: Disposition;
  /** Applies to existingSandboxId only. Defaults to false. */
  resumeIfSuspended?: boolean;
  name?: string;
}

export interface JobResult {
  readonly exitCode: number;
  readonly signaled: boolean;
  readonly signal: number;
  readonly timedOut: boolean;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

/**
 * A job run's status and outcome, without its stored spec or timeline.
 * getJobRun returns the fuller JobRunDetail; listJobRuns returns this.
 */
export interface JobRun {
  readonly runId: string;
  readonly status: JobRunStatus;
  readonly sandboxId: string;
  readonly createdSandbox: boolean;
  readonly scheduleId: string;
  readonly startedAtUnixNanos: number;
  readonly finishedAtUnixNanos: number;
  readonly result: JobResult | undefined;
  readonly failure: string;
  readonly cleanupFailed: boolean;
  readonly availableActions: readonly JobRunAction[];
  readonly name: string;
}

export interface JobRunTimelineEntry {
  readonly name: string;
  readonly status: JobRunTimelineStatus;
  readonly attempt: number;
  readonly startedAtUnixNanos: number;
  readonly finishedAtUnixNanos: number;
  readonly failure: string;
}

/** Adds the stored spec and activity timeline to JobRun. Only getJobRun returns this. */
export interface JobRunDetail extends JobRun {
  readonly spec: JobSpec | undefined;
  readonly timeline: readonly JobRunTimelineEntry[];
}

/**
 * A job schedule's timing. Exactly one of `cronExpressions`,
 * `intervalSeconds`, and `runAtUnixNanos` is required.
 */
export interface ScheduleSpec {
  cronExpressions?: readonly string[];
  intervalSeconds?: number;
  /** One-shot: a single future calendar time. Refused if in the past. */
  runAtUnixNanos?: number;
  /** IANA zone, e.g. "US/Pacific". Empty is UTC. */
  timeZone?: string;
  jitterSeconds?: number;
  overlap?: ScheduleOverlap;
  paused?: boolean;
}

/** A durable cron, interval, or one-shot trigger for a job. */
export interface JobSchedule {
  readonly scheduleId: string;
  readonly schedule: ScheduleSpec | undefined;
  readonly spec: JobSpec | undefined;
  readonly paused: boolean;
  readonly note: string;
  readonly nextRunAtUnixNanos: number;
  readonly oneShot: boolean;
  readonly remainingActions: number;
  readonly availableActions: readonly ScheduleAction[];
  readonly createdAtUnixNanos: number;
  readonly updatedAtUnixNanos: number;
  readonly numActions: number;
  readonly numActionsSkippedOverlap: number;
  readonly numActionsMissedCatchupWindow: number;
  readonly recentRunIds: readonly string[];
  readonly runningRunIds: readonly string[];
}

export function jobSpecToProto(spec: JobSpec): TApiJobSpec {
  const hasExisting = Boolean(spec.existingSandboxId);
  const hasNew = spec.newSandbox !== undefined;
  if (hasExisting && hasNew) {
    throw new InvalidRequestError("exactly one of existingSandboxId and newSandbox is required, not both");
  }
  if (!hasExisting && !hasNew) {
    throw new InvalidRequestError("exactly one of existingSandboxId and newSandbox is required");
  }
  const hasCmd = Boolean(spec.cmd && spec.cmd.length > 0);
  const hasScript = spec.script !== undefined;
  if (hasCmd && hasScript) {
    throw new InvalidRequestError("exactly one of cmd and script is required, not both");
  }
  if (!hasCmd && !hasScript) {
    throw new InvalidRequestError("exactly one of cmd and script is required");
  }
  const disposition = DISPOSITION_TO_PROTO[spec.disposition ?? Disposition.DELETE];
  if (disposition === undefined) {
    throw new InvalidRequestError("disposition must be a valid Disposition value");
  }

  return {
    existingSandboxId: spec.existingSandboxId ?? "",
    newSandbox: spec.newSandbox ? jobSandboxSpecToProto(spec.newSandbox) : undefined,
    cmd: spec.cmd ? [...spec.cmd] : [],
    script: spec.script ? jobScriptSpecToProto(spec.script) : undefined,
    preRunScript: spec.preRunScript ? jobScriptSpecToProto(spec.preRunScript) : undefined,
    env: { ...(spec.env ?? {}) },
    path: spec.path ?? "",
    stdin: spec.stdin ?? Buffer.alloc(0),
    commandTimeoutSeconds: spec.commandTimeoutSeconds ?? 0,
    runDeadlineSeconds: spec.runDeadlineSeconds ?? 0,
    maxOutputBytes: spec.maxOutputBytes ?? 0,
    disposition,
    resumeIfSuspended: spec.resumeIfSuspended ?? false,
    name: spec.name ?? "",
  };
}

function jobSandboxSpecToProto(spec: JobSandboxSpec): TApiJobSandboxSpec {
  return {
    template: { templateId: spec.template, version: spec.version ?? "", digest: "" },
    network: undefined,
    name: spec.name ?? "",
  };
}

function jobScriptSpecToProto(spec: JobScriptSpec): TApiJobScriptSpec {
  return {
    body: spec.body,
    interpreter: spec.interpreter ?? "",
    args: spec.args ? [...spec.args] : [],
    filename: spec.filename ?? "",
  };
}

export function jobSpecFromProto(spec: TApiJobSpec | undefined): JobSpec | undefined {
  if (!spec) {
    return undefined;
  }
  return {
    existingSandboxId: spec.existingSandboxId || undefined,
    newSandbox: spec.newSandbox
      ? {
          template: spec.newSandbox.template?.templateId ?? "",
          version: spec.newSandbox.template?.version ?? "",
          name: spec.newSandbox.name ?? "",
        }
      : undefined,
    cmd: spec.cmd && spec.cmd.length > 0 ? spec.cmd : undefined,
    script: spec.script ? jobScriptSpecFromProto(spec.script) : undefined,
    preRunScript: spec.preRunScript ? jobScriptSpecFromProto(spec.preRunScript) : undefined,
    env: spec.env && Object.keys(spec.env).length > 0 ? spec.env : undefined,
    path: spec.path ?? "",
    stdin: spec.stdin,
    commandTimeoutSeconds: spec.commandTimeoutSeconds ?? 0,
    runDeadlineSeconds: spec.runDeadlineSeconds ?? 0,
    maxOutputBytes: spec.maxOutputBytes ?? 0,
    disposition: DISPOSITION_FROM_PROTO.get(spec.disposition) ?? Disposition.DELETE,
    resumeIfSuspended: spec.resumeIfSuspended ?? false,
    name: spec.name ?? "",
  };
}

function jobScriptSpecFromProto(spec: TApiJobScriptSpec): JobScriptSpec {
  return {
    body: spec.body,
    interpreter: spec.interpreter ?? "",
    args: spec.args ?? [],
    filename: spec.filename ?? "",
  };
}

function jobResultFromProto(result: TApiJobResult | undefined): JobResult | undefined {
  if (!result) {
    return undefined;
  }
  return {
    exitCode: result.exitCode ?? 0,
    signaled: result.signaled ?? false,
    signal: result.signal ?? 0,
    timedOut: result.timedOut ?? false,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    stdoutTruncated: result.stdoutTruncated ?? false,
    stderrTruncated: result.stderrTruncated ?? false,
  };
}

export function jobRunFromProto(run: TApiJobRun): JobRun {
  return {
    runId: run.runId ?? "",
    status: JOB_RUN_STATUS_FROM_PROTO.get(run.status) ?? JobRunStatus.RUNNING,
    sandboxId: run.sandboxId ?? "",
    createdSandbox: run.createdSandbox ?? false,
    scheduleId: run.scheduleId ?? "",
    startedAtUnixNanos: Number(run.startedAtUnixNanos ?? 0),
    finishedAtUnixNanos: Number(run.finishedAtUnixNanos ?? 0),
    result: jobResultFromProto(run.result),
    failure: run.failure ?? "",
    cleanupFailed: run.cleanupFailed ?? false,
    availableActions: (run.availableActions ?? [])
      .map((a) => JOB_RUN_ACTION_FROM_PROTO.get(a))
      .filter((a): a is JobRunAction => a !== undefined),
    name: run.name ?? "",
  };
}

function jobRunTimelineFromProto(entries: readonly TApiJobRunTimelineEntry[]): JobRunTimelineEntry[] {
  return entries.map((e) => ({
    name: e.name ?? "",
    status: JOB_RUN_TIMELINE_STATUS_FROM_PROTO.get(e.status) ?? JobRunTimelineStatus.SCHEDULED,
    attempt: e.attempt ?? 0,
    startedAtUnixNanos: Number(e.startedAtUnixNanos ?? 0),
    finishedAtUnixNanos: Number(e.finishedAtUnixNanos ?? 0),
    failure: e.failure ?? "",
  }));
}

export function jobRunDetailFromProto(detail: TApiJobRunDetail): JobRunDetail {
  if (!detail.run) {
    throw new InvalidRequestError("GetJobRun response is missing run");
  }
  const run = jobRunFromProto(detail.run);
  return {
    ...run,
    spec: jobSpecFromProto(detail.spec),
    timeline: jobRunTimelineFromProto(detail.timeline ?? []),
  };
}

export function scheduleSpecToProto(spec: ScheduleSpec): TApiScheduleSpec {
  const setCount = [spec.cronExpressions?.length, spec.intervalSeconds, spec.runAtUnixNanos].filter(
    (value) => value !== undefined && value !== 0 && !(Array.isArray(value) && value.length === 0),
  ).length;
  if (setCount !== 1) {
    throw new InvalidRequestError("exactly one of cronExpressions, intervalSeconds, and runAtUnixNanos is required");
  }
  const overlap = SCHEDULE_OVERLAP_TO_PROTO[spec.overlap ?? ScheduleOverlap.SKIP];
  if (overlap === undefined) {
    throw new InvalidRequestError("overlap must be a valid ScheduleOverlap value");
  }
  return {
    cronExpressions: spec.cronExpressions ? [...spec.cronExpressions] : [],
    intervalSeconds: spec.intervalSeconds ?? 0,
    runAtUnixNanos: spec.runAtUnixNanos ?? 0,
    timeZone: spec.timeZone ?? "",
    jitterSeconds: spec.jitterSeconds ?? 0,
    overlap,
    paused: spec.paused ?? false,
  };
}

function scheduleSpecFromProto(spec: TApiScheduleSpec | undefined): ScheduleSpec | undefined {
  if (!spec) {
    return undefined;
  }
  return {
    cronExpressions: spec.cronExpressions && spec.cronExpressions.length > 0 ? spec.cronExpressions : undefined,
    intervalSeconds: spec.intervalSeconds || undefined,
    runAtUnixNanos: spec.runAtUnixNanos ? Number(spec.runAtUnixNanos) : undefined,
    timeZone: spec.timeZone ?? "",
    jitterSeconds: spec.jitterSeconds ?? 0,
    overlap: SCHEDULE_OVERLAP_FROM_PROTO.get(spec.overlap) ?? ScheduleOverlap.SKIP,
    paused: spec.paused ?? false,
  };
}

export function jobScheduleFromProto(schedule: TApiJobSchedule): JobSchedule {
  return {
    scheduleId: schedule.scheduleId ?? "",
    schedule: scheduleSpecFromProto(schedule.schedule),
    spec: jobSpecFromProto(schedule.spec),
    paused: schedule.paused ?? false,
    note: schedule.note ?? "",
    nextRunAtUnixNanos: Number(schedule.nextRunAtUnixNanos ?? 0),
    oneShot: schedule.oneShot ?? false,
    remainingActions: schedule.remainingActions ?? 0,
    availableActions: (schedule.availableActions ?? [])
      .map((a) => SCHEDULE_ACTION_FROM_PROTO.get(a))
      .filter((a): a is ScheduleAction => a !== undefined),
    createdAtUnixNanos: Number(schedule.createdAtUnixNanos ?? 0),
    updatedAtUnixNanos: Number(schedule.updatedAtUnixNanos ?? 0),
    numActions: schedule.numActions ?? 0,
    numActionsSkippedOverlap: schedule.numActionsSkippedOverlap ?? 0,
    numActionsMissedCatchupWindow: schedule.numActionsMissedCatchupWindow ?? 0,
    recentRunIds: schedule.recentRunIds ?? [],
    runningRunIds: schedule.runningRunIds ?? [],
  };
}
