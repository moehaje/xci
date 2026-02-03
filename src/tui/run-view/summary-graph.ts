import type { RunStatus, Workflow } from "../../core/types.js";

export type JobStatusSnapshot = {
	jobId: string;
	status: RunStatus;
	durationMs?: number;
};

export type CardRow = {
	jobId: string;
	label: string;
	fullLabel: string;
	status: RunStatus;
	durationMs?: number;
};

export type CardNode = {
	id: string;
	stage: number;
	header?: string;
	rows: CardRow[];
	status: RunStatus;
};

export type StageNode = {
	index: number;
	cards: CardNode[];
};

export type Edge = {
	id: string;
	fromCardId: string;
	toCardId: string;
	status: RunStatus;
};

export type SummaryGraph = {
	stages: StageNode[];
	edges: Edge[];
};

const STATUS_PRIORITY: Record<RunStatus, number> = {
	success: 0,
	canceled: 1,
	pending: 2,
	running: 3,
	failed: 4,
};

const PLATFORM_SUFFIX_PATTERN =
	/[ _-](linux|macos|windows|ubuntu(?:-latest)?|macos-latest|windows-latest|arm64|amd64|x64)$/i;

export function buildSummaryGraph(workflow: Workflow, jobs: JobStatusSnapshot[]): SummaryGraph {
	if (jobs.length === 0) {
		return { stages: [], edges: [] };
	}

	const selectedJobIds = new Set(jobs.map((job) => job.jobId));
	const snapshotByJob = new Map(jobs.map((job) => [job.jobId, job]));
	const workflowJobById = new Map(workflow.jobs.map((job) => [job.id, job]));

	const depths = computeDepths(selectedJobIds, workflowJobById);
	const maxDepth = Math.max(...depths.values(), 0);
	const stageJobIds: string[][] = Array.from({ length: maxDepth + 1 }, () => []);

	for (const job of jobs) {
		const depth = depths.get(job.jobId) ?? 0;
		stageJobIds[depth]?.push(job.jobId);
	}

	const cardById = new Map<string, CardNode>();
	const cardIdByJobId = new Map<string, string>();

	const stages: StageNode[] = stageJobIds.map((jobIds, index) => {
		const cards = buildStageCards(index, jobIds, workflowJobById, snapshotByJob);
		for (const card of cards) {
			cardById.set(card.id, card);
			for (const row of card.rows) {
				cardIdByJobId.set(row.jobId, card.id);
			}
		}
		return { index, cards };
	});

	const edgeMap = new Map<string, Edge>();
	for (const jobId of selectedJobIds) {
		const job = workflowJobById.get(jobId);
		if (!job) {
			continue;
		}
		for (const need of job.needs) {
			if (!selectedJobIds.has(need)) {
				continue;
			}
			const fromCardId = cardIdByJobId.get(need);
			const toCardId = cardIdByJobId.get(jobId);
			if (!fromCardId || !toCardId || fromCardId === toCardId) {
				continue;
			}
			const key = `${fromCardId}=>${toCardId}`;
			const fromCard = cardById.get(fromCardId);
			const toCard = cardById.get(toCardId);
			if (!fromCard || !toCard) {
				continue;
			}
			const status = pickHigherPriorityStatus(fromCard.status, toCard.status);
			const existing = edgeMap.get(key);
			if (!existing) {
				edgeMap.set(key, {
					id: `edge-${edgeMap.size + 1}`,
					fromCardId,
					toCardId,
					status,
				});
				continue;
			}
			existing.status = pickHigherPriorityStatus(existing.status, status);
		}
	}

	return {
		stages,
		edges: Array.from(edgeMap.values()),
	};
}

