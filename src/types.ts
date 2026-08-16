/** Sandbox creation wait mode. */
export enum Wait {
  READY = "ready",
  NONE = "none",
}

/** Sandbox lifecycle status, as last observed by the client. */
export enum Status {
  CREATING = "creating",
  RUNNING = "running",
  SUSPENDING = "suspending",
  SUSPENDED = "suspended",
  RESUMING = "resuming",
  FAILED = "failed",
  DELETED = "deleted",
}

/** A chunk of stdout produced by an Exec or session process. */
export class Stdout {
  readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
}

/** A chunk of stderr produced by an Exec process (never emitted in TTY mode). */
export class Stderr {
  readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
}

/** The terminal event of an Exec or session process. */
export class Exit {
  readonly exitCode: number;
  readonly signaled: boolean;
  readonly signal: number;

  constructor(exitCode: number, signaled = false, signal = 0) {
    this.exitCode = exitCode;
    this.signaled = signaled;
    this.signal = signal;
  }

  get ok(): boolean {
    return this.exitCode === 0 && !this.signaled;
  }
}

export type ExecEvent = Stdout | Stderr | Exit;
