import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EngineAdapter, EngineCapabilities, EngineContext, EngineRunResult } from "../../core/engine.js";
import { JobRun, RunPlan, RunRecord } from "../../core/types.js";
import { RunStore } from "../../store/runStore.js";

export class ActAdapter implements EngineAdapter {
  readonly id = "act";

  capabilities(): EngineCapabilities {
    return {
      matrix: true,
      artifacts: true,
      eventPayloads: true,
      services: true
    };
  }

  async plan(context: EngineContext, plan: RunPlan): Promise<RunPlan> {
    const plannedJobs = plan.jobs.map((job) => ({
      ...job,
      engineArgs: buildActArgs(context, job.jobId, job.matrix ?? null)
    }));

    return {
      ...plan,
      jobs: plannedJobs
    };
  }

  async run(plan: RunPlan, context: EngineContext): Promise<EngineRunResult> {
    if (plan.jobs.length === 0) {
      return { exitCode: 1, logsPath: "" };
    }

    const job = plan.jobs[0];
    const store = new RunStore(path.join(context.repoRoot, ".xci", "runs"));
    const runDir = store.createRunDir(plan.runId);
    const artifactsDir = store.createArtifactsDir(plan.runId);
    const logsPath = store.createLogFile(plan.runId, job.jobId);
    const eventPath = ensureEventPayload(plan.event.name, context.eventPayloadPath, runDir);

    const engineArgs = buildActArgs(
      {
        ...context,
        eventPayloadPath: eventPath,
        artifactDir: artifactsDir
      },
      job.jobId,
      job.matrix ?? null
    );

    const runRecord = createRunRecord(plan, artifactsDir, path.dirname(logsPath));
    const jobRun = runRecord.jobs[0];
    store.writeRun(runRecord);

    const logStream = fs.createWriteStream(logsPath, { flags: "a" });
    const exitCode = await runAct(engineArgs, context.repoRoot, logStream, context.onOutput);

    finalizeRunRecord(runRecord, jobRun, exitCode);
    store.writeRun(runRecord);

    return { exitCode, logsPath };
  }
}

function buildActArgs(
  context: EngineContext,
  jobId: string,
  matrix: Record<string, unknown> | null
): string[] {
  const args = ["act", context.eventName, "--workflows", context.workflowsPath, "--job", jobId];

  if (context.eventPayloadPath) {
    args.push("--eventpath", context.eventPayloadPath);
  }

  if (matrix) {
    args.push("--matrix", JSON.stringify(matrix));
  }

  if (context.artifactDir) {
    args.push("--artifact-dir", context.artifactDir);
  }

  if (context.containerArchitecture) {
    args.push("--container-architecture", context.containerArchitecture);
  }

  for (const [key, value] of Object.entries(context.platformMap ?? {})) {
    args.push("--platform", `${key}=${value}`);
  }

  if (context.extraArgs?.length) {
    args.push(...context.extraArgs);
  }

  return args;
}

function ensureEventPayload(eventName: string, eventPath: string | undefined, runDir: string): string {
  if (eventPath && fs.existsSync(eventPath)) {
    return eventPath;
  }

  const payload = buildEventPayload(eventName);
  const outPath = path.join(runDir, "event.json");
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

function buildEventPayload(eventName: string): Record<string, unknown> {
  const repo = { full_name: "local/local", name: "local", owner: { login: "local" } };
  switch (eventName) {
    case "pull_request":
      return {
        action: "opened",
        repository: repo,
        pull_request: {
          number: 1,
          head: { ref: "local" },
          base: { ref: "main" }
        }
      };
    case "workflow_dispatch":
      return { repository: repo, inputs: {} };
    case "push":
    default:
      return { ref: "refs/heads/main", repository: repo };
  }
}

function createRunRecord(plan: RunPlan, artifactDir: string, logDir: string): RunRecord {
  const now = new Date().toISOString();
  return {
    id: plan.runId,
    workflowId: plan.workflow.id,
    event: plan.event,
    status: "running",
    createdAt: now,
    jobs: [
      {
        jobId: plan.jobs[0].jobId,
        status: "running",
        startedAt: now,
        matrix: plan.jobs[0].matrix ?? null
      }
    ],
    artifactDir,
    logDir
  };
}

function finalizeRunRecord(run: RunRecord, jobRun: JobRun, exitCode: number): void {
  const finishedAt = new Date().toISOString();
  const status = exitCode === 0 ? "success" : "failed";
  const durationMs = new Date(finishedAt).getTime() - new Date(jobRun.startedAt ?? finishedAt).getTime();
  jobRun.status = status;
  jobRun.exitCode = exitCode;
  jobRun.finishedAt = finishedAt;
  jobRun.durationMs = durationMs;
  run.status = status;
  run.finishedAt = finishedAt;
}

function runAct(
  args: string[],
  cwd: string,
  logStream: fs.WriteStream,
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void
): Promise<number> {
  return new Promise((resolve) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command, commandArgs, { cwd, env: process.env });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      logStream.write(text);
      if (onOutput) {
        onOutput(text, "stdout");
      } else {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      logStream.write(text);
      if (onOutput) {
        onOutput(text, "stderr");
      } else {
        process.stderr.write(text);
      }
    });

    child.on("close", (code) => {
      logStream.end();
      resolve(code ?? 1);
    });
  });
}
