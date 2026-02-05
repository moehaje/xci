import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { cancel, intro, isCancel, select } from "@clack/prompts";
import { loadConfig } from "../config/load-config.js";
import { discoverWorkflows } from "../core/discovery.js";
import type { EngineAdapter, EngineContext } from "../core/engine.js";
import {
	buildRunPlan,
	expandJobIdsWithNeeds,
	filterJobsForEvent,
	sortJobsByNeeds,
} from "../core/plan.js";
import type { Workflow } from "../core/types.js";
import { createEngineAdapter } from "../engines/factory.js";
import { createRunEventPersister, RunStore } from "../store/run-store.js";
import type { CliOptions } from "./args.js";
import { parseArgs, printHelp, readPackageVersion } from "./args.js";
import { type CleanupMode, cleanupRuntime } from "./cleanup.js";
import { executeRun } from "./execute-run.js";
import { ensureGitignore, runInit } from "./init.js";
import { prepareInputFiles } from "./inputs.js";
import { buildJsonSummary } from "./output.js";
import {
	resolveContainerArchitecture,
	resolvePlatformMap,
	resolvePresets,
	resolveSupportedEvents,
	resolveUnrunnableJobs,
} from "./plan-run.js";
import { runPreflightChecks } from "./preflight.js";
import {
	collectMatrixKeys,
	promptMatrix,
	resolveJobsFromArgs,
	resolveWorkflow,
	selectEvent,
	selectJobs,
	selectPreset,
} from "./select.js";

const XCI_ASCII_LINES = [
	"██╗  ██╗ ██████╗██╗",
	"╚██╗██╔╝██╔════╝██║",
	" ╚███╔╝ ██║     ██║",
	" ██╔██╗ ██║     ██║",
	"██╔╝ ██╗╚██████╗██║",
	"╚═╝  ╚═╝ ╚═════╝╚═╝",
] as const;

const XCI_GRADIENT_START = "#FFB5B3";
const XCI_GRADIENT_END = "#F55650";
const XCI_BADGE_BG = "#FFB5B3";
const XCI_BADGE_FG = "#451716";
const XCI_BANNER_SIGNATURE = "by artsnlabs";

