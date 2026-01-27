import fs from "node:fs";
import path from "node:path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { EngineAdapter, EngineContext, EngineRunResult } from "../core/engine.js";
import { Job, RunPlan, RunRecord, RunStatus, Workflow } from "../core/types.js";

export type RunViewProps = {
  adapter: EngineAdapter;
  context: EngineContext;
  plan: RunPlan;
  workflow: Workflow;
  runStoreBase: string;
  onComplete: (result: EngineRunResult) => void;
};

const MAX_LOG_LINES = 80;
const POLL_INTERVAL_MS = 500;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LOG_TAIL_LINES = 12;
const DEFAULT_VIEW: ViewMode = "summary";
const STATUS_LABELS: Record<RunStatus, string> = {
  pending: "queued",
  running: "running",
  success: "success",
  failed: "failed",
  canceled: "canceled"
};

export function RunView({
  adapter,
  context,
  plan,
  workflow,
  runStoreBase,
  onComplete
}: RunViewProps): JSX.Element {
  const { exit } = useApp();
  const [runRecord, setRunRecord] = useState<RunRecord | null>(null);
  const [statusText, setStatusText] = useState("starting");
  const [readError, setReadError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_VIEW);
  const [selectedJobIndex, setSelectedJobIndex] = useState(0);
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const [stepOutputs, setStepOutputs] = useState<Record<string, string[]>>({});
  const [stepStatuses, setStepStatuses] = useState<Record<string, RunStatus>>({});
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
        durationMs: record?.durationMs
      };
    });
  }, [plan.jobs, runRecord]);

  const jobLookup = useMemo(() => {
    return new Map(workflow.jobs.map((job) => [job.id, job]));
  }, [workflow.jobs]);

  const selectedJob = orderedJobs[selectedJobIndex];
  const selectedJobModel = selectedJob ? jobLookup.get(selectedJob.jobId) ?? null : null;
  const selectedSteps = useMemo(() => selectedJobModel?.steps ?? [], [selectedJobModel]);

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
      const result = await adapter.run(plan, { ...context, onOutput: appendOutput });
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
        const message = error instanceof Error ? error.message : "Unknown error";
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
    const selectedJob = orderedJobs[selectedJobIndex];
    if (!selectedJob) {
      return;
    }
    const logPath = path.join(runRecord.logDir, `${selectedJob.jobId}.log`);
    const interval = setInterval(() => {
      if (!fs.existsSync(logPath)) {
        return;
      }
      try {
        const raw = fs.readFileSync(logPath, "utf-8");
        const parsed = parseStepData(selectedSteps, raw, selectedJob.status);
        setStepStatuses((prev) => mergeStepStatuses(prev, parsed.statuses));
        setStepOutputs(parsed.outputs);
        setLogError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
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
        setSelectedJobIndex((prev) => Math.min(orderedJobs.length - 1, prev + 1));
        setSelectedStepIndex(0);
        return;
      }
      if (key.upArrow) {
        setSelectedStepIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedStepIndex((prev) => Math.min(selectedSteps.length - 1, prev + 1));
        return;
      }
      if (input === " " || key.return) {
        const step = selectedSteps[selectedStepIndex];
        if (step) {
          setExpandedSteps((prev) => ({
            ...prev,
            [step.id]: !prev[step.id]
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
          {renderStatusGlyph(statusText as RunStatus, spinnerIndex)} {STATUS_LABELS[statusText as RunStatus]}
        </Text>
      </Box>

      {viewMode === "summary" ? (
        <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
          <Text dimColor>Summary</Text>
          {diagramLines.map((line, index) => (
            <Text key={`${line}-${index}`}>{line}</Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="row" gap={2}>
          <Box flexDirection="column" width={28} borderStyle="round" paddingX={1} paddingY={1}>
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
          <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={2} paddingY={1}>
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
                            stepOutput.slice(-LOG_TAIL_LINES).map((line, lineIndex) => (
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
          Tab: switch view · S: summary · D: details · Arrows: navigate · Space/Enter: toggle · Q: exit
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

type ViewMode = "summary" | "details";

function buildDiagramLines(
  workflow: Workflow,
  jobs: { jobId: string; status: RunStatus; durationMs?: number }[],
  spinnerIndex: number
): string[] {
  if (jobs.length === 0) {
    return ["No jobs selected."];
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

  jobs.forEach((job) => resolveDepth(job.jobId));
  const maxDepth = Math.max(...Array.from(depths.values()), 0);
  const columns: string[][] = Array.from({ length: maxDepth + 1 }, () => []);

  jobs.forEach((job) => {
    const depth = depths.get(job.jobId) ?? 0;
    columns[depth].push(buildJobLabel(job, spinnerIndex));
  });

  const columnWidths = columns.map((column) => Math.max(0, ...column.map((item) => item.length), 16));
  const maxRows = Math.max(...columns.map((column) => column.length), 1);

  const lines: string[] = [];
  for (let row = 0; row < maxRows; row += 1) {
    let line = "";
    for (let col = 0; col < columns.length; col += 1) {
      const text = columns[col][row] ?? "";
      const padded = padRight(text, columnWidths[col]);
      line += padded;
      if (col < columns.length - 1) {
        line += "  ──→  ";
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function buildJobLabel(
  job: { jobId: string; status: RunStatus; durationMs?: number },
  spinnerIndex: number
): string {
  const status = formatStatusText(job.status, spinnerIndex);
  const duration = job.durationMs ? ` ${formatDuration(job.durationMs)}` : "";
  return `${status} ${job.jobId}${duration}`;
}

function formatStatusText(status: RunStatus, spinnerIndex: number): string {
  switch (status) {
    case "success":
      return "●";
    case "failed":
      return "✕";
    case "running":
      return SPINNER_FRAMES[spinnerIndex] ?? "⠋";
    case "canceled":
      return "◌";
    case "pending":
    default:
      return "○";
  }
}

function colorForStatus(status: RunStatus): "green" | "red" | "yellow" | "gray" | undefined {
  switch (status) {
    case "success":
      return "green";
    case "failed":
      return "red";
    case "running":
      return "yellow";
    case "canceled":
      return "gray";
    default:
      return undefined;
  }
}

function renderStatusGlyph(status: RunStatus, spinnerIndex: number): string {
  return formatStatusText(status, spinnerIndex);
}

function deriveStepStatus(jobStatus: RunStatus, index: number): RunStatus {
  if (jobStatus === "running") {
    return index === 0 ? "running" : "pending";
  }
  return jobStatus;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m${remainder}s`;
}

function padRight(value: string, length: number): string {
  if (value.length >= length) {
    return value;
  }
  return value + " ".repeat(length - value.length);
}

function parseStepData(
  steps: Job["steps"],
  raw: string,
  jobStatus: RunStatus
): { statuses: Record<string, RunStatus>; outputs: Record<string, string[]> } {
  const statusMap: Record<string, RunStatus> = {};
  const outputMap: Record<string, string[]> = {};
  if (steps.length === 0) {
    return { statuses: statusMap, outputs: outputMap };
  }

  const nameToIndex = new Map<string, number>();
  steps.forEach((step, index) => {
    const key = normalizeStepName(step.name);
    if (!nameToIndex.has(key)) {
      nameToIndex.set(key, index);
    }
  });

  let lastRunningIndex: number | null = null;
  let failedIndex: number | null = null;
  let lastFailureIndex: number | null = null;
  let currentIndex: number | null = null;
  const lines = raw.split(/\r?\n/).map(stripAnsi);
  for (const line of lines) {
    const startMatch = line.match(/⭐\s+Run\s+(.+)$/);
    if (startMatch) {
      const key = normalizeStepName(startMatch[1]);
      const index = nameToIndex.get(key);
      if (index === undefined) {
        currentIndex = null;
        continue;
      }
      statusMap[steps[index].id] = "running";
      lastRunningIndex = index;
      currentIndex = index;
      outputMap[steps[index].id] = outputMap[steps[index].id] ?? [];
      continue;
    }

    const successMatch = line.match(/✅\s+Success\s+-\s+(.+)$/);
    if (successMatch) {
      const key = normalizeStepName(successMatch[1]);
      const index = nameToIndex.get(key);
      if (index !== undefined) {
        statusMap[steps[index].id] = "success";
        if (lastRunningIndex === index) {
          lastRunningIndex = null;
        }
        if (currentIndex === index) {
          currentIndex = null;
        }
      }
      continue;
    }

    const failureMatch = line.match(/❌\s+Failure\s+-\s+(.+)$/);
    if (failureMatch) {
      const key = normalizeStepName(failureMatch[1]);
      const index = nameToIndex.get(key);
      if (index !== undefined) {
        statusMap[steps[index].id] = "failed";
        failedIndex = index;
        lastFailureIndex = index;
        if (lastRunningIndex === index) {
          lastRunningIndex = null;
        }
        if (currentIndex === index) {
          currentIndex = null;
        }
      }
      continue;
    }

    if (line.includes("Failed but continue next step")) {
      if (lastFailureIndex !== null) {
        const stepId = steps[lastFailureIndex]?.id;
        if (stepId) {
          statusMap[stepId] = "success";
        }
      }
      continue;
    }

    if (currentIndex !== null) {
      if (line.trim().length > 0) {
        const stepId = steps[currentIndex]?.id;
        if (stepId) {
          outputMap[stepId] = outputMap[stepId] ?? [];
          outputMap[stepId].push(line);
          if (outputMap[stepId].length > MAX_LOG_LINES) {
            outputMap[stepId] = outputMap[stepId].slice(-MAX_LOG_LINES);
          }
        }
      }
    }
  }

  if (jobStatus === "success") {
    for (const step of steps) {
      if (!statusMap[step.id]) {
        statusMap[step.id] = "success";
      }
    }
    return { statuses: statusMap, outputs: outputMap };
  }

  if (jobStatus === "failed") {
    if (failedIndex === null && lastRunningIndex !== null) {
      statusMap[steps[lastRunningIndex].id] = "failed";
      failedIndex = lastRunningIndex;
    }
    if (failedIndex !== null) {
      const failureIndex = failedIndex;
      steps.forEach((step, index) => {
        if (statusMap[step.id]) {
          return;
        }
        statusMap[step.id] = index <= failureIndex ? "success" : "canceled";
      });
    } else {
      for (const step of steps) {
        if (!statusMap[step.id]) {
          statusMap[step.id] = "canceled";
        }
      }
    }
    return { statuses: statusMap, outputs: outputMap };
  }

  if (jobStatus === "canceled") {
    for (const step of steps) {
      if (!statusMap[step.id]) {
        statusMap[step.id] = "canceled";
      }
    }
    return { statuses: statusMap, outputs: outputMap };
  }

  return { statuses: statusMap, outputs: outputMap };
}

function normalizeStepName(name: string): string {
  return name
    .replace(/\s*\[[^\]]+]\s*$/g, "")
    .replace(/^(main|post)\s+/i, "")
    .trim()
    .toLowerCase();
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, "");
}

function mergeStepStatuses(
  previous: Record<string, RunStatus>,
  next: Record<string, RunStatus>
): Record<string, RunStatus> {
  const merged: Record<string, RunStatus> = { ...previous };
  for (const [stepId, status] of Object.entries(next)) {
    const current = merged[stepId];
    if (!current) {
      merged[stepId] = status;
      continue;
    }
    if (isFinalStatus(current)) {
      if (isFinalStatus(status) && status !== current) {
        merged[stepId] = status;
      }
      continue;
    }
    merged[stepId] = status;
  }
  return merged;
}

function isFinalStatus(status: RunStatus): boolean {
  return status === "success" || status === "failed" || status === "canceled";
}