function computeDepths(
	selectedJobIds: Set<string>,
	workflowJobById: Map<string, Workflow["jobs"][number]>,
): Map<string, number> {
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
		const job = workflowJobById.get(jobId);
		const selectedNeeds = (job?.needs ?? []).filter((need) => selectedJobIds.has(need));
		const depth =
			selectedNeeds.length === 0 ? 0 : Math.max(...selectedNeeds.map((need) => resolveDepth(need))) + 1;
		depths.set(jobId, depth);
		visiting.delete(jobId);
		return depth;
	};

	for (const jobId of selectedJobIds) {
		resolveDepth(jobId);
	}
	return depths;
}

function buildStageCards(
	stage: number,
	jobIds: string[],
	workflowJobById: Map<string, Workflow["jobs"][number]>,
	snapshotByJob: Map<string, JobStatusSnapshot>,
): CardNode[] {
	const grouped = new Map<string, string[]>();
	for (const jobId of jobIds) {
		const jobName = workflowJobById.get(jobId)?.name ?? jobId;
		const key = normalizeGroupKey(jobName);
		const list = grouped.get(key) ?? [];
		list.push(jobId);
		grouped.set(key, list);
	}

	const cards: CardNode[] = [];
	for (const [groupKey, members] of grouped.entries()) {
		if (members.length === 1) {
			const singleJobId = members[0];
			const snapshot = snapshotByJob.get(singleJobId);
			const jobName = workflowJobById.get(singleJobId)?.name ?? singleJobId;
			cards.push({
				id: `card-${stage}-${cards.length + 1}`,
				stage,
				rows: [
					{
						jobId: singleJobId,
						label: jobName,
						fullLabel: jobName,
						status: snapshot?.status ?? "pending",
						durationMs: snapshot?.durationMs,
					},
				],
				status: snapshot?.status ?? "pending",
			});
			continue;
		}

		const rows = members
			.map((jobId) => {
				const snapshot = snapshotByJob.get(jobId);
				const fullLabel = workflowJobById.get(jobId)?.name ?? jobId;
				return {
					jobId,
					label: stripGroupPrefix(fullLabel, groupKey),
					fullLabel,
					status: snapshot?.status ?? "pending",
					durationMs: snapshot?.durationMs,
				};
			})
			.sort((a, b) => a.fullLabel.localeCompare(b.fullLabel));

		cards.push({
			id: `card-${stage}-${cards.length + 1}`,
			stage,
			header: groupKey,
			rows,
			status: rows.reduce<RunStatus>(
				(acc, row) => pickHigherPriorityStatus(acc, row.status),
				"success",
			),
		});
	}

	return cards;
}

function pickHigherPriorityStatus(a: RunStatus, b: RunStatus): RunStatus {
	return STATUS_PRIORITY[a] >= STATUS_PRIORITY[b] ? a : b;
}

function normalizeGroupKey(label: string): string {
	let base = label.trim();
	const withoutBracket = base.replace(/\s*(\([^)]*\)|\[[^\]]*\])\s*$/, "");
	if (withoutBracket !== base) {
		base = withoutBracket;
	}
	const withoutPlatform = base.replace(PLATFORM_SUFFIX_PATTERN, "");
	if (withoutPlatform.trim().length > 0 && withoutPlatform !== base) {
		base = withoutPlatform;
	}
	return base.trim().replace(/\s+/g, " ");
}

function stripGroupPrefix(label: string, groupKey: string): string {
	const normalizedLabel = label.trim().replace(/\s+/g, " ");
	if (normalizedLabel === groupKey) {
		return normalizedLabel;
	}
	if (normalizedLabel.startsWith(`${groupKey} `)) {
		return normalizedLabel.slice(groupKey.length).trimStart();
	}
	if (normalizedLabel.startsWith(`${groupKey}-`)) {
		return normalizedLabel.slice(groupKey.length + 1).trimStart();
	}
	if (normalizedLabel.startsWith(`${groupKey}_`)) {
		return normalizedLabel.slice(groupKey.length + 1).trimStart();
	}
	if (normalizedLabel.startsWith(`${groupKey} (`) || normalizedLabel.startsWith(`${groupKey} [`)) {
		return normalizedLabel.slice(groupKey.length).trimStart();
	}
	return normalizedLabel;
}
