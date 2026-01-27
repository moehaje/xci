import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Job, Step, Workflow } from "./types.js";

type WorkflowYaml = {
  name?: string;
  on?: string | string[] | Record<string, unknown>;
  jobs?: Record<string, JobYaml>;
};

type JobYaml = {
  name?: string;
  needs?: string | string[];
  "runs-on"?: string | string[];
  steps?: StepYaml[];
  if?: string;
  env?: Record<string, string>;
  strategy?: {
    matrix?: Record<string, unknown>;
  };
};

type StepYaml = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
};

export function parseWorkflow(workflowPath: string): Workflow {
  const raw = fs.readFileSync(workflowPath, "utf-8");
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length > 0) {
    const error = doc.errors[0];
    const line = error.linePos?.[0]?.line ?? 0;
    const col = error.linePos?.[0]?.col ?? 0;
    throw new Error(`${workflowPath}:${line}:${col} ${error.message}`);
  }

  const parsed = doc.toJSON() as WorkflowYaml;

  const jobs = Object.entries(parsed?.jobs ?? {}).map(([jobId, job]) =>
    parseJob(jobId, job)
  );

  return {
    id: workflowPath,
    name: String(parsed?.name ?? path.basename(workflowPath)),
    path: workflowPath,
    events: parseWorkflowEvents(parsed?.on),
    jobs
  };
}

function parseJob(jobId: string, job: JobYaml): Job {
  const steps = (job.steps ?? []).map((step, index) =>
    parseStep(jobId, step, index)
  );

  return {
    id: jobId,
    name: job.name ?? jobId,
    needs: normalizeNeeds(job.needs),
    runsOn: normalizeRunsOn(job["runs-on"]),
    steps,
    if: job.if,
    strategy: job.strategy?.matrix ? { matrix: job.strategy.matrix } : undefined,
    env: job.env
  };
}

function parseStep(jobId: string, step: StepYaml, index: number): Step {
  const fallbackName = step.uses ?? step.run ?? `Step ${index + 1}`;
  return {
    id: `${jobId}-step-${index + 1}`,
    name: step.name ?? fallbackName,
    uses: step.uses,
    run: step.run,
    if: step.if,
    env: step.env
  };
}

function normalizeNeeds(needs?: string | string[]): string[] {
  if (!needs) {
    return [];
  }
  return Array.isArray(needs) ? needs : [needs];
}

function normalizeRunsOn(runsOn?: string | string[]): string | undefined {
  if (!runsOn) {
    return undefined;
  }
  return Array.isArray(runsOn) ? runsOn.join(", ") : runsOn;
}

function parseWorkflowEvents(
  trigger: WorkflowYaml["on"]
): string[] {
  if (!trigger) {
    return [];
  }
  if (typeof trigger === "string") {
    return [trigger];
  }
  if (Array.isArray(trigger)) {
    return trigger.map((value) => String(value));
  }
  return Object.keys(trigger);
}
