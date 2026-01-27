export type Workflow = {
  id: string;
  name: string;
  path: string;
  jobs: Job[];
};

export type Job = {
  id: string;
  name: string;
  needs: string[];
  runsOn?: string;
  steps: Step[];
  if?: string;
  strategy?: MatrixStrategy;
  env?: Record<string, string>;
};

export type Step = {
  id: string;
  name: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
};

export type MatrixStrategy = {
  matrix: Record<string, unknown>;
};

export type EventSpec = {
  name: "push" | "pull_request" | "workflow_dispatch" | string;
  payloadPath?: string;
};

export type RunPreset = {
  id: string;
  label: string;
  jobIds: string[];
  event?: EventSpec;
  matrixOverride?: Record<string, unknown>;
};

export type RunPlan = {
  runId: string;
  workflow: Workflow;
  jobs: PlannedJob[];
  event: EventSpec;
  preset?: RunPreset;
};

export type PlannedJob = {
  jobId: string;
  matrix: Record<string, unknown> | null;
  engineArgs: string[];
};

export type RunStatus = "pending" | "running" | "success" | "failed" | "canceled";

export type JobRun = {
  jobId: string;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  matrix?: Record<string, unknown> | null;
};

export type RunRecord = {
  id: string;
  workflowId: string;
  event: EventSpec;
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  jobs: JobRun[];
  artifactDir?: string;
  logDir?: string;
};
