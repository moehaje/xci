import process from "node:process";
import type { RunPreset, Workflow } from "../core/types.js";

export function resolvePresets(
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

export function resolveSupportedEvents(workflow: Workflow): string[] {
	if (workflow.events.length > 0) {
		return workflow.events;
	}
	return ["push", "pull_request", "workflow_dispatch"];
}

export function resolvePlatformMap(
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

export function resolveUnrunnableJobs(
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

export function resolveContainerArchitecture(configured: string | undefined): string | undefined {
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

function parseRunsOnLabels(runsOn: string): string[] {
	return runsOn
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function isLinuxRunnerLabel(label: string): boolean {
	const value = label.toLowerCase();
	if (value === "linux" || value === "ubuntu") {
		return true;
	}
	return value.startsWith("ubuntu-");
}
