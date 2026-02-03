import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
	EngineAdapter,
	EngineCapabilities,
	EngineContext,
	EngineRunResult,
} from "../../core/engine.js";
import type { JobRun, RunPlan, RunRecord } from "../../core/types.js";
import { RunStore } from "../../store/run-store.js";

export class ActAdapter implements EngineAdapter {
	readonly id = "act";

	capabilities(): EngineCapabilities {
		return {
			matrix: true,
			artifacts: true,
			eventPayloads: true,
			services: true,
		};
	}

	async plan(context: EngineContext, plan: RunPlan): Promise<RunPlan> {
		const plannedJobs = plan.jobs.map((job) => ({
			...job,
			engineArgs: buildActArgs(context, job.jobId, job.matrix ?? null),
		}));

		return {
			...plan,
			jobs: plannedJobs,
		};
	}

	async run(plan: RunPlan, context: EngineContext): Promise<EngineRunResult> {
		if (plan.jobs.length === 0) {
			return { exitCode: 1, logsPath: "" };
		}

		const store = new RunStore(path.join(context.repoRoot, ".xci", "runs"));
		const runDir = store.createRunDir(plan.runId);
		const artifactsDir = store.createArtifactsDir(plan.runId);
		const logDir = store.createLogsDir(plan.runId);
		const eventPath = ensureEventPayload(plan.event.name, context.eventPayloadPath, runDir);

		const runRecord = createRunRecord(plan, artifactsDir, logDir);
		store.writeRun(runRecord);

		let lastLogsPath = "";
		let exitCode = 0;

		for (const [index, job] of plan.jobs.entries()) {
			const logsPath = store.createLogFile(plan.runId, job.jobId);
			lastLogsPath = logsPath;

			const engineArgs = buildActArgs(
				{
					...context,
					eventPayloadPath: eventPath,
					artifactDir: artifactsDir,
				},
				job.jobId,
				job.matrix ?? null,
			);

			const jobRun = runRecord.jobs[index];
			jobRun.status = "running";
			jobRun.startedAt = new Date().toISOString();
			store.writeRun(runRecord);

			const logStream = fs.createWriteStream(logsPath, { flags: "a" });
			exitCode = await runAct(engineArgs, context.repoRoot, logStream, job.jobId, context.onOutput);

			finalizeJobRun(jobRun, exitCode);
			store.writeRun(runRecord);

			if (exitCode !== 0) {
				markRemainingCanceled(runRecord, index + 1);
				break;
			}
		}

		finalizeRunRecord(runRecord);
		store.writeRun(runRecord);

		return { exitCode, logsPath: lastLogsPath };
	}
}

function buildActArgs(context: EngineContext, jobId: string, matrix: string[] | null): string[] {
	const args = ["act", context.eventName, "--workflows", context.workflowsPath, "--job", jobId];

	if (context.eventPayloadPath) {
		args.push("--eventpath", context.eventPayloadPath);
	}

	if (matrix?.length) {
		matrix.forEach((item) => {
			args.push("--matrix", item);
		});
	}

	if (context.artifactDir) {
		args.push("--artifact-server-path", context.artifactDir);
		args.push("--artifact-server-addr", "127.0.0.1");
		args.push("--artifact-server-port", "0");
	}

	if (context.containerArchitecture) {
		const arch = context.containerArchitecture.includes("/")
			? context.containerArchitecture
			: `linux/${context.containerArchitecture}`;
		args.push("--container-architecture", arch);
	}

	for (const [key, value] of Object.entries(context.platformMap ?? {})) {
		args.push("--platform", `${key}=${value}`);
	}

	if (context.envFile) {
		args.push("--env-file", context.envFile);
	}

	if (context.varsFile) {
		args.push("--var-file", context.varsFile);
	}

	if (context.secretsFile) {
		args.push("--secret-file", context.secretsFile);
	}

	if (context.extraArgs?.length) {
		args.push(...context.extraArgs);
	}

	return args;
}

