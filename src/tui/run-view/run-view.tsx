import fs from "node:fs";
import path from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineAdapter, EngineContext, EngineRunResult } from "../../core/engine.js";
import type { Job, RunPlan, RunRecord, RunStatus, Workflow } from "../../core/types.js";
import {
	DEFAULT_VIEW,
	LOG_TAIL_LINES,
	POLL_INTERVAL_MS,
	SPINNER_FRAMES,
	SUMMARY_GRAPH_MIN_WIDTH,
} from "./constants.js";
import type { DiagramLine } from "./diagram.js";
import { buildDiagramLines } from "./diagram.js";
import { formatDuration } from "./format.js";
import { mergeStepStatuses, parseStepData } from "./parser.js";
import { colorForStatus, renderStatusGlyph, STATUS_LABELS } from "./status.js";
import { buildSummaryGraph } from "./summary-graph.js";
import { estimateSummaryGraphWidth, SummaryGraphView } from "./summary-graph-view.js";

export type RunViewProps = {
	adapter: EngineAdapter;
	context: EngineContext;
	plan: RunPlan;
	workflow: Workflow;
	runStoreBase: string;
	onComplete: (result: EngineRunResult) => void;
};

type ViewMode = "summary" | "details";
type DetailsPane = "jobs" | "steps";
const DETAILS_ROW_PADDING_X = 2;
const DETAILS_JOB_ROW_WIDTH = 30;
const DETAILS_STEP_ROW_WIDTH = 36;
const DETAILS_VIEW_RESERVED_ROWS = 18;

