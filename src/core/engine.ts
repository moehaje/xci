import type { EventSpec, RunPlan, RunStatus } from "./types.js";

export type EngineCapabilities = {
	matrix: boolean;
	artifacts: boolean;
	eventPayloads: boolean;
	services: boolean;
};

export type EngineContext = {
	repoRoot: string;
	runDir: string;
	logsDir: string;
	workflowsPath: string;
	containerEngine?: "docker" | "podman";
	eventName: string;
	eventPayloadPath?: string;
	artifactDir: string;
	containerArchitecture?: string;
	envFile?: string;
	varsFile?: string;
	secretsFile?: string;
	matrixOverride?: string[];
	platformMap?: Record<string, string>;
	jobLogPathFor?: (jobId: string) => string;
	extraArgs?: string[];
	signal?: AbortSignal;
	onOutput?: (chunk: string, source: "stdout" | "stderr", jobId?: string) => void;
	onEvent?: (event: EngineRuntimeEvent) => void;
};

export type EngineRunResult = {
	exitCode: number;
	logsPath: string;
};

export type EngineRuntimeEvent =
	| {
			type: "run-started";
			runId: string;
			workflowId: string;
			event: EventSpec;
			jobs: { jobId: string; matrix: string[] | null }[];
			artifactDir?: string;
			logDir?: string;
			createdAt: string;
	  }
	| {
			type: "job-started";
			runId: string;
			jobId: string;
			startedAt: string;
	  }
	| {
			type: "job-finished";
			runId: string;
			jobId: string;
			status: Extract<RunStatus, "success" | "failed" | "canceled">;
			exitCode: number;
			startedAt?: string;
			finishedAt: string;
			durationMs: number;
	  }
	| {
			type: "jobs-canceled";
			runId: string;
			jobIds: string[];
	  }
	| {
			type: "run-finished";
			runId: string;
			status: Extract<RunStatus, "success" | "failed" | "canceled">;
			finishedAt: string;
	  };

export interface EngineAdapter {
	readonly id: string;
	capabilities(): EngineCapabilities;
	plan(context: EngineContext, plan: RunPlan): Promise<RunPlan>;
	run(plan: RunPlan, context: EngineContext): Promise<EngineRunResult>;
}
