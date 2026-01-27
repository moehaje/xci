import crypto from "node:crypto";
import { Job, RunPlan, RunPreset, Workflow } from "./types.js";

export type PlanInput = {
  workflow: Workflow;
  jobIds: string[];
  eventName: string;
  eventPayloadPath?: string;
  preset?: RunPreset;
  matrixOverride?: string[];
};

export function buildRunPlan(input: PlanInput): RunPlan {
  const runId = createRunId();
  const jobs = input.jobIds.map((jobId) => ({
    jobId,
    matrix: input.matrixOverride ?? null,
    engineArgs: []
  }));

  return {
    runId,
    workflow: input.workflow,
    jobs,
    event: {
      name: input.eventName,
      payloadPath: input.eventPayloadPath
    },
    preset: input.preset
  };
}

export function expandJobIdsWithNeeds(workflow: Workflow, selected: string[]): string[] {
  const jobMap = new Map(workflow.jobs.map((job) => [job.id, job]));
  const expanded = new Set<string>();

  const visit = (jobId: string): void => {
    if (expanded.has(jobId)) {
      return;
    }
    const job = jobMap.get(jobId);
    if (!job) {
      return;
    }
    job.needs.forEach(visit);
    expanded.add(jobId);
  };

  selected.forEach(visit);
  return Array.from(expanded);
}

export function sortJobsByNeeds(workflow: Workflow, jobIds: string[]): string[] {
  const jobMap = new Map(workflow.jobs.map((job) => [job.id, job]));
  const inDegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>();

  jobIds.forEach((jobId) => {
    inDegree.set(jobId, 0);
    edges.set(jobId, new Set());
  });

  jobIds.forEach((jobId) => {
    const job = jobMap.get(jobId);
    if (!job) {
      return;
    }
    job.needs.forEach((need) => {
      if (!inDegree.has(need)) {
        return;
      }
      inDegree.set(jobId, (inDegree.get(jobId) ?? 0) + 1);
      edges.get(need)?.add(jobId);
    });
  });

  const queue: string[] = [];
  for (const [jobId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(jobId);
    }
  }

  const ordered: string[] = [];
  while (queue.length > 0) {
    const jobId = queue.shift();
    if (!jobId) {
      continue;
    }
    ordered.push(jobId);
    for (const next of edges.get(jobId) ?? []) {
      const degree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, degree);
      if (degree === 0) {
        queue.push(next);
      }
    }
  }

  const missing = jobIds.filter((jobId) => !ordered.includes(jobId));
  return ordered.concat(missing);
}

export function filterJobsForEvent(jobs: Job[], eventName: string): Job[] {
  if (eventName === "pull_request") {
    return jobs;
  }
  return jobs.filter((job) => !isPullRequestOnly(job));
}

function isPullRequestOnly(job: Job): boolean {
  if (!job.if) {
    return false;
  }
  return job.if.includes("pull_request");
}

function createRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").split(".")[0];
  const random = crypto.randomBytes(3).toString("hex");
  return `${stamp}-${random}`;
}
