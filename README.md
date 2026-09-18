# Tyto TypeScript SDK

Run code in a fast, isolated sandbox — from TypeScript or JavaScript.

[![npm](https://img.shields.io/npm/v/@bonya-ai/tyto)](https://www.npmjs.com/package/@bonya-ai/tyto)
[![Node](https://img.shields.io/node/v/@bonya-ai/tyto)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```bash
npm install @bonya-ai/tyto
```

```ts
import { Tyto } from "@bonya-ai/tyto";

const client = new Tyto();                                   // reads BONYA_API_KEY
const sandbox = await client.createSandbox({ template: "bonya-dev" });

const result = await sandbox.exec(["echo", "hello"], { check: true });
console.log(result.stdout);                                   // hello

await sandbox.delete();
client.close();
```

That is a real VM: it boots in about a second, runs anything Linux runs, and is
gone when `delete` resolves.

The npm package is `@bonya-ai/tyto`. It ships ESM with bundled type
declarations, and the public surface documented here is stable within `1.x`.

> **Node only.** The transport is gRPC over `@grpc/grpc-js`, which needs
> Node's `http2`. This package does not run in a browser or on edge runtimes.

## Contents

- [Install](#install)
- [Configuration](#configuration)
- [What you can do](#what-you-can-do)
- [Create sandboxes](#create-sandboxes)
- [Get and list](#get-and-list)
- [Delete and cleanup](#delete-and-cleanup)
- [Resume](#resume)
- [Buffered exec](#buffered-exec)
- [Streaming exec](#streaming-exec)
- [TTY exec](#tty-exec)
- [Managed console sessions](#managed-console-sessions)
- [Files](#files)
- [Jobs](#jobs)
- [Job schedules](#job-schedules)
- [Templates](#templates)
- [Preview URLs](#preview-urls)
- [Snapshots](#snapshots)
- [Organizations](#organizations-1)
- [Error model](#error-model)
- [Troubleshooting](#troubleshooting)
- [Examples](#examples)
- [Development](#development)

## What you can do

| I want to… | Call |
| --- | --- |
| Start a sandbox | `client.createSandbox({ template })` |
| Reconnect to one | `client.getSandbox(id)` / `.getSandboxByName(name)` |
| Find my sandboxes | `client.listSandboxes()` |
| Run a command | `sandbox.exec(cmd)` |
| Watch output as it happens | `sandbox.execStream(cmd)` |
| Keep a terminal alive across reconnects | `sandbox.createSession(...)` / `.attachSession(...)` |
| Read and write files | `sandbox.readFile/writeFile/uploadFile/downloadFile/...` |
| Expose a port to a browser | `sandbox.createPreview(port)` |
| Save state for later | `sandbox.snapshot()` |
| Pause and resume | suspend is automatic; `sandbox.resume()` is explicit |
| Run a job to completion | `client.runJob(spec)` |
| Start a job and check on it later | `client.startJob(spec)` / `client.getJobRun(runId)` |
| Run something on a schedule | `client.createJobSchedule(schedule, spec)` |
| See which templates are available | `client.listTemplates()` |
| See which organizations I belong to | `client.listOrganizations()` |
| Act in a specific organization | `client.organizationId = id`, or `organizationId` at construction |

Every operation is a flat method: `client.createSandbox(...)`,
`client.getSandbox(id)`, `client.listSandboxes()`, `client.deleteSandbox(id)`,
`client.resumeSandbox(id)` on `Tyto`; `sandbox.createSession(...)`,
`sandbox.attachSession(...)`, `sandbox.createPreview(port)`,
`sandbox.snapshot()`, and the file methods (`readFile`, `writeFile`, ...)
directly on `Sandbox`. There is no separate namespace to navigate.

Client-level convenience forms also exist for sandbox-scoped operations when
all you have is an id — `client.createSession(sandboxId, name, cmd)`,
`client.listSessions(sandboxId)`, `client.killSession(sandboxId, name)`,
`client.attachSession(sandboxId, name)`, `client.createPreview(sandboxId, port)`,
`client.listPreviews(sandboxId)`, `client.deletePreview(sandboxId, id)`,
`client.createSnapshot(sandboxId)`, `client.deleteSnapshot(sandboxId, snapshotId)`
— each does a `getSandbox()` first and then delegates to the `Sandbox` method
of the same name, which costs one extra round trip compared to already
holding the handle. Prefer `sandbox.createSession(...)` (or the equivalent)
directly when a `Sandbox` is already in hand, such as right after
`createSandbox()`; reach for the client-level form when all you have is an
id.

## Install

```bash
npm install @bonya-ai/tyto
```

Requires Node 18 or newer.

## Configuration

Every setting has an environment-variable fallback, so the common case needs no
options at all:

```bash
export BONYA_API_KEY=byk_...
```

```ts
const client = new Tyto();
```

| Option | Environment variable | Default |
| --- | --- | --- |
| `apiKey` | `BONYA_API_KEY` | *required* |
| `organizationId` | `BONYA_ORGANIZATION_ID` | your personal organization |
| `caBundle` | `BONYA_CA_BUNDLE` | system trust store |
| `timeout` | — | `30` (seconds) |
| `maxRetries` | — | `2` |
| `filesystemReadLimit` | — | 64 MiB |

```ts
const client = new Tyto({
  apiKey: process.env.BONYA_API_KEY,
  organizationId: process.env.BONYA_ORGANIZATION_ID,
  timeout: 30,
});
```

`apiKey` is required.

`caBundle` points to a PEM bundle used for private development CAs. If the file
cannot be read, the constructor throws `InvalidRequestError`.

`timeout` is the default per-operation deadline, in seconds. It must be
positive. Buffered and streaming exec calls can override it per call.

`maxRetries` controls SDK retries for retryable control-plane operations. It
must be non-negative. The SDK retries gRPC `UNAVAILABLE` for create, get, list,
delete, resume, snapshot create, and snapshot delete while preserving the same
request and idempotency key where one exists. Exec calls are not retried, except
for one capability refresh when the SDK can prove an exec capability token is
expired before responses start. Filesystem calls are not retried on transport
unavailability; they may refresh a rejected filesystem capability once.

`filesystemReadLimit` caps bytes buffered by `sandbox.readFile()`. It must be
a non-negative integer and defaults to 64 MiB.

Close clients when done — the process will not exit while channels are open:

```ts
const client = new Tyto();
try {
  const sandbox = await client.createSandbox({ template: "bonya-dev" });
  // ...
} finally {
  client.close();
}
```

### Organizations

`organizationId` selects which organization the client's calls act on. When
omitted, the server resolves the call against your **personal organization** —
the deterministic fallback every account has. An API key belongs to a user, not
to an organization, so one key works across every organization you belong to;
`organizationId` is how you say which one a given call means.

`client.listOrganizations()` returns every organization the caller belongs
to, including their personal one — see [Organizations](#organizations-1) for
the full method and the fields it returns. `organizationId` is also a
settable property: assigning to it changes which organization subsequent
calls run against, effective immediately, and rejects an empty value the
same way the constructor option does.

The REST equivalent is the `X-Bonya-Organization-ID` header. The SDK sends it as
`bonya-organization-id` metadata on control-plane calls only. Exec, filesystem,
and session calls go straight to the sandbox and are authorized by its
capability token, so they carry no organization context.

An empty value is an error rather than a silent fallback: `organizationId: ""`,
or `BONYA_ORGANIZATION_ID` set to an empty string, throws
`InvalidRequestError`. In CI this variable is usually written as an expansion of
another one, and quietly running every job against someone's personal
organization is a worse outcome than failing at startup.

Naming an organization you do not belong to is a not-found error, identical to
naming one that does not exist.

**In CI, always set it explicitly:**

```yaml
# .github/workflows/integration.yml
env:
  BONYA_API_KEY: ${{ secrets.BONYA_API_KEY }}
  BONYA_ORGANIZATION_ID: ${{ vars.BONYA_ORGANIZATION_ID }}
```

```ts
// Both values come from the environment; neither is defaulted away.
const client = new Tyto();
```

## Create Sandboxes

```typescript
import { Tyto, Wait } from "@bonya-ai/tyto";

const client = new Tyto()  // reads BONYA_API_KEY;
const sandbox = await client.createSandbox({
  template: "bonya-dev",
  wait: Wait.READY,
  idempotencyKey: "create-job-123",
});
```

`client.createSandbox(options)` returns a `Promise<Sandbox>`.

Options:

- `template: string` is required and must be non-empty.
- `version?: string` uses the server's default template version when
  omitted.
- `wait?: Wait | "ready" | "none"` controls when create resolves. Defaults to
  `Wait.READY`.
- `idempotencyKey?: string` is sent to the service. If omitted, the SDK
  generates one and reuses it for create transport retries.

Wait modes:

- `Wait.READY` or `"ready"` asks the service to return a running sandbox. The
  returned handle has `lastObservedStatus === Status.RUNNING`.
- `Wait.NONE` or `"none"` returns after the service accepts the request. The
  returned handle has `lastObservedStatus === Status.CREATING`.

If create exhausts its deadline, the SDK throws `SandboxCreationTimeoutError`.
The error carries the create `idempotencyKey` so you can decide whether to
retry or inspect server state.

Sandbox fields:

```typescript
console.log(sandbox.id);
console.log(sandbox.operationId);
console.log(sandbox.template);
console.log(sandbox.version);
console.log(sandbox.lastObservedStatus);
```

## Get And List

Reconnect to an existing sandbox by ID:

```typescript
const sandbox = await client.getSandbox("sbx_123");
const result = await sandbox.exec("printf reconnected", { check: true });
console.log(result.stdout);
```

`get(sandboxId)` requires a non-empty ID and returns a usable `Sandbox`
handle. It does not explicitly resume the sandbox. Exec and filesystem
operations are the user activity that wakes a suspended sandbox when the
service route supports automatic wake. If a capability is rejected because it
expired, the SDK refreshes the handle with `get()` once before retrying the
operation.

List sandboxes lazily:

```typescript
import { Status } from "@bonya-ai/tyto";

for await (const summary of client.listSandboxes({ states: [Status.RUNNING, Status.SUSPENDED], limit: 20 })) {
  console.log(summary.id, summary.lastObservedStatus);
}
```

`list(options)` returns an `AsyncIterableIterator<SandboxSummary>`. It pages
as you iterate. `limit: 0` yields nothing without an RPC.

Supported state filters are:

- `Status.CREATING`
- `Status.RUNNING`
- `Status.SUSPENDING`
- `Status.SUSPENDED`
- `Status.RESUMING`
- `Status.FAILED`

`Status.DELETED` is not a valid list filter.

`SandboxSummary` contains `id`, `operationId`, `template`, `version`,
`lastObservedStatus`, `failureCode`, and `failureMessage`. Summaries do not
include Exec credentials and cannot run `exec`; call `get(summary.id)` for a
usable sandbox handle.

## Delete And Cleanup

```typescript
const result = await sandbox.delete();
console.log(result.sandboxId);
console.log(result.alreadyDeleted);
```

`sandbox.delete()` returns `DeleteResult { sandboxId: string, alreadyDeleted:
boolean }`. Calling it again on the same `Sandbox` object is local and
idempotent: the second call returns `alreadyDeleted: true` without another
RPC.

There is no automatic cleanup on scope exit; use `try`/`finally`:

```typescript
const sandbox = await client.createSandbox({ template: "bonya-dev" });
try {
  await sandbox.exec("printf work", { check: true });
} finally {
  await sandbox.delete();
}
```

## Resume

Use `resume()` when you want to explicitly resume before running work:

```typescript
const resume = await sandbox.resume({ idempotencyKey: "resume-job-123" });
console.log(resume.sandboxId);
console.log(resume.lifecycleOperationId);
console.log(resume.alreadyRunning);

const result = await sandbox.exec(["printf", "running\n"], { check: true });
```

`sandbox.resume(options)` returns `ResumeResult { sandboxId: string,
lifecycleOperationId: string, alreadyRunning: boolean }`. It updates the
sandbox's private Exec endpoint and capability when the service returns
fresh values, and sets `lastObservedStatus` to `Status.RUNNING`.

`idempotencyKey` is optional. If omitted, the SDK generates one and reuses it
for resume transport retries. On ambiguous connection failure, the thrown
error carries the idempotency key and the sandbox's local status/capability
are left unchanged.

`resume()` on a failed sandbox throws `SandboxFailedError` locally before an
RPC.

Automatic wake is different from explicit resume: `get()` does not call
`resume()`, and ordinary Exec/filesystem calls do not make a public
`ResumeSandbox` RPC from the SDK. They use the sandbox's guest endpoint; the
service may wake the sandbox behind that route.

## Buffered Exec

Use `exec()` for commands with bounded output:

```typescript
const result = await sandbox.exec(["python3", "-c", "import os; print(os.environ['MODE'])"], {
  env: { MODE: "development" },
  cwd: "/workspace",
  timeout: 10,
});

console.log(result.stdout);
console.log(result.stderr);
console.log(result.exitCode);
console.log(result.ok);
```

Signature:

```typescript
sandbox.exec(command, {
  env,
  cwd,
  tty,
  cols,
  rows,
  timeout,
  check,
  input,
}): Promise<ExecResult>
```

Commands can be either:

- `string`: executed as `["/bin/sh", "-c", command]`; the string must be
  non-empty.
- `readonly string[]`: executed directly; the array must be non-empty and
  cannot contain empty entries.

`env` overlays string environment variables. Keys must be non-empty strings
and cannot contain `=` or NUL. Values must be strings without NUL.

`cwd` sets the remote working directory. It must be a non-empty string
without NUL. When omitted, the service uses its default working directory.

`input` can be a `string`, a `Uint8Array`, or omitted. Strings are encoded as
UTF-8. The SDK writes the bytes to stdin and half-closes stdin before
collecting output. Buffered `input` requires `tty: false`.

`exec()` returns `ExecResult`:

```typescript
result.stdoutBytes; // Uint8Array
result.stderrBytes; // Uint8Array
result.stdout; // UTF-8 text (getter over stdoutBytes)
result.stderr; // UTF-8 text (getter over stderrBytes)
result.exitCode; // number
result.signaled; // boolean
result.signal; // number
result.ok; // exitCode === 0 && !signaled
result.toString(); // result.stdout
```

`check: true` calls `result.check()` before returning. If the command exits
non-zero or by signal, it throws `ExecFailedError`; the original result is
available as `error.result`.

```typescript
import { ExecFailedError } from "@bonya-ai/tyto";

try {
  await sandbox.exec(["false"], { check: true });
} catch (error) {
  if (error instanceof ExecFailedError) {
    console.log(error.result.exitCode);
  }
}
```

`exec()` buffers stdout and stderr in client memory. Use `execStream()` for
large output, long-running commands, interactive stdin, or cancellation.

## Streaming Exec

Use `execStream()` when you need events as they arrive:

```typescript
import { Exit, Stderr, Stdout } from "@bonya-ai/tyto";

const session = sandbox.execStream(["bash", "-lc", "echo out; echo err >&2"]);
try {
  for await (const event of session) {
    if (event instanceof Stdout) {
      process.stdout.write(Buffer.from(event.data).toString("utf-8"));
    } else if (event instanceof Stderr) {
      process.stderr.write(Buffer.from(event.data).toString("utf-8"));
    } else if (event instanceof Exit) {
      console.log("exit:", event.exitCode);
    }
  }
} finally {
  session.close();
}
```

Signature:

```typescript
sandbox.execStream(command, { env, cwd, tty, cols, rows, timeout })
```

The command, `env`, `cwd`, `tty`, `cols`, `rows`, and `timeout` rules are the
same as buffered Exec. `execStream()` returns a session that is an async
iterable of `Stdout`, `Stderr`, and `Exit` events.

Write streaming stdin as bytes:

```typescript
const session = sandbox.execStream(["cat"]);
session.write(new TextEncoder().encode("hello\n"));
session.closeStdin();

for await (const event of session) {
  if (event instanceof Stdout) {
    process.stdout.write(Buffer.from(event.data).toString("utf-8"));
  }
}
```

`session.write(data)` accepts a `Uint8Array` and throws
`InvalidRequestError` after the session or stdin is closed.
`session.closeStdin()` is idempotent. `session.cancel()` is idempotent and
sends a cancel frame when possible. `session.close()` cancels an unfinished
session.

The SDK keeps bounded request and response queues internally. If iteration
reaches the session deadline before receiving the next event, the SDK
cancels the remote Exec and throws `TimeoutError`.

## TTY Exec

Set `tty: true` for terminal semantics:

```typescript
const result = await sandbox.exec(["bash", "-lc", "stty size; printf done"], { tty: true, check: true });
console.log(result.stdout);
// result.stderrBytes.length === 0
```

In TTY mode stdout and stderr share the terminal stream. The SDK returns
terminal output as stdout and leaves stderr empty. Streaming TTY sessions
emit `Stdout` events for terminal output; they do not emit separate `Stderr`
events for the terminal stream.

Default TTY dimensions are 80 columns by 24 rows. On the wire the SDK sends
`cols: 0, rows: 0` when you omit both dimensions; the guest runtime
interprets that pair as 80x24.

Provide explicit dimensions by passing both `cols` and `rows`:

```typescript
const session = sandbox.execStream(["bash"], { tty: true, cols: 120, rows: 40 });
session.write(new TextEncoder().encode("printf 'ready\\n'\n"));
session.resize({ cols: 100, rows: 30 });
session.closeStdin();
for await (const event of session) {
  // ...
}
```

TTY rules:

- `cols` and `rows` must be provided together.
- Each dimension must be an integer from 1 through 512.
- Dimensions require `tty: true`.
- Buffered `input` is not allowed with `tty: true`; use `execStream()` and
  `session.write(...)`.
- `session.resize({ cols, rows })` requires a TTY session, open stdin, and an
  unfinished session.

## Managed Console Sessions

Every `Sandbox` has flat methods (`createSession`, `listSessions`,
`killSession`, `attachSession`) for named, persistent command sessions that
outlive the client connection. This is different from `execStream()`: an
Exec process dies when its stream closes, but a managed session keeps
running detached, and you can reattach later — even after the sandbox
warm-suspends and resumes — and replay what it produced while nobody was
watching.

```typescript
const info = await sandbox.createSession("server", ["bash"], { cols: 120, rows: 40 });
console.log(info.name, info.status);

const session = await sandbox.attachSession("server");
session.write(new TextEncoder().encode("npm run dev\n"));
session.resize({ cols: 140, rows: 45 });
for await (const event of session) {
  // ...
}
session.detach();

const list = await sandbox.listSessions();
for (const info of list) {
  console.log(info.name, info.status);
}

await sandbox.killSession("server");
```

### Create

```typescript
sandbox.createSession(name, command, { env, cwd, cols, rows, replace })
```

`name` must match `^[a-z][a-z0-9-]{0,31}$`. `command` is a non-empty array
of non-empty strings — there is no shell-string convenience like buffered
`exec()`'s. `cols`/`rows` are `0` (server default) or an integer from `1`
through `512`.

Creating over an existing record throws `SessionExistsError` unless
`replace: true`, and even then only a terminal record (exited, killed, or
failed) is replaced. A running or attached session is never replaced by
`create()`; kill it first.

Returns a `Promise<SessionInfo>`.

### List

```typescript
const list = await sandbox.listSessions();
for (const info of list) {
  console.log(info.name, info.status);
}
console.log(list.sandboxSuspended);
```

`sandbox.listSessions()` returns a `SessionList`: an immutable, iterable
sequence of `SessionInfo` that also carries `sandboxSuspended: boolean`.
Listing works on a suspended sandbox without waking it; `sandboxSuspended:
true` marks a result served from the suspend-time snapshot rather than the
live guest.

### Attach

```typescript
const session = await sandbox.attachSession("server", { cols: 120, rows: 40, maxReplayBytes: 0 });
console.log(session.info.name, session.replayedBytes, session.historyDropped);

for await (const event of session) {
  // ...
}
```

`attach(name, { cols, rows, maxReplayBytes })` returns a `Promise<SessionStream>`
that resolves once the session is admitted. `session.info`,
`session.replayedBytes`, and `session.historyDropped` are populated
immediately when `attach()` resolves, before you iterate anything: they
describe the bounded replay the session accumulated while detached.
`replayedBytes > 0` means output produced while nobody was attached is being
replayed now; `historyDropped: true` means the 1 MiB replay ring dropped
some of the oldest of it. Attaching to a suspended sandbox's session wakes
it, the same way `execStream()` does.

Attaching preempts any other attached client for that session: the previous
stream receives a `SessionEnded(SessionEndedReason.TAKEOVER)` event and ends.
A reconnect is never blocked by a half-dead previous connection.

Iterating a `SessionStream` yields:

- `Stdout { data: Uint8Array }`: merged output. Sessions are TTY-only, so
  there is no separate stderr stream.
- `Exit { exitCode, signaled, signal }`: the process exited.
- `SessionEnded { reason: SessionEndedReason }`: the attach ended without the
  process exiting — `DETACHED` (you called `detach()`) or `TAKEOVER`
  (another client attached instead).
- `SessionOutputDropped { droppedBytes: number }`: live output was dropped
  because the client was reading too slowly. This does not end the attach.

`session.write(data: Uint8Array)` sends stdin. `session.resize({ cols, rows
})` takes an integer from `1` through `512` for each dimension, the same
rule as TTY Exec resize. `session.detach()` ends the attach gracefully
without touching the process. `session.close()` calls `detach()` if the
stream is still open.

### Kill

```typescript
await sandbox.killSession("server", { signal: "TERM", graceMs: 5000 });
```

Signals the session's process group (default `TERM`), escalating to
`SIGKILL` after `graceMs` if it has not exited. Returns a `Promise<SessionInfo>`,
but exit info is not guaranteed on that specific response: `kill()` signals
and returns without waiting for the guest to reap the process, so a `list()`
shortly afterward is the reliable way to observe the final exit code.
Killing an unknown name throws `SessionNotFoundError`.

### SessionInfo

```typescript
info.name; // string
info.command; // readonly string[]
info.workingDir; // string
info.status; // SessionStatus
info.attached; // boolean
info.startedAt; // Date
info.lastActivityAt; // Date
info.endedAt; // Date | undefined
info.exit; // Exit | undefined, set only once terminal
```

`SessionStatus` values are `UNSPECIFIED`, `STARTING`, `IDLE`, `ATTACHED`,
`EXITED`, `KILLED`, and `FAILED`.

### Suspend and resume

A session's process never blocks idle suspend by itself. Only an *attached*
stream does, for as long as it stays open; a quiet, detached session lets
the sandbox warm-suspend, and survives the resume with its process and
replay buffer intact — the same session, not a new one. Output from a
detached session still counts as activity and defers idle suspend while it
keeps producing it.

### Capability refresh

Session calls transparently reissue an expired capability and retry once,
the same way `execStream()` and the file methods (`readFile()`,
`writeFile()`, ...) do. Call `sandbox.reissueCapability()` directly only if
you manage tokens yourself.

## Files

File operations are flat methods directly on `Sandbox`:

```typescript
await sandbox.writeFile("/workspace/message.txt", "hello\n");
const payload = await sandbox.readFile("/workspace/message.txt");
console.log(Buffer.from(payload).toString("utf-8"));

await sandbox.uploadFile("local-input.bin", "/workspace/input.bin");
await sandbox.downloadFile("/workspace/input.bin", "local-output.bin");

const entries = await sandbox.listFiles("/workspace");
const info = await sandbox.statFile("/workspace/message.txt");

await sandbox.mkdirFile("/workspace/output");
await sandbox.moveFile("/workspace/message.txt", "/workspace/output/message.txt");
await sandbox.removeFile("/workspace/output", true);
```

Methods:

- `readFile(path: string): Promise<Uint8Array>`
- `writeFile(path: string, data: Uint8Array | string): Promise<void>`
- `uploadFile(localPath: string, remotePath: string): Promise<void>`
- `downloadFile(remotePath: string, localPath: string): Promise<void>`
- `listFiles(path: string): Promise<FileInfo[]>`
- `statFile(path: string): Promise<FileInfo>`
- `mkdirFile(path: string): Promise<void>`
- `removeFile(path: string, recursive?: boolean): Promise<void>`
- `moveFile(source: string, destination: string): Promise<void>`

Remote paths must be non-empty strings without NUL. The SDK accepts absolute
or relative remote paths and leaves interpretation to the guest runtime.

`readFile()` buffers the entire remote file in memory and returns bytes. It
throws `FilesystemLimitError` before exceeding `filesystemReadLimit`.

`writeFile()` accepts a `Uint8Array` or a string. Strings are encoded as
UTF-8. It streams the payload in 64 KiB chunks, writes through a guest-side
temporary file, and publishes it by replacing the final directory entry. The
final path is not followed when it is a symlink.

`uploadFile()` streams a local file to the remote path in 64 KiB chunks.
`downloadFile()` streams a remote file into a hidden temporary file in the
destination directory, fsyncs it, atomically replaces the destination with
`fs.rename`, and fsyncs the parent directory where supported. If a read or
write error happens before replacement, the temporary file is removed and
the previous destination is left unchanged.

`listFiles()` returns immediate children sorted by name. It returns a
complete array or throws; it does not return partial results after a remote
listing error.

`statFile()` returns lstat-style metadata. A final symlink is reported as a
symlink rather than followed.

`moveFile()` is same-filesystem, atomic, and no-overwrite. Cross-filesystem
moves throw `CrossFilesystemMoveError`; destination-exists errors throw
`RemoteFileExistsError`.

`removeFile(path, true)` removes directories recursively. Recursive remove
does not follow symlinks and is not atomic.

`FileInfo` is immutable:

```typescript
import { FileKind } from "@bonya-ai/tyto";

const info = await sandbox.statFile("/workspace/output/message.txt");
console.log(info.path);
console.log(info.name);
console.log(info.kind === FileKind.FILE);
console.log(info.size);
console.log(info.mode.toString(8));
console.log(info.modifiedAt); // Date
```

`FileKind` values are `FILE`, `DIRECTORY`, `SYMLINK`, and `OTHER`.

## Jobs

A job is a managed run of a command or script — on a new sandbox (created
and, by default, deleted for you) or an existing one.

```typescript
const run = await client.runJob({
  newSandbox: { template: "bonya-dev" },
  cmd: ["./run-tests.sh"],
});
console.log(run.status, run.result?.exitCode);
```

`runJob` blocks until the run finishes, bounded by the client's own timeout
— use it for short jobs. `startJob` returns immediately with a run id
instead:

```typescript
const { runId } = await client.startJob({
  existingSandboxId: "sbx-123",
  cmd: ["./long-migration.sh"],
});
// ... later ...
const detail = await client.getJobRun(runId);
console.log(detail.status, detail.spec, detail.timeline);
```

`JobSpec` requires exactly one of `existingSandboxId`/`newSandbox`, and
exactly one of `cmd`/`script`. `disposition` (`Disposition.DELETE`, the
default, or `Disposition.KEEP`) controls what happens to a sandbox the job
itself created once the run ends; it's not meaningful for
`existingSandboxId`.

`getJobRun` returns `JobRunDetail`, which adds the stored `spec` and an
activity `timeline` to the run summary `listJobRuns` returns. There is no
endpoint to edit a run in place: to "edit and rerun" one, fetch it with
`getJobRun`, change what you need on its `spec`, and pass that to `runJob`
or `startJob` as a new run.

```typescript
for await (const run of client.listJobRuns({ sandboxId: "sbx-123" })) {
  console.log(run.runId, run.status);
}
await client.cancelJobRun(runId); // requests cancellation; cleanup still runs
```

`cancelJobRun` cancels rather than terminates, so the run's own cleanup
(e.g. deleting a sandbox it created) still executes.

## Job Schedules

A schedule wraps a `JobSpec` with timing — cron, interval, or a one-shot
future time — so it runs without you calling `runJob` yourself.

```typescript
const schedule = await client.createJobSchedule(
  { intervalSeconds: 3600 },
  { newSandbox: { template: "bonya-dev" }, cmd: ["./nightly-report.sh"] },
);
console.log(schedule.scheduleId, schedule.nextRunAtUnixNanos);
```

`ScheduleSpec` requires exactly one of `cronExpressions`, `intervalSeconds`,
and `runAtUnixNanos` (a one-shot: a single future calendar time, refused if
in the past). `overlap` (default `ScheduleOverlap.SKIP`) controls what a
fire does when the previous run from the same schedule is still going.

```typescript
for await (const schedule of client.listJobSchedules()) {
  console.log(schedule.scheduleId);
}
const schedule = await client.getJobSchedule(scheduleId);

// updateJobSchedule replaces the whole schedule -- pass every field you
// want to keep, not just the one you're changing.
await client.updateJobSchedule(scheduleId, { intervalSeconds: 7200 }, jobSpec);

await client.setJobSchedulePaused(scheduleId, true, { note: "pausing for maintenance" });
await client.triggerJobSchedule(scheduleId); // fires one run now, ignoring timing
await client.deleteJobSchedule(scheduleId);
```

`JobSchedule.recentRunIds` holds the last 10 fires' run ids (oldest first,
including manual triggers), each a valid `getJobRun` id — so you can follow
a schedule straight to its recent runs without a separate `listJobRuns`
call.

## Templates

```typescript
const templates = await client.listTemplates();
for (const template of templates) {
  console.log(template.id, template.version, template.isDefault, template.metadata.os);
}
```

Lists every `templateId`/version `createSandbox` and `runJob` will accept,
with metadata (OS, installed language stacks, which AI agent CLIs are
preinstalled) to help pick one. Not paginated: the catalog is the same for
every caller. `createSandbox`'s `template` option may be omitted to use the
deployment's configured default template, if it has one.

## Preview URLs

A preview publishes one guest port at an HTTPS URL a browser can open. The
server must bind a port in 1024-65535; privileged ports are never
previewable, so a guest's ssh can't be handed out by accident.

```typescript
const preview = await sandbox.createPreview(3000, { name: "web" });
console.log(preview.url); // https://pv-<26 chars>.preview.tyto.run

await sandbox.listPreviews();
await sandbox.deletePreview(preview.id);
```

### Opening one in a browser

A token-mode preview needs the sandbox's capability, and a URL is not a safe
place to leave one. `previewBrowserUrl()` produces a single-use entry point:
the gateway validates the token, trades it for a host-scoped `HttpOnly`
cookie, and redirects to the same address without it, so no page is ever
rendered at a URL containing the credential.

```typescript
const url = sandbox.previewBrowserUrl(preview);
// open `url` in a browser
```

Open it once and let the cookie carry the session. **Do not share that URL**
— anyone who receives it holds the sandbox's data-plane capability until it
expires. It throws on a public preview, which has no token to exchange.

### Public previews

```typescript
import { PreviewAuth } from "@bonya-ai/tyto";

const publicPreview = await sandbox.createPreview(8080, { auth: PreviewAuth.PUBLIC });
```

`PUBLIC` means exactly that: anyone with the URL reaches the service, with no
credential. The only thing protecting it is the 26 random characters in the
hostname, so treat it as published to the internet. `TOKEN` is the default
and an omitted `auth` never yields a public URL.

### Capability upgrade

`create()` returns a fresh capability and the SDK stores it on the sandbox
automatically, because the preview scope is newer than the token a sandbox
is created with. A token minted before previews existed is otherwise valid
and will be refused by the preview ingress with a permission error that is
deliberately *not* a refresh signal.

If you are holding a capability elsewhere, refresh it explicitly:

```typescript
await sandbox.reissueCapability();
```

### Suspend and wake

Traffic to a preview URL wakes a suspended sandbox and the request is served
once it is running. An idle sandbox therefore costs nothing until a visitor
arrives. The first request after a suspend pays the resume latency; if it
takes too long you get `503` with `Retry-After`, and retrying is the right
move.

### Limitations

- **Bind to the interface, not localhost only.** A server listening solely on
  `127.0.0.1` inside the guest is reachable, but one bound to a specific
  non-loopback address may not be. `0.0.0.0` is the reliable choice.
- **Server-Sent Events reconnect.** An SSE stream is not an HTTP upgrade, so
  it is cut at the 120-second request cap. `EventSource` reconnects
  automatically; a long-lived stream that must not break should use a
  WebSocket.
- **WebSocket auth is cookie or bearer only.** WebSocket clients do not
  follow redirects, so the `?bonya_token=` exchange does not work for them.
  Open a normal page first to obtain the cookie, or send the capability as a
  bearer header.
- **A suspend cuts open connections.** Preview connections deliberately do
  not defer idle-suspend, so an open WebSocket does not keep a sandbox
  alive. The next request wakes it.

## Snapshots

Create a snapshot from a running sandbox:

```typescript
const snapshot = await sandbox.snapshot({ idempotencyKey: "snapshot-job-123" });
console.log(snapshot.id);
console.log(snapshot.sourceSandboxId);
```

`sandbox.snapshot(options)` returns `Promise<Snapshot>`. If `idempotencyKey`
is omitted, the SDK generates one and reuses it for snapshot create
transport retries. Using the same key for the same source sandbox returns
the same snapshot identity when the service accepts idempotent replay.

Snapshot create requires a running source sandbox. Locally deleted or
observed deleted sandboxes throw `SandboxDeletedError`; failed sandboxes
throw `SandboxFailedError`; suspended sandboxes throw
`SandboxSuspendedError`.

Delete snapshots when done:

```typescript
await snapshot.delete();
await snapshot.delete(); // local no-op
```

`snapshot.delete()` resolves to `void` and is idempotent on the same
`Snapshot` object. Snapshots can be deleted after deleting the source
sandbox handle. A snapshot has its own identifier and object lifetime does
not control remote snapshot retention.

## Organizations

An api key belongs to a user, not a single organization, so one key works
across every organization that user belongs to. Calls are scoped to whichever
organization is current on the client.

```typescript
const organizations = await client.listOrganizations();
for (const org of organizations) {
  console.log(org.id, org.name, org.personal, org.role);
}

client.organizationId = organizations[0].id;
```

`listOrganizations()` returns every organization the caller belongs to,
including their personal organization. `Organization.personal` marks that
one — it's the deterministic tenant an omitted organization context resolves
to, and every account has exactly one. TApi stores its name as the literal
string `"personal"`; render that however fits your UI rather than showing it
verbatim.

Assigning to `client.organizationId` changes which organization subsequent
calls run against, effective immediately. An empty value is rejected as an
`InvalidRequestError` rather than silently falling back to the personal
organization. To set it once at construction instead, pass `organizationId`
in the constructor options; reading `client.organizationId` back returns
whatever is currently in effect.

## Error Model

All SDK exceptions inherit from `TytoError`, which itself extends `Error`.

```typescript
import { TytoError } from "@bonya-ai/tyto";

try {
  await client.getSandbox("sbx_missing");
} catch (error) {
  if (error instanceof TytoError) {
    console.log(error.message);
    console.log(error.sandboxId);
    console.log(error.operationId);
    console.log(error.idempotencyKey);
  }
}
```

Public exceptions:

- `AuthenticationError`: invalid or rejected API key.
- `InvalidRequestError`: invalid local arguments or invalid service
  response.
- `SandboxNotFoundError`: sandbox missing, deleted, or not visible to the
  API key.
- `SandboxDeletedError`: operation cannot run because the sandbox is
  deleted.
- `SandboxSuspendedError`: operation reported a suspended sandbox.
- `SandboxBusyError`: service rejected a lifecycle operation as busy.
- `SandboxFailedError`: operation cannot run because the sandbox failed.
- `SandboxCreationFailedError`: create reached a failed terminal state.
- `SandboxCreationTimeoutError`: create deadline expired.
- `CapabilityRejectedError`: guest capability was rejected and could not be
  refreshed.
- `SessionExistsError`: `createSession()` targeted a name that already has a
  record and either no `replace: true` was given or the record is not
  terminal.
- `SessionNotFoundError`: `attachSession()` or `killSession()` named a
  session that does not exist.
- `JobRunNotFoundError`: `getJobRun()` or `cancelJobRun()` named a run that
  does not exist.
- `JobScheduleNotFoundError`: a job schedule call named a schedule that does
  not exist.
- `FilesystemError`: general filesystem failure.
- `RemoteFileNotFoundError`: remote file or directory missing.
- `RemoteFileExistsError`: remote destination already exists.
- `CrossFilesystemMoveError`: remote move crosses filesystems.
- `FilesystemLimitError`: client or service filesystem size/frame limit.
- `ExecFailedError`: `ExecResult.check()` or `check: true` saw a non-ok
  result.
- `TimeoutError`: operation deadline expired.
- `ConnectionError`: retryable transport failure exhausted retries.
- `ServiceError`: service or unexpected transport failure not covered
  above.

The SDK redacts API keys, capabilities, and selected operation identifiers
supplied to the error mapper from mapped service messages, and replaces
path-like substrings in those messages with `[redacted-path]`.

Examples:

```typescript
import { AuthenticationError, SandboxNotFoundError } from "@bonya-ai/tyto";

try {
  await client.getSandbox("sbx_123");
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.log("check BONYA_API_KEY");
  } else if (error instanceof SandboxNotFoundError) {
    console.log("sandbox does not exist or is not visible");
  } else {
    throw error;
  }
}
```

```typescript
import { FilesystemError, RemoteFileNotFoundError } from "@bonya-ai/tyto";

try {
  await sandbox.readFile("/workspace/missing.txt");
} catch (error) {
  if (error instanceof RemoteFileNotFoundError) {
    console.log("missing");
  } else if (error instanceof FilesystemError) {
    console.log("filesystem failed:", error.message);
  } else {
    throw error;
  }
}
```

```typescript
import { TimeoutError } from "@bonya-ai/tyto";

try {
  await sandbox.exec(["sleep", "60"], { timeout: 1 });
} catch (error) {
  if (error instanceof TimeoutError) {
    console.log("command timed out and was cancelled");
  } else {
    throw error;
  }
}
```

## Resource Ownership

Use `try`/`finally` for deterministic cleanup:

```typescript
const client = new Tyto()  // reads BONYA_API_KEY;
try {
  const sandbox = await client.createSandbox({ template: "bonya-dev" });
  try {
    const session = sandbox.execStream(["cat"]);
    try {
      session.write(new TextEncoder().encode("hello\n"));
      session.closeStdin();
      for await (const event of session) {
        // ...
      }
    } finally {
      session.close();
    }
  } finally {
    await sandbox.delete();
  }
} finally {
  client.close();
}
```

Ownership rules:

- `Tyto.close()` closes cached channels and is idempotent.
- `sandbox.delete()` affects the remote sandbox and updates the local handle
  to `Status.DELETED`. It is idempotent on the same `Sandbox` object.
- Closing an unfinished `execStream()` session cancels the remote Exec.
- Closing an unfinished `attachSession()` stream detaches the guest
  process rather than killing it; the process keeps running.
- `Snapshot.delete()` deletes the remote snapshot identity and is a local
  no-op when repeated on the same object.

For intentionally persistent sandboxes, do not delete on scope exit. Store
`sandbox.id`, close the client, and reconnect later with
`client.getSandbox`.

## Current Limitations

The current TypeScript SDK intentionally exposes only the merged public
surface, mirroring the Python SDK's scope:

- The package is ESM-only; see "Module format" above.
- There is no public `suspend()` method.
- There are no public networking, fork, template-engine, or multi-host APIs.
- Managed sessions are TTY-only; there is no non-TTY managed session mode.
- There is no `sandbox.console()` attach-or-create convenience yet, and no
  multi-attach or collaborative terminal mode — a new attach always
  preempts the previous one.
- `SandboxSummary` values are metadata only and cannot run Exec.
- Buffered Exec stores stdout and stderr in memory.
- `sandbox.readFile()` stores the full file in memory up to
  `filesystemReadLimit`.
- Filesystem writes, uploads, moves, mkdir, and removes are not retried
  after ambiguous transport errors.
- Remote filesystem path normalization, permissions, symlink traversal
  inside parent directories, and service-side file size limits are
  guest-runtime behavior, not TypeScript SDK behavior.
- Proto codegen sources from the Buf Schema Registry (`buf.build/bonya/tyto`)
  via `buf export` by default. Set `PROTO_DIR` to a local checkout of
  `compute/proto` to generate from unpublished proto changes instead, e.g.
  `PROTO_DIR=../../compute/proto npm run proto`.

## Troubleshooting

**`InvalidRequestError: api_key is required`**
Nothing supplied a key. Set `BONYA_API_KEY`, or pass `apiKey`. If you use the
`tyto` CLI, `tyto login` saves a key — but to a config file the SDK does not
read, so export it:

```bash
export BONYA_API_KEY=byk_...
```

**`AuthenticationError`**
The key reached the server and was rejected. It may be revoked.

**`InvalidRequestError: organization_id must be a non-empty string`**
`BONYA_ORGANIZATION_ID` is set but empty — usually an unset variable expanded in
CI. This is deliberately an error rather than a fallback to your personal
organization; see [Organizations](#organizations).

**The process does not exit**
Call `client.close()`. Open gRPC channels keep Node's event loop alive, so a
script that finishes its work but never closes the client hangs at the end.

**`SandboxNotFoundError` on a sandbox you just created**
Most often an organization mismatch: the sandbox was created in one organization
and looked up in another. Sandboxes are not visible across organizations, and a
sandbox in an organization you cannot see is reported the same way as one that
does not exist.

**`SandboxCreationTimeoutError`**
Create did not reach a running state before the deadline. The error carries the
`idempotencyKey` it used — retry `create()` with that same key to join the
original creation rather than starting a second sandbox.

**TLS/certificate errors against a private deployment**
Point `caBundle` (or `BONYA_CA_BUNDLE`) at the PEM bundle for your CA.

**`FilesystemLimitError` from `readFile()`**
The file is larger than `filesystemReadLimit` (64 MiB by default). Raise the
limit, or use `downloadFile()`, which streams to disk instead of buffering.

**A command hangs**
`exec()` buffers all output and resolves only when the process exits, so a
server or REPL never resolves. Use `execStream()`, or run it as a
[managed session](#managed-console-sessions).

**`Cannot find module` / bundler errors in a browser or edge runtime**
This package is Node-only: `@grpc/grpc-js` needs `http2`, which browsers and
most edge runtimes do not provide. Call the API from a Node server instead.

## Examples

Runnable programs are in [`examples/`](examples):

| File | Shows |
| --- | --- |
| [`quickstart.ts`](examples/quickstart.ts) | Create, exec, clean up |
| [`exec-streaming.ts`](examples/exec-streaming.ts) | Streaming output and stdin |
| [`files.ts`](examples/files.ts) | Read, write, upload, download, list |
| [`sessions.ts`](examples/sessions.ts) | Persistent terminals and replay |
| [`previews.ts`](examples/previews.ts) | Publishing a port to a browser |
| [`snapshots.ts`](examples/snapshots.ts) | Capturing sandbox state |

```bash
export BONYA_API_KEY=byk_...
npx tsx examples/quickstart.ts
```

## Development

```bash
make check      # typecheck + test, the same checks CI runs
make test
make typecheck  # covers src, tests, and examples
```

`npm run build` compiles `src/` to `dist/`. It sets `rootDir` to `src`, so
tests and examples cannot ride along with it — `npm run typecheck` uses
[`tsconfig.check.json`](tsconfig.check.json) to check all three together.

Regenerate the protobuf/gRPC code. By default this exports the protos from the
Buf Schema Registry, so no checkout of the `compute` repository is needed —
`buf` and `protoc` must be on `PATH`:

```bash
npm run proto
```

To generate against unpublished proto changes instead, point at a local
checkout:

```bash
PROTO_DIR=../../compute/proto npm run proto
```

## See also

- [Go SDK](../go) · [Python SDK](../python)
- [`tyto` CLI](../../cli) — the same API from a terminal