export function RunView({
	adapter,
	context,
	plan,
	workflow,
	runStoreBase,
	onComplete,
}: RunViewProps): JSX.Element {
	const { exit } = useApp();
	const { stdout } = useStdout();
	const [runRecord, setRunRecord] = useState<RunRecord | null>(null);
	const [statusText, setStatusText] = useState<RunStatus>("pending");
	const [readError, setReadError] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_VIEW);
	const [selectedJobIndex, setSelectedJobIndex] = useState(0);
	const [selectedStepIndex, setSelectedStepIndex] = useState(0);
	const [focusedPane, setFocusedPane] = useState<DetailsPane>("jobs");
	const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
	const [stepOutputs, setStepOutputs] = useState<Record<string, string[]>>({});
	const [stepStatuses, setStepStatuses] = useState<Record<string, RunStatus>>({});
	const [logError, setLogError] = useState<string | null>(null);
	const [spinnerIndex, setSpinnerIndex] = useState(0);
	const [liveMode, setLiveMode] = useState(false);
	const [terminalWidth, setTerminalWidth] = useState<number>(stdout.columns ?? 120);
	const [terminalHeight, setTerminalHeight] = useState<number>(stdout.rows ?? 40);
	const running = useRef(false);
	const runReadInFlight = useRef(false);
	const logReadInFlight = useRef(false);
	const logBuffers = useRef(new Map<string, string>());
	const liveOutputUsed = useRef(false);
	const flushTimer = useRef<NodeJS.Timeout | null>(null);
	const selectedJobRef = useRef<{ jobId: string; status: RunStatus } | undefined>(undefined);
	const selectedStepsRef = useRef<Job["steps"]>([]);

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
	const selectedJobModel = selectedJob ? (jobLookup.get(selectedJob.jobId) ?? null) : null;
	const selectedSteps = useMemo(() => selectedJobModel?.steps ?? [], [selectedJobModel]);

	useEffect(() => {
		selectedJobRef.current = selectedJob ?? undefined;
		selectedStepsRef.current = selectedSteps;
	}, [selectedJob, selectedSteps]);

	useEffect(() => {
		setSelectedStepIndex((prev) => {
			if (selectedSteps.length === 0) {
				return 0;
			}
			return Math.min(prev, selectedSteps.length - 1);
		});
	}, [selectedSteps.length]);

	const appendOutput = useCallback(
		(chunk: string, _source: "stdout" | "stderr", jobId?: string) => {
			if (!jobId) {
				return;
			}
			liveOutputUsed.current = true;
			if (!liveMode) {
				setLiveMode(true);
			}
			const current = logBuffers.current.get(jobId) ?? "";
			const next = current + chunk;
			logBuffers.current.set(jobId, next);
			const currentJob = selectedJobRef.current;
			if (!currentJob || jobId !== currentJob.jobId) {
				return;
			}
			if (flushTimer.current) {
				return;
			}
			flushTimer.current = setTimeout(() => {
				flushTimer.current = null;
				const buffered = logBuffers.current.get(jobId);
				const jobNow = selectedJobRef.current;
				if (!buffered || !jobNow || jobNow.jobId !== jobId) {
					return;
				}
				const parsed = parseStepData(selectedStepsRef.current, buffered, jobNow.status);
				setStepStatuses((prev) => mergeStepStatuses(prev, parsed.statuses));
				setStepOutputs(parsed.outputs);
			}, 100);
		},
		[liveMode],
	);

	const diagramLines = useMemo<DiagramLine[]>(() => {
		return buildDiagramLines(workflow, orderedJobs, spinnerIndex);
	}, [orderedJobs, spinnerIndex, workflow]);
	const summaryGraph = useMemo(
		() => buildSummaryGraph(workflow, orderedJobs),
		[orderedJobs, workflow],
	);
	const shouldUseSummaryFallback = useMemo(() => {
		if (terminalWidth < SUMMARY_GRAPH_MIN_WIDTH) {
			return true;
		}
		const estimatedWidth = estimateSummaryGraphWidth(summaryGraph.stages.length);
		return estimatedWidth > terminalWidth;
	}, [summaryGraph.stages.length, terminalWidth]);
	const maxDetailsLogLines = useMemo(() => {
		const available = terminalHeight - DETAILS_VIEW_RESERVED_ROWS;
		return Math.max(2, Math.min(LOG_TAIL_LINES, available));
	}, [terminalHeight]);
	const statusColor = colorForStatus(statusText);
	const statusDim = statusText === "pending";

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
			if (runReadInFlight.current) {
				return;
			}
			runReadInFlight.current = true;
			void (async () => {
				try {
					const raw = await fs.promises.readFile(runPath, "utf-8");
					const parsed = JSON.parse(raw) as RunRecord;
					setRunRecord(parsed);
					setReadError(null);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Unknown error";
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						setReadError(`Failed to read run record: ${message}`);
					}
				} finally {
					runReadInFlight.current = false;
				}
			})();
		}, POLL_INTERVAL_MS);

		return () => clearInterval(interval);
	}, [plan.runId, runStoreBase]);

	useEffect(() => {
		const interval = setInterval(() => {
			setSpinnerIndex((prev) => (prev + 1) % SPINNER_FRAMES.length);
		}, 140);
		return () => clearInterval(interval);
	}, []);

	useEffect(() => {
		const handleResize = (): void => {
			setTerminalWidth(stdout.columns ?? 120);
			setTerminalHeight(stdout.rows ?? 40);
		};
		handleResize();
		stdout.on("resize", handleResize);
		return () => {
			stdout.off("resize", handleResize);
		};
	}, [stdout]);

	useEffect(() => {
		if (!runRecord?.logDir) {
			return;
		}
		const currentJob = orderedJobs[selectedJobIndex];
		if (!currentJob) {
			return;
		}
		if (liveMode || liveOutputUsed.current) {
			const buffer = logBuffers.current.get(currentJob.jobId);
			if (buffer) {
				const parsed = parseStepData(selectedSteps, buffer, currentJob.status);
				setStepStatuses((prev) => mergeStepStatuses(prev, parsed.statuses));
				setStepOutputs(parsed.outputs);
			}
			return;
		}
		const logPath = path.join(runRecord.logDir, `${currentJob.jobId}.log`);
		const interval = setInterval(() => {
			if (logReadInFlight.current) {
				return;
			}
			logReadInFlight.current = true;
			void (async () => {
				try {
					const raw = await fs.promises.readFile(logPath, "utf-8");
					const parsed = parseStepData(selectedSteps, raw, currentJob.status);
					setStepStatuses((prev) => mergeStepStatuses(prev, parsed.statuses));
					setStepOutputs(parsed.outputs);
					setLogError(null);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Unknown error";
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						setLogError(`Failed to read logs: ${message}`);
					}
				} finally {
					logReadInFlight.current = false;
				}
			})();
		}, POLL_INTERVAL_MS);
		return () => clearInterval(interval);
	}, [runRecord?.logDir, selectedJobIndex, selectedSteps, orderedJobs, liveMode]);

	useInput((input, key) => {
		if (input === "q" && statusText !== "running") {
			exit();
			return;
		}
		if (key.tab || input === "\t") {
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
				setFocusedPane("jobs");
				return;
			}
			if (key.rightArrow) {
				setFocusedPane("steps");
				return;
			}
			if (key.upArrow) {
				if (focusedPane === "jobs") {
					setSelectedJobIndex((prev) => Math.max(0, prev - 1));
					setSelectedStepIndex(0);
				} else {
					setSelectedStepIndex((prev) => Math.max(0, prev - 1));
				}
				return;
			}
			if (key.downArrow) {
				if (focusedPane === "jobs") {
					setSelectedJobIndex((prev) => Math.min(orderedJobs.length - 1, prev + 1));
					setSelectedStepIndex(0);
				} else {
					setSelectedStepIndex((prev) => Math.min(selectedSteps.length - 1, prev + 1));
				}
				return;
			}
			if ((input === " " || key.return) && focusedPane === "steps") {
				const step = selectedSteps[selectedStepIndex];
				if (step) {
					setExpandedSteps((prev) => (prev[step.id] ? {} : { [step.id]: true }));
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
				<Text color={statusColor} dimColor={statusDim}>
					{renderStatusGlyph(statusText, spinnerIndex)} {STATUS_LABELS[statusText]}
				</Text>
			</Box>

			{viewMode === "summary" ? (
				shouldUseSummaryFallback ? (
					<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
						<Text dimColor>Summary</Text>
						{diagramLines.map((line) => (
							<Text key={line.id}>
								{line.segments.map((segment) => (
									<Text key={segment.id} color={segment.color} dimColor={segment.dim}>
										{segment.text}
									</Text>
								))}
							</Text>
						))}
					</Box>
				) : (
					<SummaryGraphView graph={summaryGraph} spinnerIndex={spinnerIndex} />
				)
			) : (
				<Box flexDirection="column">
					<Box flexDirection="row">
						<Box flexDirection="column" width={34}>
							<Text dimColor>Jobs {focusedPane === "jobs" ? "•" : ""}</Text>
							{orderedJobs.map((job, index) => {
								const isSelected = index === selectedJobIndex;
								const glyph = renderStatusGlyph(job.status, spinnerIndex);
								const rowText = formatDetailsRow(
									`${glyph} ${job.jobId}`,
									DETAILS_JOB_ROW_WIDTH,
									DETAILS_ROW_PADDING_X,
								);
								return (
									<Text
										key={job.jobId}
										color={colorForStatus(job.status)}
										backgroundColor={isSelected ? "gray" : undefined}
										bold={isSelected && focusedPane === "jobs"}
										dimColor={isSelected && focusedPane !== "jobs"}
									>
										{rowText}
									</Text>
								);
							})}
						</Box>
						<Box flexDirection="column">
							<Text dimColor>│</Text>
							{Array.from(
								{
									length: Math.max(
										orderedJobs.length,
										selectedSteps.length + (selectedSteps.length === 0 ? 4 : 3),
									),
								},
								(_, rowIndex) => `divider-${rowIndex + 1}`,
							).map((dividerKey) => (
								<Text key={dividerKey} dimColor>
									│
								</Text>
							))}
						</Box>
						<Box flexDirection="column" marginLeft={1} flexGrow={1}>
							<Text dimColor>Steps {focusedPane === "steps" ? "•" : ""}</Text>
							<Text>{selectedJob?.jobId ?? "No job selected"}</Text>
							{selectedJob ? (
								<Text dimColor>
									{STATUS_LABELS[selectedJob.status]}{" "}
									{selectedJob.durationMs ? `· ${formatDuration(selectedJob.durationMs)}` : ""}
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
										const rowText = formatDetailsRow(
											`${glyph} ${caret} ${step.name}`,
											DETAILS_STEP_ROW_WIDTH,
											DETAILS_ROW_PADDING_X,
										);
										return (
											<Box flexDirection="column" key={step.id}>
												<Text
													color={colorForStatus(stepStatus)}
													backgroundColor={isSelected ? "gray" : undefined}
													bold={isSelected && focusedPane === "steps"}
													dimColor={isSelected && focusedPane !== "steps"}
												>
													{rowText}
												</Text>
												{isExpanded ? (
													<Box flexDirection="column" paddingLeft={2}>
														{stepOutput.length === 0 ? (
															<Text dimColor>Waiting for output...</Text>
														) : (
															<>
																{stepOutput
																	.slice(-maxDetailsLogLines)
																	.map((line, lineIndex) => (
																		<Text key={`${step.id}-${lineIndex}`} dimColor>
																			{line}
																		</Text>
																	))}
																{stepOutput.length > maxDetailsLogLines ? (
																	<Text dimColor>
																		… {stepOutput.length - maxDetailsLogLines} more
																		line(s)
																	</Text>
																) : null}
															</>
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
				</Box>
			)}

			<Box marginTop={1}>
				<Text dimColor>
					Tab: switch view · S: summary · D: details · Left/Right: focus pane · Up/Down: move ·
					Space/Enter: toggle step · Q: exit
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

function formatDetailsRow(value: string, width: number, paddingX: number): string {
	const innerWidth = Math.max(0, width - paddingX * 2);
	const clipped =
		value.length <= innerWidth
			? value
			: innerWidth > 1
				? `${value.slice(0, innerWidth - 1)}…`
				: value.slice(0, innerWidth);
	return `${" ".repeat(paddingX)}${clipped.padEnd(innerWidth, " ")}${" ".repeat(paddingX)}`;
}