function ensureEventPayload(
	eventName: string,
	eventPath: string | undefined,
	runDir: string,
): string {
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
					base: { ref: "main" },
				},
			};
		case "workflow_dispatch":
			return { repository: repo, inputs: {} };
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
			...plan.jobs.map((job) => ({
				jobId: job.jobId,
				status: "pending" as const,
				matrix: job.matrix ?? null,
			})),
		],
		artifactDir,
		logDir,
	};
}

function finalizeJobRun(jobRun: JobRun, exitCode: number): void {
	const finishedAt = new Date().toISOString();
	const durationMs =
		new Date(finishedAt).getTime() - new Date(jobRun.startedAt ?? finishedAt).getTime();
	jobRun.status = exitCode === 0 ? "success" : "failed";
	jobRun.exitCode = exitCode;
	jobRun.finishedAt = finishedAt;
	jobRun.durationMs = durationMs;
}

function finalizeRunRecord(run: RunRecord): void {
	const finishedAt = new Date().toISOString();
	const hasFailure = run.jobs.some((job) => job.status === "failed");
	const isRunning = run.jobs.some((job) => job.status === "running");
	if (!isRunning) {
		run.status = hasFailure ? "failed" : "success";
		run.finishedAt = finishedAt;
	}
}

function markRemainingCanceled(run: RunRecord, startIndex: number): void {
	for (let i = startIndex; i < run.jobs.length; i += 1) {
		if (run.jobs[i].status === "pending") {
			run.jobs[i].status = "canceled";
		}
	}
}

function runAct(
	args: string[],
	cwd: string,
	logStream: fs.WriteStream,
	jobId: string,
	onOutput?: (chunk: string, source: "stdout" | "stderr", jobId?: string) => void,
): Promise<number> {
	return new Promise((resolve) => {
		const [command, ...commandArgs] = args;
		const formatter = createActOutputFormatter();
		const commandLine = `$ ${formatActCommand(args)}\n`;
		logStream.write(commandLine);
		if (onOutput) {
			onOutput(commandLine, "stdout", jobId);
		} else {
			process.stdout.write(commandLine);
		}
		let dockerHinted = false;
		const maybeHintDockerError = (text: string): void => {
			if (dockerHinted) {
				return;
			}
			if (!looksLikeDockerStorageError(text)) {
				return;
			}
			dockerHinted = true;
			const hint =
				"XCI note: Docker reported a storage I/O error. Try restarting Docker Desktop and check disk space.\n";
			logStream.write(hint);
			if (onOutput) {
				onOutput(hint, "stderr", jobId);
			} else {
				process.stderr.write(hint);
			}
		};
		const child = spawn(command, commandArgs, { cwd, env: process.env });

		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			logStream.write(text);
			maybeHintDockerError(text);
			if (onOutput) {
				const formatted = formatter.push(text);
				if (formatted.length > 0) {
					onOutput(formatted, "stdout", jobId);
				}
			} else {
				process.stdout.write(text);
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			logStream.write(text);
			maybeHintDockerError(text);
			if (onOutput) {
				const formatted = formatter.push(text);
				if (formatted.length > 0) {
					onOutput(formatted, "stderr", jobId);
				}
			} else {
				process.stderr.write(text);
			}
		});

		child.on("close", (code: number | null) => {
			if (onOutput) {
				const remaining = formatter.flush();
				if (remaining.length > 0) {
					onOutput(remaining, "stdout", jobId);
				}
			}
			logStream.end();
			resolve(code ?? 1);
		});
	});
}

function formatActCommand(args: string[]): string {
	const redacted = redactActArgs(args);
	return redacted.map(quoteArg).join(" ");
}

function redactActArgs(args: string[]): string[] {
	const redacted = [...args];
	const redactNext = new Set(["--secret-file", "--env-file", "--var-file"]);

	for (let i = 0; i < redacted.length; i += 1) {
		const current = redacted[i];
		if (redactNext.has(current) && i + 1 < redacted.length) {
			redacted[i + 1] = "<redacted>";
			i += 1;
			continue;
		}
		for (const flag of redactNext) {
			if (current.startsWith(`${flag}=`)) {
				redacted[i] = `${flag}=<redacted>`;
				break;
			}
		}
	}

	return redacted;
}

