import type { RunStatus, Workflow } from "../../../core/types.js";
import { formatDuration } from "../utils/format.js";
import { colorForStatus, formatStatusText } from "../utils/status.js";

type DiagramColor = "green" | "red" | "yellow" | "gray" | undefined;

type DiagramLabel = {
	text: string;
	color?: DiagramColor;
};

export type DiagramSegment = {
	id: string;
	text: string;
	color?: DiagramColor;
	dim?: boolean;
};

export type DiagramLine = {
	id: string;
	segments: DiagramSegment[];
};

export function buildDiagramLines(
	workflow: Workflow,
	jobs: { jobId: string; status: RunStatus; durationMs?: number }[],
	spinnerIndex: number,
): DiagramLine[] {
	if (jobs.length === 0) {
		return [
			{
				id: "line-empty",
				segments: [{ id: "empty-message", text: "No jobs selected.", dim: true }],
			},
		];
	}
	const jobMap = new Map(workflow.jobs.map((job) => [job.id, job]));
	const depths = new Map<string, number>();
	const visiting = new Set<string>();

	const resolveDepth = (jobId: string): number => {
		if (depths.has(jobId)) {
			return depths.get(jobId) ?? 0;
		}
		if (visiting.has(jobId)) {
			return 0;
		}
		visiting.add(jobId);
		const job = jobMap.get(jobId);
		const needs = job?.needs ?? [];
		const depth = needs.length === 0 ? 0 : Math.max(...needs.map(resolveDepth)) + 1;
		depths.set(jobId, depth);
		visiting.delete(jobId);
		return depth;
	};

	for (const job of jobs) {
		resolveDepth(job.jobId);
	}
	const maxDepth = Math.max(...Array.from(depths.values()), 0);
	const columns: DiagramLabel[][] = Array.from({ length: maxDepth + 1 }, () => []);

	jobs.forEach((job) => {
		const depth = depths.get(job.jobId) ?? 0;
		columns[depth].push(buildJobLabel(job, spinnerIndex));
	});

	const columnWidths = columns.map((column) =>
		Math.max(0, ...column.map((item) => item.text.length), 16),
	);
	const maxRows = Math.max(...columns.map((column) => column.length), 1);

	const lines: DiagramLine[] = [];
	for (let row = 0; row < maxRows; row += 1) {
		const segments: DiagramSegment[] = [];
		for (let col = 0; col < columns.length; col += 1) {
			const label = columns[col][row];
			const text = label?.text ?? "";
			if (label) {
				segments.push({
					id: `job-${col}-${row}-${label.text}`,
					text,
					color: label.color,
				});
			}
			const padded = padRight(text, columnWidths[col]);
			if (padded.length > text.length) {
				segments.push({
					id: `pad-${col}-${row}`,
					text: padded.slice(text.length),
				});
			}
			if (col < columns.length - 1) {
				segments.push({
					id: `arrow-${col}-${row}`,
					text: "  ──→  ",
					dim: true,
				});
			}
		}
		const trimmed = trimDiagramSegments(segments);
		lines.push({ id: `line-${row}`, segments: trimmed });
	}
	return lines;
}

function buildJobLabel(
	job: { jobId: string; status: RunStatus; durationMs?: number },
	spinnerIndex: number,
): DiagramLabel {
	const status = formatStatusText(job.status, spinnerIndex);
	const duration = job.durationMs ? ` ${formatDuration(job.durationMs)}` : "";
	return {
		text: `${status} ${job.jobId}${duration}`,
		color: colorForStatus(job.status),
	};
}

function padRight(value: string, length: number): string {
	if (value.length >= length) {
		return value;
	}
	return value + " ".repeat(length - value.length);
}

function trimDiagramSegments(segments: DiagramSegment[]): DiagramSegment[] {
	if (segments.length === 0) {
		return segments;
	}
	const trimmed = [...segments];
	while (trimmed.length > 0) {
		const last = trimmed[trimmed.length - 1];
		const trimmedText = last.text.replace(/\s+$/g, "");
		if (trimmedText.length === last.text.length) {
			break;
		}
		if (trimmedText.length === 0) {
			trimmed.pop();
			continue;
		}
		trimmed[trimmed.length - 1] = { ...last, text: trimmedText };
		break;
	}
	return trimmed;
}
