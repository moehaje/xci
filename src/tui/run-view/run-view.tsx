import fs from "node:fs";
import path from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineAdapter, EngineContext, EngineRunResult } from "../../core/engine.js";
import type { Job, RunPlan, RunRecord, RunStatus, Workflow } from "../../core/types.js";
import { getJobLogFileName } from "../../store/run-store.js";
import type { DetailsPaneFocus } from "./components/details-pane.js";
import { DetailsPane } from "./components/details-pane.js";
import { estimateSummaryGraphWidth } from "./components/summary-graph-view.js";
import { SummaryPane } from "./components/summary-pane.js";
import { buildSummaryGraph } from "./model/summary-graph.js";
import type { DiagramLine } from "./render/diagram.js";
import { buildDiagramLines } from "./render/diagram.js";
import {
	DEFAULT_VIEW,
	LOG_TAIL_LINES,
	POLL_INTERVAL_MS,
	SPINNER_FRAMES,
	SUMMARY_GRAPH_MIN_WIDTH,
} from "./utils/constants.js";
import { mergeStepStatuses, parseStepData } from "./utils/parser.js";
import { colorForStatus, renderStatusGlyph, STATUS_LABELS } from "./utils/status.js";

export type RunViewProps = {
	adapter: EngineAdapter;
	context: EngineContext;
	plan: RunPlan;
	workflow: Workflow;
	runStoreBase: string;
	onComplete: (result: EngineRunResult) => void;
};

type ViewMode = "summary" | "details";
type DetailsStatePane = DetailsPaneFocus;
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
	const [focusedPane, setFocusedPane] = useState<DetailsStatePane>("jobs");
	const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
	const [stepOutputs, setStepOutputs] = useState<Record<string, string[]>>({});
	const [stepStatuses, setStepStatuses] = useState<Record<string, RunStatus>>({});
	const [logError, setLogError] = useState<string | null>(null);
	const [quitPromptVisible, setQuitPromptVisible] = useState(false);
	const [cleanupError, setCleanupError] = useState<string | null>(null);
	const [cleaningUp, setCleaningUp] = useState(false);
	const [cancelError, setCancelError] = useState<string | null>(null);
	const [cancelingRun, setCancelingRun] = useState(false);
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
	const abortControllerRef = useRef<AbortController | null>(null);
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
			const controller = new AbortController();
			abortControllerRef.current = controller;
			const result = await adapter.run(plan, {
				...context,
				signal: controller.signal,
				onOutput: appendOutput,
			});
			abortControllerRef.current = null;
			setCancelingRun(false);
			setQuitPromptVisible(false);
			setStatusText(result.exitCode === 0 ? "success" : result.exitCode === 130 ? "canceled" : "failed");
			onComplete(result);
		};

		start();
	}, [adapter, appendOutput, context, onComplete, plan]);

	const cleanupRunFilesAndExit = useCallback(() => {
		if (cleaningUp) {
			return;
		}
		setCleaningUp(true);
		void (async () => {
			try {
				const runDir = path.join(runStoreBase, plan.runId);
				await fs.promises.rm(runDir, { recursive: true, force: true });
				exit();
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				setCleanupError(`Failed to clean run files: ${message}`);
				setCleaningUp(false);
			}
		})();
	}, [cleaningUp, exit, plan.runId, runStoreBase]);

	const cancelRun = useCallback(() => {
		if (cancelingRun) {
			return;
		}
		const controller = abortControllerRef.current;
		if (!controller) {
			setCancelError("No active run to cancel.");
			return;
		}
		setCancelError(null);
		setCancelingRun(true);
		controller.abort();
	}, [cancelingRun]);

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
		const logPath = path.join(runRecord.logDir, getJobLogFileName(currentJob.jobId));
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
		if (quitPromptVisible) {
			const lowered = input.toLowerCase();
			if (statusText === "running") {
				if (lowered === "y") {
					cancelRun();
					return;
				}
				if (lowered === "n" || key.return || key.escape) {
					setQuitPromptVisible(false);
					setCancelError(null);
				}
				return;
			}
			if (lowered === "y") {
				cleanupRunFilesAndExit();
				return;
			}
			if (lowered === "n" || key.return) {
				exit();
				return;
			}
			if (key.escape) {
				setQuitPromptVisible(false);
				setCleanupError(null);
			}
			return;
		}

		if (input.toLowerCase() === "q") {
			setQuitPromptVisible(true);
			setCleanupError(null);
			setCancelError(null);
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
				<SummaryPane
					shouldUseFallback={shouldUseSummaryFallback}
					diagramLines={diagramLines}
					summaryGraph={summaryGraph}
					spinnerIndex={spinnerIndex}
				/>
			) : (
				<DetailsPane
					focusedPane={focusedPane}
					orderedJobs={orderedJobs}
					selectedJobIndex={selectedJobIndex}
					selectedJob={selectedJob}
					selectedSteps={selectedSteps}
					selectedStepIndex={selectedStepIndex}
					expandedSteps={expandedSteps}
					stepStatuses={stepStatuses}
					stepOutputs={stepOutputs}
					maxDetailsLogLines={maxDetailsLogLines}
					spinnerIndex={spinnerIndex}
				/>
			)}

			<Box marginTop={1}>
				<Text dimColor>
					Tab: switch view · S: summary · D: details · Left/Right: focus pane · Up/Down: move ·
					Space/Enter: toggle step · Q: exit
				</Text>
			</Box>
			{quitPromptVisible && statusText === "running" ? (
				<Box marginTop={1}>
					<Text color="yellow">
						{cancelingRun
							? "Canceling run..."
							: "Cancel the current run and stop execution? (y/N, Esc to continue)"}
					</Text>
				</Box>
			) : null}
			{statusText !== "running" ? (
				<Box marginTop={1}>
					{quitPromptVisible ? (
						<Text color="yellow">
							{cleaningUp
								? "Cleaning run files before exit..."
								: "Cleanup run files for this run before exit? (y/N, Esc to cancel)"}
						</Text>
					) : (
						<Text dimColor>Run finished. Press q to exit.</Text>
					)}
				</Box>
			) : null}
			{cleanupError ? (
				<Box marginTop={1}>
					<Text color="red">{cleanupError}</Text>
				</Box>
			) : null}
			{cancelError ? (
				<Box marginTop={1}>
					<Text color="red">{cancelError}</Text>
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
