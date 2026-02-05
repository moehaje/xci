import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
	EngineAdapter,
	EngineCapabilities,
	EngineContext,
	EngineRunResult,
} from "../../core/engine.js";
import type { RunPlan } from "../../core/types.js";
import { getJobLogFileName } from "../../store/run-store.js";

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
		const eventPayloadPath = ensureEventPayload(
			plan.event.name,
			context.eventPayloadPath,
			context.runDir,
		);
		const plannedJobs = plan.jobs.map((job) => ({
			...job,
			engineArgs: buildActArgs(
				{
					...context,
					eventPayloadPath,
				},
				job.jobId,
				job.matrix ?? null,
			),
		}));

		return {
			...plan,
			event: {
				...plan.event,
				payloadPath: eventPayloadPath,
			},
			jobs: plannedJobs,
		};
	}

	async run(plan: RunPlan, context: EngineContext): Promise<EngineRunResult> {
		if (plan.jobs.length === 0) {
			return { exitCode: 1, logsPath: "" };
		}

		const eventPath = ensureEventPayload(plan.event.name, plan.event.payloadPath, context.runDir);
		const createdAt = new Date().toISOString();
		context.onEvent?.({
			type: "run-started",
			runId: plan.runId,
			workflowId: plan.workflow.id,
			event: {
				...plan.event,
				payloadPath: eventPath,
			},
			jobs: plan.jobs.map((job) => ({ jobId: job.jobId, matrix: job.matrix ?? null })),
			artifactDir: context.artifactDir,
			logDir: context.logsDir,
			createdAt,
		});

		let lastLogsPath = "";
		let exitCode = 0;
		let hasFailure = false;
		let hasCanceled = false;

		for (const [index, job] of plan.jobs.entries()) {
			if (context.signal?.aborted) {
				exitCode = 130;
				hasCanceled = true;
				markRemainingCanceled(plan, context, index);
				break;
			}
			const logsPath =
				context.jobLogPathFor?.(job.jobId) ??
				path.join(context.logsDir, getJobLogFileName(job.jobId));
			lastLogsPath = logsPath;

			const engineArgs = job.engineArgs;
			const startedAt = new Date().toISOString();
			context.onEvent?.({
				type: "job-started",
				runId: plan.runId,
				jobId: job.jobId,
				startedAt,
			});

			const logStream = fs.createWriteStream(logsPath, { flags: "a", encoding: "utf-8" });
			exitCode = await runAct(
				engineArgs,
				context.repoRoot,
				logStream,
				job.jobId,
				context.onOutput,
				context.signal,
			);

			const finishedAt = new Date().toISOString();
			const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
			const status = exitCode === 130 ? "canceled" : exitCode === 0 ? "success" : "failed";
			context.onEvent?.({
				type: "job-finished",
				runId: plan.runId,
				jobId: job.jobId,
				status,
				exitCode,
				startedAt,
				finishedAt,
				durationMs,
			});

			if (exitCode !== 0) {
				hasCanceled = hasCanceled || exitCode === 130;
				hasFailure = hasFailure || exitCode !== 130;
				markRemainingCanceled(plan, context, index + 1);
				break;
			}
		}

		const runStatus = hasFailure ? "failed" : hasCanceled ? "canceled" : "success";
		context.onEvent?.({
			type: "run-finished",
			runId: plan.runId,
			status: runStatus,
			finishedAt: new Date().toISOString(),
		});

		return { exitCode, logsPath: lastLogsPath };
	}
}

function buildActArgs(context: EngineContext, jobId: string, matrix: string[] | null): string[] {
	const args = ["act", context.eventName, "--workflows", context.workflowsPath, "--job", jobId];
	args.push("--rm");

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

function markRemainingCanceled(plan: RunPlan, context: EngineContext, startIndex: number): void {
	const jobIds = plan.jobs.slice(startIndex).map((job) => job.jobId);
	if (jobIds.length === 0) {
		return;
	}
	context.onEvent?.({
		type: "jobs-canceled",
		runId: plan.runId,
		jobIds,
	});
}

function runAct(
	args: string[],
	cwd: string,
	logStream: fs.WriteStream,
	jobId: string,
	onOutput?: (chunk: string, source: "stdout" | "stderr", jobId?: string) => void,
	signal?: AbortSignal,
): Promise<number> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			logStream.end();
			resolve(130);
			return;
		}
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
		let settled = false;

		const finish = (code: number): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			logStream.end();
			resolve(code);
		};

		const onAbort = (): void => {
			if (!child.killed) {
				child.kill("SIGTERM");
			}
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

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
			finish(signal?.aborted ? 130 : (code ?? 1));
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			const hint = formatSpawnError(command, error);
			logStream.write(hint);
			if (onOutput) {
				onOutput(hint, "stderr", jobId);
			} else {
				process.stderr.write(hint);
			}
			finish(1);
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

function formatSpawnError(command: string, error: NodeJS.ErrnoException): string {
	const code = error.code ?? "UNKNOWN";
	if (code === "ENOENT") {
		return `XCI error: failed to start "${command}" (ENOENT). Ensure it is installed and on PATH.\n`;
	}
	if (code === "EACCES") {
		return `XCI error: failed to execute "${command}" (EACCES). Check executable permissions.\n`;
	}
	return `XCI error: failed to spawn "${command}" (${code}): ${error.message}\n`;
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