function quoteArg(value: string): string {
	if (/[\s"'\\]/.test(value)) {
		return JSON.stringify(value);
	}
	return value;
}

function looksLikeDockerStorageError(text: string): boolean {
	return (
		text.includes("Error response from daemon") &&
		(text.includes("input/output error") || text.includes("I/O error"))
	);
}

type ActOutputFormatter = {
	push: (chunk: string) => string;
	flush: () => string;
};

function createActOutputFormatter(): ActOutputFormatter {
	let buffer = "";
	let inGroup = false;
	let inWithBlock = false;

	const formatLine = (input: string): string | null => {
		const line = stripAnsi(input).replace(/\r/g, "");
		const body = stripActJobPrefix(line).trimStart();
		if (body.length === 0) {
			inWithBlock = false;
			return null;
		}

		if (body.includes("::endgroup::")) {
			inGroup = false;
			inWithBlock = false;
			return null;
		}

		const groupMatch = body.match(/^(?:❓\s+)?::group::\s*(.+)$/);
		if (groupMatch) {
			inGroup = true;
			inWithBlock = false;
			return `▾ ${groupMatch[1].trim()}`;
		}

		if (shouldSuppressActLine(body)) {
			return null;
		}

		let content = body;
		const pipeMatch = content.match(/^\|\s?(.*)$/);
		if (pipeMatch) {
			content = pipeMatch[1];
		} else {
			content = content.replace(/^❓\s+/, "");
		}

		const runMatch = content.match(/^⭐\s+Run\s+(.+)$/);
		if (runMatch) {
			inWithBlock = false;
			content = `▾ Run ${runMatch[1].trim()}`;
		}

		const successMatch = content.match(/^✅\s+Success\s+-\s+(.+)$/);
		if (successMatch) {
			inWithBlock = false;
			content = `✓ ${successMatch[1].trim()}`;
		}

		const failureMatch = content.match(/^❌\s+Failure\s+-\s+(.+)$/);
		if (failureMatch) {
			inWithBlock = false;
			content = `✗ ${failureMatch[1].trim()}`;
		}

		if (content === "with:") {
			inWithBlock = true;
			return `   ${content}`;
		}

		const isWithKeyValue = /^[a-zA-Z0-9_.-]+:\s+.+$/.test(content);
		if (inWithBlock && isWithKeyValue) {
			return `     ${content}`;
		}
		if (inWithBlock && !isWithKeyValue) {
			inWithBlock = false;
		}

		if (inGroup) {
			return `   ${content}`;
		}
		return content;
	};

	const collect = (input: string, flushRemainder: boolean): string => {
		buffer += input;
		const lines = buffer.split("\n");
		const remainder = lines.pop() ?? "";
		if (!flushRemainder) {
			buffer = remainder;
		} else {
			buffer = "";
		}

		const formatted: string[] = [];
		for (const line of lines) {
			const value = formatLine(line);
			if (value) {
				formatted.push(value);
			}
		}
		if (flushRemainder && remainder.length > 0) {
			const value = formatLine(remainder);
			if (value) {
				formatted.push(value);
			}
		}
		if (formatted.length === 0) {
			return "";
		}
		return `${formatted.join("\n")}\n`;
	};

	return {
		push: (chunk: string) => collect(chunk, false),
		flush: () => collect("", true),
	};
}

function shouldSuppressActLine(line: string): boolean {
	return (
		line.startsWith("🐳") ||
		/\bdocker\s+(cp|exec|run|pull)\b/.test(line) ||
		/^(?:❓\s+)?(?:add|remove)-matcher\s+/i.test(line)
	);
}

function stripActJobPrefix(line: string): string {
	return line.replace(/^\[[^\]]+\]\s+/, "");
}

const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");

function stripAnsi(input: string): string {
	return input.replace(ANSI_PATTERN, "");
}
