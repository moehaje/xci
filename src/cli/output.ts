import path from "node:path";
import type { Workflow } from "../core/types.js";

export async function buildJsonSummary(
	repoRoot: string,
	runId: string,
	workflow: Workflow,
	orderedJobs: string[],
): Promise<Record<string, unknown>> {
	const { readFile } = await import("node:fs/promises");
	const runFile = path.join(repoRoot, ".xci", "runs", runId, "run.json");
	const raw = await readFile(runFile, "utf-8");
	const run = JSON.parse(raw) as {
		jobs: {
			jobId: string;
			status: string;
			exitCode?: number;
			durationMs?: number;
		}[];
		logDir?: string;
		artifactDir?: string;
	};

	return {
		runId,
		workflow: {
			id: workflow.id,
			name: workflow.name,
			path: workflow.path,
		},
		jobs: orderedJobs.map((jobId) => {
			const job = run.jobs.find((item) => item.jobId === jobId);
			return {
				jobId,
				status: job?.status ?? "unknown",
				exitCode: job?.exitCode,
				durationMs: job?.durationMs,
			};
		}),
		logsDir: run.logDir,
		artifactsDir: run.artifactDir,
	};
}
