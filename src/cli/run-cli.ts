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
import { prepareInputFiles } from "./inputs.js";
import { runPreflightChecks } from "./preflight.js";

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
	if (args.command !== "run") {
		process.stderr.write("Only `xci run` is supported right now.\n");
		process.exitCode = 2;
		return;
	}

	const repoRoot = process.cwd();
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
	const isTty = Boolean(process.stdout.isTTY);
	let eventName = args.event ?? "push";

	let workflow = resolveWorkflow(workflows, args.workflow);
	if (!workflow && isTty) {
		intro("XCI");
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

		const matrixChoice = await promptMatrix();
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
	const ordered = sortJobsByNeeds(workflow, expanded);
	const effectivePayloadPath = args.eventPath ?? preset?.event?.payloadPath;

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

	const platformMap = resolvePlatformMap(config.runtime.image, config.runtime.platformMap);

	const engineContext: EngineContext = {
		repoRoot,
		workflowsPath: path.dirname(workflow.path),
		eventName: plan.event.name,
		eventPayloadPath: plan.event.payloadPath,
		artifactDir: path.join(repoRoot, ".xci", "runs", plan.runId, "artifacts"),
		containerArchitecture: config.runtime.architecture,
		platformMap,
		envFile: inputFiles.envFile,
		varsFile: inputFiles.varsFile,
		secretsFile: inputFiles.secretsFile,
		matrixOverride: plan.jobs[0]?.matrix ?? undefined,
	};

	const preflightOk = await runPreflightChecks(config.runtime.container, isTty && !args.json);
	if (!preflightOk) {
		process.exitCode = 1;
		return;
	}

	const adapter = new ActAdapter();
	const planned = await adapter.plan(engineContext, plan);

	let result: EngineRunResult | null = null;
	if (isTty && !args.json) {
		result = await runWithInk(
			adapter,
			planned,
			engineContext,
			workflow,
			path.join(repoRoot, ".xci", "runs"),
		);
		outro(`Logs: ${result.logsPath}`);
	} else {
		if (!args.json) {
			process.stdout.write(`Running ${planned.jobs.length} job(s) with act...\\n`);
		}
		result = await adapter.run(planned, engineContext);
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
	process.exitCode = result.exitCode;
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

async function promptMatrix(): Promise<string[] | undefined | null> {
	const selection = await text({
		message: "Matrix override (optional, format: key:value,key:value)",
		placeholder: "node:20,os:ubuntu-latest",
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
	imageMap: Record<string, string>,
	platformMap: Record<string, string>,
): Record<string, string> {
	const merged = { ...imageMap, ...platformMap };
	if (Object.keys(merged).length > 0) {
		return merged;
	}
	return {
		"ubuntu-latest": "ghcr.io/catthehacker/ubuntu:act-latest",
	};
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