export async function runCli(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}
	if (args.version) {
		const version = readPackageVersion();
		process.stdout.write(`xci ${version}\n`);
		return;
	}
	if (args.unknown?.length) {
		process.stderr.write(`Unknown option(s): ${args.unknown.join(", ")}\n`);
		process.stderr.write("Run `xci --help` for usage.\n");
		process.exitCode = 2;
		return;
	}
	if (args.errors?.length) {
		process.stderr.write(`${args.errors.join("\n")}\n`);
		process.stderr.write("Run `xci --help` for usage.\n");
		process.exitCode = 2;
		return;
	}
	if (args.command === "init") {
		runInit(process.cwd());
		return;
	}
	if (args.command === "cleanup") {
		const repoRoot = process.cwd();
		const { config } = loadConfig(repoRoot);
		const cleanupMode = resolveCleanupMode(
			config.runtime.cleanupMode,
			config.runtime.cleanup,
			args,
		);
		const mode = args.full ? "full" : cleanupMode;
		const summary = cleanupRuntime(config.runtime.container, mode);
		process.stdout.write(
			`Cleanup (${summary.engine}, mode=${mode}): removed ${summary.removedActContainers} act container(s), ${summary.removedActVolumes} act volume(s), ${summary.removedActImages} act image(s).\n`,
		);
		if (summary.errors.length > 0) {
			process.stderr.write(`${summary.errors.join("\n")}\n`);
			process.exitCode = 1;
		}
		return;
	}
	if (args.command !== "run") {
		process.stderr.write(`Unknown command: ${args.command}\n`);
		process.exitCode = 2;
		return;
	}

	const repoRoot = process.cwd();
	const isTty = Boolean(process.stdout.isTTY);
	if (isTty && !fs.existsSync(path.join(repoRoot, ".xci"))) {
		const gitignoreResult = ensureGitignore(repoRoot);
		if (gitignoreResult === "added") {
			process.stdout.write("Added '.xci' to .gitignore.\n");
		}
	}
	let workflows: Workflow[] = [];
	try {
		workflows = discoverWorkflows(repoRoot);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown workflow parse error.";
		process.stderr.write(`Workflow parse error: ${message}\n`);
		process.exitCode = 1;
		return;
	}
	if (workflows.length === 0) {
		process.stderr.write("No workflows found in .github/workflows.\n");
		process.exitCode = 1;
		return;
	}

	const { config } = loadConfig(repoRoot);
	let eventName = args.event ?? "push";

	let workflow = resolveWorkflow(workflows, args.workflow);
	if (!workflow && isTty) {
		printBanner();
		intro(styleBadge("XCI"));
		const selected = await select({
			message: "Select a workflow",
			options: workflows.map((wf) => ({
				value: wf.id,
				label: wf.name,
			})),
		});
		if (isCancel(selected)) {
			cancel("Canceled.");
			process.exitCode = 130;
			return;
		}
		workflow = workflows.find((wf) => wf.id === selected) ?? workflows[0];
	}

	if (!workflow) {
		process.stderr.write("No workflow selected. Use --workflow.\n");
		process.exitCode = 2;
		return;
	}

	const supportedEvents = resolveSupportedEvents(workflow);
	if (isTty && !args.event) {
		const event = await selectEvent(eventName, supportedEvents);
		if (!event) {
			process.exitCode = 130;
			return;
		}
		eventName = event;
	} else if (!supportedEvents.includes(eventName)) {
		process.stderr.write(
			`Event "${eventName}" is not enabled for this workflow. Use --event with one of: ${supportedEvents.join(", ")}.\n`,
		);
		process.exitCode = 2;
		return;
	}

	const presets = resolvePresets(config.presets, workflow.jobs, config.defaultPreset);
	const presetId = args.preset ?? config.defaultPreset ?? "quick";
	const preset = presets.find((item) => item.id === presetId) ?? presets[0];

	const effectiveEvent = args.event ?? preset?.event?.name ?? eventName;
	if (!supportedEvents.includes(effectiveEvent)) {
		process.stderr.write(
			`Event "${effectiveEvent}" is not enabled for this workflow. Use --event with one of: ${supportedEvents.join(", ")}.\n`,
		);
		process.exitCode = 2;
		return;
	}
	const availableJobs = filterJobsForEvent(workflow.jobs, effectiveEvent);

	let selectedJobs = resolveJobsFromArgs(args, preset);
	if (args.all) {
		selectedJobs = availableJobs.map((job) => job.id);
	}

	if (isTty && !selectedJobs) {
		const presetChoice = await selectPreset(presets, presetId);
		if (!presetChoice) {
			process.exitCode = 130;
			return;
		}

		const jobChoice = await selectJobs(availableJobs, presetChoice.jobIds);
		if (!jobChoice) {
			process.exitCode = 130;
			return;
		}

		const matrixKeys = collectMatrixKeys(workflow, jobChoice);
		const matrixChoice = await promptMatrix(matrixKeys);
		if (matrixChoice === null) {
			process.exitCode = 130;
			return;
		}

		selectedJobs = jobChoice;
		args.matrix = matrixChoice ?? args.matrix;
	}

	if (!selectedJobs) {
		selectedJobs = preset?.jobIds?.length ? preset.jobIds : availableJobs.map((job) => job.id);
	}

	const expanded = expandJobIdsWithNeeds(workflow, selectedJobs);
	let ordered = sortJobsByNeeds(workflow, expanded);
	const effectivePayloadPath = args.eventPath ?? preset?.event?.payloadPath;

	const platformResolution = resolvePlatformMap(
		workflow,
		ordered,
		config.runtime.image,
		config.runtime.platformMap,
	);
	const platformMap = platformResolution.map;
	if (isTty && platformResolution.inferredLabels.length > 0) {
		process.stdout.write(
			`Auto-mapped runner labels to local container images: ${platformResolution.inferredLabels.join(", ")}\n`,
		);
	}
	const unrunnableJobs = resolveUnrunnableJobs(workflow, ordered, platformMap);
	if (unrunnableJobs.size > 0) {
		const runnable = ordered.filter((jobId) => !unrunnableJobs.has(jobId));
		const summary = ordered
			.filter((jobId) => unrunnableJobs.has(jobId))
			.map((jobId) => `${jobId} (${unrunnableJobs.get(jobId)})`)
			.join(", ");
		if (runnable.length === 0) {
			process.stderr.write(
				`No runnable jobs for local act execution. Skipped: ${summary}. Select Linux jobs with --job or provide explicit runtime mappings in .xci.yml.\n`,
			);
			process.exitCode = 2;
			return;
		}
		process.stdout.write(
			`Skipping jobs that are not runnable with current local runtime: ${summary}\n`,
		);
		ordered = runnable;
	}

	const plan = buildRunPlan({
		workflow,
		jobIds: ordered,
		eventName: effectiveEvent,
		eventPayloadPath: effectivePayloadPath,
		preset,
		matrixOverride: args.matrix ?? preset?.matrixOverride,
	});

	const runStore = new RunStore(path.join(repoRoot, ".xci", "runs"));
	const runDir = runStore.createRunDir(plan.runId);
	const logsDir = runStore.createLogsDir(plan.runId);
	const artifactsDir = runStore.createArtifactsDir(plan.runId);
	const inputFiles = prepareInputFiles(runDir, config);
	if (!inputFiles.ok) {
		process.stderr.write(`${inputFiles.error}\n`);
		process.exitCode = 2;
		return;
	}

	const engineContext: EngineContext = {
		repoRoot,
		runDir,
		logsDir,
		workflowsPath: path.dirname(workflow.path),
		containerEngine: config.runtime.container,
		eventName: plan.event.name,
		eventPayloadPath: plan.event.payloadPath,
		artifactDir: artifactsDir,
		containerArchitecture: resolveContainerArchitecture(config.runtime.architecture),
		platformMap,
		envFile: inputFiles.envFile,
		varsFile: inputFiles.varsFile,
		secretsFile: inputFiles.secretsFile,
		matrixOverride: plan.jobs[0]?.matrix ?? undefined,
		jobLogPathFor: (jobId) => runStore.createLogFile(plan.runId, jobId),
		onEvent: createRunEventPersister(runStore),
	};
	const runContext: EngineContext = args.json
		? {
				...engineContext,
				onOutput: () => {},
			}
		: !isTty
			? {
					...engineContext,
					onOutput: (chunk, source) => {
						if (source === "stderr") {
							process.stderr.write(chunk);
							return;
						}
						process.stdout.write(chunk);
					},
				}
			: engineContext;

	const preflightOk = await runPreflightChecks(
		config.runtime.container,
		isTty && !args.json,
		Object.values(platformMap),
	);
	if (!preflightOk) {
		process.exitCode = 1;
		return;
	}

	let adapter: EngineAdapter;
	try {
		adapter = createEngineAdapter(config.engine);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown engine error.";
		process.stderr.write(`${message}\n`);
		process.exitCode = 2;
		return;
	}
	const planned = await adapter.plan(runContext, plan);
	const result = await executeRun({
		adapter,
		plan: planned,
		context: runContext,
		workflow,
		runStoreBase: path.join(repoRoot, ".xci", "runs"),
		isTty,
		json: Boolean(args.json),
	});
	if (args.json) {
		const summary = await buildJsonSummary(repoRoot, plan.runId, workflow, ordered);
		process.stdout.write(`${JSON.stringify(summary)}\\n`);
	}
	const cleanupMode = resolveCleanupMode(config.runtime.cleanupMode, config.runtime.cleanup, args);
	if (cleanupMode !== "off") {
		const cleanupSummary = cleanupRuntime(config.runtime.container, cleanupMode);
		if (cleanupSummary.errors.length > 0 && !args.json) {
			process.stderr.write(`${cleanupSummary.errors.join("\n")}\n`);
		}
	}
	process.exitCode = result.exitCode;
}

