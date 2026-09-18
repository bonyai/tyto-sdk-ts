import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as grpc from "@grpc/grpc-js";

import { InvalidRequestError, JobRunNotFoundError, JobScheduleNotFoundError } from "../src/errors.js";
import { Disposition, JobRunAction, JobRunStatus, type JobSpec } from "../src/jobs.js";
import { makeClient, makeFakeTransport, RpcFailure } from "./fakes.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env["BONYA_API_KEY"] = "secret-api";
  delete process.env["BONYA_ENDPOINT"];
  delete process.env["BONYA_ORGANIZATION_ID"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("runJob", () => {
  it("requires exactly one sandbox target", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    await expect(client.runJob({ cmd: ["echo", "hi"] })).rejects.toThrow(InvalidRequestError);
    await expect(
      client.runJob({ existingSandboxId: "sbx-1", newSandbox: { template: "ubuntu" }, cmd: ["echo", "hi"] }),
    ).rejects.toThrow(InvalidRequestError);
    client.close();
  });

  it("requires exactly one command form", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    await expect(client.runJob({ existingSandboxId: "sbx-1" })).rejects.toThrow(InvalidRequestError);
    await expect(
      client.runJob({
        existingSandboxId: "sbx-1",
        cmd: ["echo", "hi"],
        script: { body: Buffer.from("echo hi") },
      }),
    ).rejects.toThrow(InvalidRequestError);
    client.close();
  });

  it("sends the spec and maps the result", async () => {
    const transport = makeFakeTransport();
    transport.tapi.jobRun = {
      runId: "run-42",
      status: 2,
      sandboxId: "sbx-1",
      createdSandbox: true,
      result: { exitCode: 0, stdout: Buffer.from("hello") },
      availableActions: [2 /* RERUN */],
    };
    const client = makeClient(transport);

    const run = await client.runJob({ newSandbox: { template: "ubuntu" }, cmd: ["echo", "hello"] });

    expect(run.runId).toBe("run-42");
    expect(run.status).toBe(JobRunStatus.COMPLETED);
    expect(run.sandboxId).toBe("sbx-1");
    expect(run.createdSandbox).toBe(true);
    expect(run.result?.stdout.toString()).toBe("hello");
    expect(run.availableActions).toEqual([JobRunAction.RERUN]);
    expect(transport.tapi.runJobRequests[0].spec.newSandbox.template.templateId).toBe("ubuntu");
    expect(transport.tapi.runJobRequests[0].idempotencyKey).toBeTruthy();
    client.close();
  });

  it("defaults disposition to delete and accepts keep", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    await client.runJob({ existingSandboxId: "sbx-1", cmd: ["echo", "hi"] });
    expect(transport.tapi.runJobRequests[0].spec.disposition).toBe(1 /* DELETE */);

    await client.runJob({ existingSandboxId: "sbx-1", cmd: ["echo", "hi"], disposition: Disposition.KEEP });
    expect(transport.tapi.runJobRequests[1].spec.disposition).toBe(2 /* KEEP */);

    client.close();
  });
});

describe("startJob", () => {
  it("returns the run id immediately", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    const { runId, alreadyRunning } = await client.startJob({ existingSandboxId: "sbx-1", cmd: ["sleep", "30"] });

    expect(runId).toBe("run-1");
    expect(alreadyRunning).toBe(false);
    expect(transport.tapi.startJobRequests).toHaveLength(1);
    client.close();
  });
});

describe("getJobRun", () => {
  it("returns detail with spec and timeline", async () => {
    const transport = makeFakeTransport();
    transport.tapi.jobRunDetail = {
      run: { runId: "run-1", status: 3 /* FAILED */ },
      spec: { existingSandboxId: "sbx-1", cmd: ["false"] },
      timeline: [{ name: "ExecCommand", status: 4 /* FAILED */ }],
    };
    const client = makeClient(transport);

    const detail = await client.getJobRun("run-1");

    expect(detail.status).toBe(JobRunStatus.FAILED);
    expect(detail.spec?.existingSandboxId).toBe("sbx-1");
    expect(detail.timeline).toHaveLength(1);
    expect(detail.timeline[0]?.name).toBe("ExecCommand");
    client.close();
  });

  it("maps NOT_FOUND to JobRunNotFoundError", async () => {
    const transport = makeFakeTransport();
    transport.tapi.getJobRunErrors.push(new RpcFailure(grpc.status.NOT_FOUND, "run missing"));
    const client = makeClient(transport);

    await expect(client.getJobRun("run-missing")).rejects.toThrow(JobRunNotFoundError);
    client.close();
  });
});

