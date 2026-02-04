import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { cancel, intro, isCancel, multiselect, outro, select, text } from "@clack/prompts";
import { render } from "ink";
import React from "react";
import { loadConfig } from "../config/load-config.js";
import { discoverWorkflows } from "../core/discovery.js";
import type { EngineAdapter, EngineContext, EngineRunResult } from "../core/engine.js";
import {
	buildRunPlan,
	expandJobIdsWithNeeds,
	filterJobsForEvent,
	sortJobsByNeeds,
} from "../core/plan.js";
import type { RunPlan, RunPreset, Workflow } from "../core/types.js";
import { ActAdapter } from "../engines/act/act-adapter.js";
import { RunStore } from "../store/run-store.js";
import { RunView } from "../tui/run-view.js";
import type { CliOptions } from "./args.js";
import { parseArgs, printHelp, readPackageVersion } from "./args.js";
import { ensureGitignore, runInit } from "./init.js";
import { prepareInputFiles } from "./inputs.js";
import { runPreflightChecks } from "./preflight.js";

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
	const inputFiles = prepareInputFiles(runDir, config);
	if (!inputFiles.ok) {
		process.stderr.write(`${inputFiles.error}\n`);
		process.exitCode = 2;
		return;
	}

	const engineContext: EngineContext = {
		repoRoot,
		workflowsPath: path.dirname(workflow.path),
		eventName: plan.event.name,
		eventPayloadPath: plan.event.payloadPath,
		artifactDir: path.join(repoRoot, ".xci", "runs", plan.runId, "artifacts"),
		containerArchitecture: resolveContainerArchitecture(config.runtime.architecture),
		platformMap,
		envFile: inputFiles.envFile,
		varsFile: inputFiles.varsFile,
		secretsFile: inputFiles.secretsFile,
		matrixOverride: plan.jobs[0]?.matrix ?? undefined,
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

	const adapter = new ActAdapter();
	const planned = await adapter.plan(runContext, plan);

	let result: EngineRunResult | null = null;
	if (isTty && !args.json) {
		result = await runWithInk(
			adapter,
			planned,
			runContext,
			workflow,
			path.join(repoRoot, ".xci", "runs"),
		);
		if (result.logsPath && fs.existsSync(result.logsPath)) {
			outro(`Logs: ${result.logsPath}`);
		} else {
			outro("Run files were cleaned up.");
		}
	} else {
		if (!args.json) {
			process.stdout.write(`Running ${planned.jobs.length} job(s) with act...\\n`);
		}
		result = await adapter.run(planned, runContext);
		if (!args.json) {
			process.stdout.write(`Finished with exit code ${result.exitCode}\\n`);
		}
		if (!args.json) {
			process.stdout.write(`Logs: ${result.logsPath}\\n`);
		}
	}
	if (args.json) {
		const summary = await buildJsonSummary(repoRoot, plan.runId, workflow, ordered);
		process.stdout.write(`${JSON.stringify(summary)}\\n`);
	}
	const shouldTreatInteractiveCancelAsSuccess = isTty && !args.json && result.exitCode === 130;
	process.exitCode = shouldTreatInteractiveCancelAsSuccess ? 0 : result.exitCode;
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
			process.stdout.write(`${line} ${withDim(XCI_BANNER_SIGNATURE)}\n`);
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

function resolveWorkflow(workflows: Workflow[], selector?: string): Workflow | undefined {
	if (!selector) {
		return workflows.length === 1 ? workflows[0] : undefined;
	}
	return workflows.find((wf) => wf.id.endsWith(selector) || wf.name === selector);
}

function resolveJobsFromArgs(options: CliOptions, preset?: RunPreset): string[] | undefined {
	if (options.all) {
		return undefined;
	}
	if (options.jobs?.length) {
		return options.jobs;
	}
	if (options.preset && preset?.jobIds?.length) {
		return preset.jobIds;
	}
	return undefined;
}

function resolvePresets(
	presets: Record<
		string,
		{
			jobs: string[];
			event?: { name: string; payloadPath?: string };
			matrix?: string[];
		}
	>,
	allJobs: { id: string }[],
	defaultPreset?: string,
): RunPreset[] {
	const resolved: RunPreset[] = Object.entries(presets).map(([id, preset]) => ({
		id,
		label: id,
		jobIds: preset.jobs,
		event: preset.event,
		matrixOverride: preset.matrix,
	}));

	if (!resolved.some((preset) => preset.id === "quick")) {
		resolved.push({
			id: "quick",
			label: "quick",
			jobIds: allJobs.slice(0, 2).map((job) => job.id),
		});
	}

	if (!resolved.some((preset) => preset.id === "full")) {
		resolved.push({
			id: "full",
			label: "full",
			jobIds: allJobs.map((job) => job.id),
		});
	}

	if (defaultPreset && !resolved.some((preset) => preset.id === defaultPreset)) {
		resolved.unshift({
			id: defaultPreset,
			label: defaultPreset,
			jobIds: allJobs.map((job) => job.id),
		});
	}

	return resolved;
}

async function selectEvent(defaultEvent: string, events: string[]): Promise<string | null> {
	const selection = await select({
		message: "Select an event",
		initialValue: events.includes(defaultEvent) ? defaultEvent : events[0],
		options: events.map((event) => ({ value: event, label: event })),
	});
	if (isCancel(selection)) {
		cancel("Canceled.");
		return null;
	}
	return selection;
}

async function selectPreset(presets: RunPreset[], current: string): Promise<RunPreset | null> {
	const selection = await select({
		message: "Select a preset",
		initialValue: current,
		options: presets.map((preset) => ({
			value: preset.id,
			label: preset.label,
		})),
	});
	if (isCancel(selection)) {
		cancel("Canceled.");
		return null;
	}
	return presets.find((preset) => preset.id === selection) ?? null;
}

async function selectJobs(
	jobs: { id: string; name: string }[],
	initial: string[],
): Promise<string[] | null> {
	const selection = await multiselect({
		message: "Select jobs to run",
		options: jobs.map((job) => ({
			value: job.id,
			label: job.name,
		})),
		initialValues: initial,
	});
	if (isCancel(selection)) {
		cancel("Canceled.");
		return null;
	}
	return selection;
}

async function promptMatrix(matrixKeys: string[]): Promise<string[] | undefined | null> {
	const hasKeys = matrixKeys.length > 0;
	const message = hasKeys
		? `Matrix override (optional, format: key:value,key:value) [available keys: ${matrixKeys.join(", ")}]`
		: "Matrix override (optional, format: key:value,key:value)";
	const selection = await text({
		message,
		placeholder: hasKeys
			? matrixKeys.map((key) => `${key}:<value>`).join(",")
			: "key:value,key:value",
	});
	if (isCancel(selection)) {
		cancel("Canceled.");
		return null;
	}
	if (!selection) {
		return undefined;
	}
	return parseMatrixInput(selection);
}

function parseMatrixInput(input: string): string[] | undefined {
	const items = input
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function collectMatrixKeys(workflow: Workflow, jobIds: string[]): string[] {
	const keys = new Set<string>();
	const jobMap = new Map(workflow.jobs.map((job) => [job.id, job]));

	for (const jobId of jobIds) {
		const matrix = jobMap.get(jobId)?.strategy?.matrix;
		if (!matrix) {
			continue;
		}
		for (const key of Object.keys(matrix)) {
			if (key === "include" || key === "exclude") {
				continue;
			}
			keys.add(key);
		}
	}

	return Array.from(keys);
}

async function buildJsonSummary(
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

function resolvePlatformMap(
	workflow: Workflow,
	jobIds: string[],
	imageMap: Record<string, string>,
	platformMap: Record<string, string>,
): { map: Record<string, string>; inferredLabels: string[] } {
	const defaultImage = "ghcr.io/catthehacker/ubuntu:act-latest";
	const inferred: Record<string, string> = {};
	const inferredLabels: string[] = [];
	const jobMap = new Map(workflow.jobs.map((job) => [job.id, job]));

	for (const jobId of jobIds) {
		const runsOn = jobMap.get(jobId)?.runsOn;
		if (!runsOn) {
			continue;
		}
		for (const label of parseRunsOnLabels(runsOn)) {
			if (imageMap[label] || platformMap[label] || inferred[label]) {
				continue;
			}
			if (!isLinuxRunnerLabel(label)) {
				continue;
			}
			inferred[label] = defaultImage;
			inferredLabels.push(label);
		}
	}

	const merged = { ...inferred, ...imageMap, ...platformMap };
	if (Object.keys(merged).length > 0) {
		return { map: merged, inferredLabels };
	}

	return {
		map: {
			"ubuntu-latest": defaultImage,
		},
		inferredLabels: ["ubuntu-latest"],
	};
}

function parseRunsOnLabels(runsOn: string): string[] {
	return runsOn
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function resolveUnrunnableJobs(
	workflow: Workflow,
	jobIds: string[],
	platformMap: Record<string, string>,
): Map<string, string> {
	const jobMap = new Map(workflow.jobs.map((job) => [job.id, job]));
	const selected = new Set(jobIds);
	const normalizedMappings = new Set(Object.keys(platformMap).map((value) => value.toLowerCase()));
	const reasons = new Map<string, string>();

	for (const jobId of jobIds) {
		const job = jobMap.get(jobId);
		if (!job) {
			continue;
		}
		if (!job.runsOn) {
			reasons.set(jobId, "missing runs-on configuration");
			continue;
		}
		const labels = parseRunsOnLabels(job.runsOn);
		const unsupported = labels.filter((label) => {
			const normalized = label.toLowerCase();
			if (normalizedMappings.has(normalized)) {
				return false;
			}
			if (isLinuxRunnerLabel(normalized)) {
				return false;
			}
			return true;
		});
		if (unsupported.length > 0) {
			reasons.set(jobId, `unsupported runner labels: ${unsupported.join(", ")}`);
		}
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const jobId of jobIds) {
			if (reasons.has(jobId)) {
				continue;
			}
			const job = jobMap.get(jobId);
			if (!job) {
				continue;
			}
			const blockingNeeds = job.needs.filter((need) => selected.has(need) && reasons.has(need));
			if (blockingNeeds.length > 0) {
				reasons.set(jobId, `depends on skipped job(s): ${blockingNeeds.join(", ")}`);
				changed = true;
			}
		}
	}

	return reasons;
}

function isLinuxRunnerLabel(label: string): boolean {
	const value = label.toLowerCase();
	if (value === "linux" || value === "ubuntu") {
		return true;
	}
	return value.startsWith("ubuntu-");
}

function resolveContainerArchitecture(configured: string | undefined): string | undefined {
	if (configured && configured !== "auto") {
		return configured;
	}

	switch (process.arch) {
		case "arm64":
			return "arm64";
		case "x64":
			return "amd64";
		default:
			return undefined;
	}
}

function resolveSupportedEvents(workflow: Workflow): string[] {
	if (workflow.events.length > 0) {
		return workflow.events;
	}
	return ["push", "pull_request", "workflow_dispatch"];
}

async function runWithInk(
	adapter: EngineAdapter,
	plan: RunPlan,
	context: EngineContext,
	workflow: Workflow,
	runStoreBase: string,
): Promise<EngineRunResult> {
	return new Promise((resolve) => {
		let resolved = false;
		let finalResult: EngineRunResult | null = null;
		const handleComplete = (result: EngineRunResult): void => {
			if (resolved) {
				return;
			}
			finalResult = result;
		};

		const { waitUntilExit, unmount } = render(
			React.createElement(RunView, {
				adapter,
				context,
				plan,
				workflow,
				runStoreBase,
				onComplete: handleComplete,
			}),
		);

		waitUntilExit().then(() => {
			unmount();
			if (resolved) {
				return;
			}
			resolved = true;
			resolve(finalResult ?? { exitCode: 1, logsPath: "" });
		});
	});
}