function resolveCleanupMode(
	configMode: CleanupMode,
	legacyCleanup: boolean | undefined,
	options: CliOptions,
): CleanupMode {
	if (options.noCleanup) {
		return "off";
	}
	if (options.cleanupMode) {
		if (
			options.cleanupMode === "off" ||
			options.cleanupMode === "fast" ||
			options.cleanupMode === "full"
		) {
			return options.cleanupMode;
		}
	}
	if (legacyCleanup === false) {
		return "off";
	}
	return configMode;
}

function printBanner(): void {
	const start = parseHexColor(XCI_GRADIENT_START);
	const end = parseHexColor(XCI_GRADIENT_END);
	const count = XCI_ASCII_LINES.length;
	for (let index = 0; index < count; index += 1) {
		const ratio = count > 1 ? index / (count - 1) : 0;
		const color = mixRgb(start, end, ratio);
		const line = withForeground(XCI_ASCII_LINES[index], color);
		if (index === count - 1) {
			process.stdout.write(`${line} ${withDim(XCI_BANNER_SIGNATURE)}\n\n`);
			continue;
		}
		process.stdout.write(`${line}\n`);
	}
}

function styleBadge(text: string): string {
	return withBackground(` ${text} `, parseHexColor(XCI_BADGE_BG), parseHexColor(XCI_BADGE_FG));
}

function parseHexColor(hex: string): [number, number, number] {
	const value = hex.replace("#", "");
	if (value.length !== 6) {
		return [255, 255, 255];
	}
	const red = Number.parseInt(value.slice(0, 2), 16);
	const green = Number.parseInt(value.slice(2, 4), 16);
	const blue = Number.parseInt(value.slice(4, 6), 16);
	return [red, green, blue];
}

function mixRgb(
	start: [number, number, number],
	end: [number, number, number],
	ratio: number,
): [number, number, number] {
	const clamp = Math.max(0, Math.min(1, ratio));
	return [
		Math.round(start[0] + (end[0] - start[0]) * clamp),
		Math.round(start[1] + (end[1] - start[1]) * clamp),
		Math.round(start[2] + (end[2] - start[2]) * clamp),
	];
}

function withForeground(text: string, color: [number, number, number]): string {
	return `\u001B[38;2;${color[0]};${color[1]};${color[2]}m${text}\u001B[0m`;
}

function withBackground(
	text: string,
	background: [number, number, number],
	foreground?: [number, number, number],
): string {
	if (foreground) {
		return `\u001B[48;2;${background[0]};${background[1]};${background[2]}m\u001B[38;2;${foreground[0]};${foreground[1]};${foreground[2]}m${text}\u001B[0m`;
	}
	return `\u001B[48;2;${background[0]};${background[1]};${background[2]}m${text}\u001B[0m`;
}

function withDim(text: string): string {
	return `\u001B[2m${text}\u001B[0m`;
}
