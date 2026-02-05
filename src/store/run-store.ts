import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EngineRuntimeEvent } from "../core/engine.js";
import type { RunRecord } from "../core/types.js";
import { ensureWithinBase, sanitizePathSegment } from "../utils/path-safety.js";

export const RUN_RECORD_SCHEMA_VERSION = 1;

export class RunStore {
	constructor(private readonly baseDir: string) {}

	ensureBaseDir(): void {
		fs.mkdirSync(this.baseDir, { recursive: true });
	}

	createRunDir(runId: string): string {
		this.ensureBaseDir();
		const runDir = ensureWithinBase(this.baseDir, runId, "run id");
		fs.mkdirSync(runDir, { recursive: true });
		return runDir;
	}

	createLogsDir(runId: string): string {
		const runDir = this.createRunDir(runId);
		const logsDir = path.join(runDir, "logs");
		fs.mkdirSync(logsDir, { recursive: true });
		return logsDir;
	}

	createArtifactsDir(runId: string): string {
		const runDir = this.createRunDir(runId);
		const artifactsDir = path.join(runDir, "artifacts");
		fs.mkdirSync(artifactsDir, { recursive: true });
		return artifactsDir;
	}

	createLogFile(runId: string, jobId: string): string {
		const logsDir = this.createLogsDir(runId);
		return ensureWithinBase(logsDir, getJobLogFileName(jobId), "job log file");
	}

	writeRun(run: RunRecord): void {
		this.ensureBaseDir();
		const runDir = path.join(this.baseDir, run.id);
		fs.mkdirSync(runDir, { recursive: true });
		const recordPath = path.join(runDir, "run.json");
		fs.writeFileSync(recordPath, JSON.stringify(run, null, 2));
	}
}

export function getJobLogFileName(jobId: string): string {
	const normalized = sanitizePathSegment(jobId.toLowerCase(), "job");
	const hash = crypto.createHash("sha1").update(jobId).digest("hex").slice(0, 8);
	const base = normalized.length > 0 ? normalized : "job";
	return `${base}-${hash}.log`;
}

export function createRunEventPersister(runStore: RunStore): (event: EngineRuntimeEvent) => void {
	let run: RunRecord | null = null;

	return (event) => {
		switch (event.type) {
			case "run-started":
				run = {
					schemaVersion: RUN_RECORD_SCHEMA_VERSION,
					id: event.runId,
					workflowId: event.workflowId,
					event: event.event,
					status: "running",
					createdAt: event.createdAt,
					jobs: event.jobs.map((job) => ({
						jobId: job.jobId,
						status: "pending",
						matrix: job.matrix,
					})),
					artifactDir: event.artifactDir,
					logDir: event.logDir,
				};
				runStore.writeRun(run);
				return;
			case "job-started":
				if (!run || run.id !== event.runId) {
					return;
				}
				{
					const job = run.jobs.find((item) => item.jobId === event.jobId);
					if (!job) {
						return;
					}
					job.status = "running";
					job.startedAt = event.startedAt;
					runStore.writeRun(run);
				}
				return;
			case "job-finished":
				if (!run || run.id !== event.runId) {
					return;
				}
				{
					const job = run.jobs.find((item) => item.jobId === event.jobId);
					if (!job) {
						return;
					}
					job.status = event.status;
					job.exitCode = event.exitCode;
					job.startedAt = event.startedAt;
					job.finishedAt = event.finishedAt;
					job.durationMs = event.durationMs;
					runStore.writeRun(run);
				}
				return;
			case "jobs-canceled":
				if (!run || run.id !== event.runId) {
					return;
				}
				for (const jobId of event.jobIds) {
					const job = run.jobs.find((item) => item.jobId === jobId);
					if (!job || job.status !== "pending") {
						continue;
					}
					job.status = "canceled";
				}
				runStore.writeRun(run);
				return;
			case "run-finished":
				if (!run || run.id !== event.runId) {
					return;
				}
				run.status = event.status;
				run.finishedAt = event.finishedAt;
				runStore.writeRun(run);
				return;
		}
	};
}

// safeJoin removed; use ensureWithinBase from utils.
