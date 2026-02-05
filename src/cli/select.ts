import { cancel, isCancel, multiselect, select, text } from "@clack/prompts";
import type { RunPreset, Workflow } from "../core/types.js";
import type { CliOptions } from "./args.js";

export function resolveWorkflow(workflows: Workflow[], selector?: string): Workflow | undefined {
	if (!selector) {
		return workflows.length === 1 ? workflows[0] : undefined;
	}
	return workflows.find((wf) => wf.id.endsWith(selector) || wf.name === selector);
}

export function resolveJobsFromArgs(options: CliOptions, preset?: RunPreset): string[] | undefined {
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

export async function selectEvent(defaultEvent: string, events: string[]): Promise<string | null> {
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

export async function selectPreset(
	presets: RunPreset[],
	current: string,
): Promise<RunPreset | null> {
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

export async function selectJobs(
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

export async function promptMatrix(matrixKeys: string[]): Promise<string[] | undefined | null> {
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

export function collectMatrixKeys(workflow: Workflow, jobIds: string[]): string[] {
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

function parseMatrixInput(input: string): string[] | undefined {
	const items = input
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}
