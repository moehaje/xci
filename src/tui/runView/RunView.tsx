import fs from "node:fs";
import path from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	EngineAdapter,
	EngineContext,
	EngineRunResult,
} from "../../core/engine.js";
import type {
	RunPlan,
	RunRecord,
	RunStatus,
	Workflow,
} from "../../core/types.js";
import {
	DEFAULT_VIEW,
	LOG_TAIL_LINES,
	POLL_INTERVAL_MS,
	SPINNER_FRAMES,
} from "./constants.js";
import { buildDiagramLines } from "./diagram.js";
import { formatDuration } from "./format.js";
import { mergeStepStatuses, parseStepData } from "./parser.js";
import { colorForStatus, renderStatusGlyph, STATUS_LABELS } from "./status.js";

export type RunViewProps = {
	adapter: EngineAdapter;
	context: EngineContext;
	plan: RunPlan;
	workflow: Workflow;
	runStoreBase: string;
	onComplete: (result: EngineRunResult) => void;
};

type ViewMode = "summary" | "details";

export function RunView({
	adapter,
	context,
	plan,
	workflow,
	runStoreBase,
	onComplete,
}: RunViewProps): JSX.Element {
	const { exit } = useApp();
	const [runRecord, setRunRecord] = useState<RunRecord | null>(null);
  const [statusText, setStatusText] = useState<RunStatus>("pending");
	const [readError, setReadError] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_VIEW);
	const [selectedJobIndex, setSelectedJobIndex] = useState(0);
	const [selectedStepIndex, setSelectedStepIndex] = useState(0);
	const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>(
		{},
	);
	const [stepOutputs, setStepOutputs] = useState<Record<string, string[]>>({});
	const [stepStatuses, setStepStatuses] = useState<Record<string, RunStatus>>(
		{},
	);
	const [logError, setLogError] = useState<string | null>(null);
	const [spinnerIndex, setSpinnerIndex] = useState(0);
	const running = useRef(false);

	const appendOutput = useCallback((_chunk: string) => {}, []);

	const orderedJobs = useMemo(() => {
		return plan.jobs.map((job) => {
			const record = runRecord?.jobs.find((item) => item.jobId === job.jobId);
			return {
				jobId: job.jobId,
				status: record?.status ?? "pending",
				durationMs: record?.durationMs,
			};
		});
	}, [plan.jobs, runRecord]);

	const jobLookup = useMemo(() => {
		return new Map(workflow.jobs.map((job) => [job.id, job]));
	}, [workflow.jobs]);

	const selectedJob = orderedJobs[selectedJobIndex];
	const selectedJobModel = selectedJob
		? (jobLookup.get(selectedJob.jobId) ?? null)
		: null;
	const selectedSteps = useMemo(
		() => selectedJobModel?.steps ?? [],
		[selectedJobModel],
	);

	const diagramLines = useMemo(() => {
		return buildDiagramLines(workflow, orderedJobs, spinnerIndex);
	}, [orderedJobs, spinnerIndex, workflow]);

	useEffect(() => {
		if (running.current) {
			return;
		}
		running.current = true;
		setStatusText("running");

		const start = async (): Promise<void> => {
			const result = await adapter.run(plan, {
				...context,
				onOutput: appendOutput,
			});
			setStatusText(result.exitCode === 0 ? "success" : "failed");
			onComplete(result);
		};

		start();
	}, [adapter, appendOutput, context, onComplete, plan]);

	useEffect(() => {
		const runPath = path.join(runStoreBase, plan.runId, "run.json");
		const interval = setInterval(() => {
			if (!fs.existsSync(runPath)) {
				return;
			}
			try {
				const raw = fs.readFileSync(runPath, "utf-8");
				const parsed = JSON.parse(raw) as RunRecord;
				setRunRecord(parsed);
				setReadError(null);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				setReadError(`Failed to read run record: ${message}`);
			}
		}, POLL_INTERVAL_MS);

		return () => clearInterval(interval);
	}, [plan.runId, runStoreBase]);

	useEffect(() => {
		const interval = setInterval(() => {
			setSpinnerIndex((prev) => (prev + 1) % SPINNER_FRAMES.length);
		}, 120);
		return () => clearInterval(interval);
	}, []);

	useEffect(() => {
		if (!runRecord?.logDir) {
			return;
		}
		const selectedJobRef = orderedJobs[selectedJobIndex];
		if (!selectedJobRef) {
			return;
		}
		const logPath = path.join(runRecord.logDir, `${selectedJobRef.jobId}.log`);
		const interval = setInterval(() => {
			if (!fs.existsSync(logPath)) {
				return;
			}
			try {
				const raw = fs.readFileSync(logPath, "utf-8");
				const parsed = parseStepData(selectedSteps, raw, selectedJobRef.status);
				setStepStatuses((prev) => mergeStepStatuses(prev, parsed.statuses));
				setStepOutputs(parsed.outputs);
				setLogError(null);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				setLogError(`Failed to read logs: ${message}`);
			}
		}, POLL_INTERVAL_MS);
		return () => clearInterval(interval);
	}, [runRecord?.logDir, selectedJobIndex, selectedSteps, orderedJobs]);

	useInput((input, key) => {
		if (input === "q" && statusText !== "running") {
			exit();
			return;
		}
		if (input === "tab") {
			setViewMode((prev) => (prev === "summary" ? "details" : "summary"));
			return;
		}
		if (input === "s") {
			setViewMode("summary");
			return;
		}
		if (input === "d") {
			setViewMode("details");
			return;
		}

		if (viewMode === "details") {
			if (key.leftArrow) {
				setSelectedJobIndex((prev) => Math.max(0, prev - 1));
				setSelectedStepIndex(0);
				return;
			}
			if (key.rightArrow) {
				setSelectedJobIndex((prev) =>
					Math.min(orderedJobs.length - 1, prev + 1),
				);
				setSelectedStepIndex(0);
				return;
			}
			if (key.upArrow) {
				setSelectedStepIndex((prev) => Math.max(0, prev - 1));
				return;
			}
			if (key.downArrow) {
				setSelectedStepIndex((prev) =>
					Math.min(selectedSteps.length - 1, prev + 1),
				);
				return;
			}
			if (input === " " || key.return) {
				const step = selectedSteps[selectedStepIndex];
				if (step) {
					setExpandedSteps((prev) => ({
						...prev,
						[step.id]: !prev[step.id],
					}));
				}
			}
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box flexDirection="column" marginBottom={1}>
				<Text>
					{workflow.name} · {plan.event.name} · {plan.runId}
				</Text>
        <Text dimColor>
          {renderStatusGlyph(statusText, spinnerIndex)} {STATUS_LABELS[statusText]}
        </Text>
			</Box>

			{viewMode === "summary" ? (
				<Box
					flexDirection="column"
					borderStyle="round"
					paddingX={2}
					paddingY={1}
				>
					<Text dimColor>Summary</Text>
					{diagramLines.map((line, index) => (
						<Text key={`${line}-${index}`}>{line}</Text>
					))}
				</Box>
			) : (
				<Box flexDirection="row" gap={2}>
					<Box
						flexDirection="column"
						width={28}
						borderStyle="round"
						paddingX={1}
						paddingY={1}
					>
						<Text dimColor>Jobs</Text>
						{orderedJobs.map((job, index) => {
							const isSelected = index === selectedJobIndex;
							const glyph = renderStatusGlyph(job.status, spinnerIndex);
							return (
								<Text
									key={job.jobId}
									color={colorForStatus(job.status)}
									backgroundColor={isSelected ? "gray" : undefined}
									bold={isSelected}
								>
									{glyph} {job.jobId}
								</Text>
							);
						})}
					</Box>
					<Box
						flexDirection="column"
						flexGrow={1}
						borderStyle="round"
						paddingX={2}
						paddingY={1}
					>
						<Text>{selectedJob?.jobId ?? "No job selected"}</Text>
						{selectedJob ? (
							<Text dimColor>
								{STATUS_LABELS[selectedJob.status]}{" "}
								{selectedJob.durationMs
									? `· ${formatDuration(selectedJob.durationMs)}`
									: ""}
							</Text>
						) : null}
						<Box flexDirection="column" marginTop={1}>
							{selectedSteps.length === 0 ? (
								<Text dimColor>No steps found.</Text>
							) : (
								selectedSteps.map((step, index) => {
									const isSelected = index === selectedStepIndex;
									const isExpanded = Boolean(expandedSteps[step.id]);
									const stepStatus = stepStatuses[step.id] ?? "pending";
									const stepOutput = stepOutputs[step.id] ?? [];
									const caret = isExpanded ? "▾" : "▸";
									const glyph = renderStatusGlyph(stepStatus, spinnerIndex);
									return (
										<Box flexDirection="column" key={step.id}>
											<Text
												color={colorForStatus(stepStatus)}
												backgroundColor={isSelected ? "gray" : undefined}
												bold={isSelected}
											>
												{glyph} {caret} {step.name}
											</Text>
											{isExpanded ? (
												<Box flexDirection="column" paddingLeft={2}>
													{stepOutput.length === 0 ? (
														<Text dimColor>Waiting for output...</Text>
													) : (
														stepOutput
															.slice(-LOG_TAIL_LINES)
															.map((line, lineIndex) => (
																<Text key={`${step.id}-${lineIndex}`} dimColor>
																	{line}
																</Text>
															))
													)}
												</Box>
											) : null}
										</Box>
									);
								})
							)}
						</Box>
					</Box>
				</Box>
			)}

			<Box marginTop={1}>
				<Text dimColor>
					Tab: switch view · S: summary · D: details · Arrows: navigate ·
					Space/Enter: toggle · Q: exit
				</Text>
			</Box>
			{statusText !== "running" ? (
				<Box marginTop={1}>
					<Text dimColor>Run finished. Press q to exit.</Text>
				</Box>
			) : null}
			{readError ? (
				<Box marginTop={1}>
					<Text color="red">{readError}</Text>
				</Box>
			) : null}
			{logError ? (
				<Box marginTop={1}>
					<Text color="red">{logError}</Text>
				</Box>
			) : null}
		</Box>
	);
}