describe("cancelJobRun", () => {
  it("calls CancelJobRun", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    await client.cancelJobRun("run-1");
    expect(transport.tapi.cancelJobRunErrors.isEmpty()).toBe(true);
    client.close();
  });
});

describe("listJobRuns", () => {
  it("maps fields across the page", async () => {
    const transport = makeFakeTransport();
    transport.tapi.jobRuns = [
      { runId: "run-1", status: 1 /* RUNNING */ },
      { runId: "run-2", status: 2 /* COMPLETED */ },
    ];
    const client = makeClient(transport);

    const runs = [];
    for await (const run of client.listJobRuns()) {
      runs.push(run);
    }

    expect(runs.map((r) => r.runId)).toEqual(["run-1", "run-2"]);
    expect(runs[1]?.status).toBe(JobRunStatus.COMPLETED);
    client.close();
  });
});

describe("createJobSchedule", () => {
  const job: JobSpec = { existingSandboxId: "sbx-1", cmd: ["echo", "hi"] };

  it("requires exactly one timing field", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    await expect(client.createJobSchedule({}, job)).rejects.toThrow(InvalidRequestError);
    await expect(
      client.createJobSchedule({ cronExpressions: ["* * * * *"], intervalSeconds: 60 }, job),
    ).rejects.toThrow(InvalidRequestError);
    client.close();
  });

  it("sends schedule and job", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    const schedule = await client.createJobSchedule({ intervalSeconds: 3600 }, job);

    expect(schedule.scheduleId).toBe("sched-1");
    expect(transport.tapi.createJobScheduleRequests[0].schedule.intervalSeconds).toBe(3600);
    expect(transport.tapi.createJobScheduleRequests[0].idempotencyKey).toBeTruthy();
    client.close();
  });
});

describe("getJobSchedule", () => {
  it("maps NOT_FOUND to JobScheduleNotFoundError", async () => {
    const transport = makeFakeTransport();
    transport.tapi.getJobScheduleErrors.push(new RpcFailure(grpc.status.NOT_FOUND, "schedule missing"));
    const client = makeClient(transport);

    await expect(client.getJobSchedule("sched-missing")).rejects.toThrow(JobScheduleNotFoundError);
    client.close();
  });
});

describe("updateJobSchedule", () => {
  it("sends the full replacement", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    await client.updateJobSchedule("sched-1", { intervalSeconds: 7200 }, {
      existingSandboxId: "sbx-1",
      cmd: ["echo", "v2"],
    });

    expect(transport.tapi.updateJobScheduleRequests[0].schedule.intervalSeconds).toBe(7200);
    client.close();
  });
});

describe("setJobSchedulePaused", () => {
  it("pauses and records a note", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);

    const schedule = await client.setJobSchedulePaused("sched-1", true, { note: "pausing for maintenance" });

    expect(schedule.paused).toBe(true);
    expect(schedule.note).toBe("pausing for maintenance");
    client.close();
  });
});

describe("triggerJobSchedule and deleteJobSchedule", () => {
  it("both succeed", async () => {
    const transport = makeFakeTransport();
    const client = makeClient(transport);
    await client.triggerJobSchedule("sched-1");
    await client.deleteJobSchedule("sched-1");
    client.close();
  });
});

describe("listJobSchedules", () => {
  it("maps fields across the page", async () => {
    const transport = makeFakeTransport();
    transport.tapi.jobSchedules = [
      { scheduleId: "sched-1", paused: false },
      { scheduleId: "sched-2", paused: true },
    ];
    const client = makeClient(transport);

    const schedules = [];
    for await (const schedule of client.listJobSchedules()) {
      schedules.push(schedule);
    }

    expect(schedules.map((s) => s.scheduleId)).toEqual(["sched-1", "sched-2"]);
    expect(schedules[1]?.paused).toBe(true);
    client.close();
  });
});
