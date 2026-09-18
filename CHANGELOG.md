# Changelog

All notable changes to `@bonya-ai/tyto` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-18

Initial release. The public surface documented in the README is stable within
`1.x`.

### Added

- **Sandboxes** — create (with an optional display name and optional
  `template`, which defaults to the deployment's configured default template
  if omitted), get by id or name, list with state and name filters, delete,
  and resume.
- **Exec** — buffered and streaming, with TTY support and streaming stdin.
- **Managed sessions** — named TTY sessions that outlive the client connection,
  survive suspend/resume, and replay bounded output on reattach.
- **Filesystem** — read, write, upload, download, list, stat, mkdir, remove,
  and move.
- **Previews** — publish a guest port at an HTTPS URL, in token or public mode,
  with a single-use browser entry point for token mode.
- **Snapshots** — create from a running sandbox, and delete.
- **Jobs** — `runJob`, `startJob`, `getJobRun`, `listJobRuns`, `cancelJobRun`,
  and job schedules (`createJobSchedule`, `getJobSchedule`,
  `listJobSchedules`, `updateJobSchedule`, `setJobSchedulePaused`,
  `triggerJobSchedule`, `deleteJobSchedule`) — managed, optionally scheduled
  runs of a command or script on a new or existing sandbox. New error types
  `JobRunNotFoundError` and `JobScheduleNotFoundError`.
- **Templates** — `listTemplates()` lists the deployment's template catalog.
- **Organization context** — per-client selection of which organization a call
  acts in, defaulting to the caller's personal organization.
- Every operation is a flat method directly on `Tyto` or `Sandbox` — there is
  no collection/namespace type to navigate.
- `SessionExistsError`. `SessionExists` remains as a deprecated alias for the
  same class; it will be removed in 2.0.
- An `examples/` directory with runnable programs for each capability:
  quickstart, streaming exec, files, managed sessions, previews, and snapshots.
- A `LICENSE` file (MIT), continuous integration, and a `make check` target
  that runs the same checks CI does.

### Notes

- Vendored protobuf/gRPC stubs are generated against the current
  `buf.build/bonya/tyto` schema. `host.proto` no longer exists upstream (its
  `TemplateBinding`/`NetworkPolicy` moved into `common.proto`); this is
  internal only, since the generated `host.ts` module was never part of the
  public API.
- The default endpoint is `https://api.tyto.run`. Set `BONYA_ENDPOINT` to
  point at a self-hosted deployment.
