import fs from "node:fs";
import path from "node:path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { EngineAdapter, EngineContext, EngineRunResult } from "../core/engine.js";
import { RunPlan, RunRecord, RunStatus, Workflow } from "../core/types.js";

type LogLine = {
  id: number;
  text: string;
  source: "stdout" | "stderr";
};

export type RunViewProps = {
  adapter: EngineAdapter;
  context: EngineContext;
  plan: RunPlan;
  workflow: Workflow;
  runStoreBase: string;
  onComplete: (result: EngineRunResult) => void;
};

const MAX_LOG_LINES = 200;
const POLL_INTERVAL_MS = 500;

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
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [statusText, setStatusText] = useState("starting");
  const [readError, setReadError] = useState<string | null>(null);
  const lineId = useRef(0);
  const running = useRef(false);

  const appendOutput = useCallback((chunk: string, source: "stdout" | "stderr") => {
    const parts = chunk.split(/\r?\n/);
    setLogLines((prev) => {
      const next = [...prev];
      for (let i = 0; i < parts.length; i += 1) {
        if (parts[i] === "" && i === parts.length - 1) {
          continue;
        }
        next.push({
          id: lineId.current++,
          text: parts[i],
          source
        });
      }
      return next.slice(-MAX_LOG_LINES);
    });
  }, []);

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
      exit();
    };

    start();
  }, [adapter, appendOutput, context, exit, onComplete, plan]);

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

  useInput((input) => {
    if (input === "q" && statusText !== "running") {
      exit();
    }
  }, { isActive: statusText !== "running" });

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

  const logTail = useMemo(() => logLines.slice(-20), [logLines]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          {workflow.name} · {plan.event.name} · {plan.runId}
        </Text>
        <Text dimColor>Status: {statusText}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text>Jobs</Text>
        {orderedJobs.map((job) => (
          <Text key={job.jobId}>
            {formatStatus(job.status)} {job.jobId}
            {job.durationMs ? ` (${formatDuration(job.durationMs)})` : ""}
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" borderStyle="round" paddingX={1} paddingY={0}>
        <Text>Logs (latest)</Text>
        {logTail.length === 0 ? (
          <Text dimColor>Waiting for output...</Text>
        ) : (
          logTail.map((line) => (
            <Text key={line.id} color={line.source === "stderr" ? "red" : undefined}>
              {line.text}
            </Text>
          ))
        )}
      </Box>

      {statusText !== "running" ? (
        <Box marginTop={1}>
          <Text dimColor>Press q to exit.</Text>
        </Box>
      ) : null}
      {readError ? (
        <Box marginTop={1}>
          <Text color="red">{readError}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function formatStatus(status: RunStatus): JSX.Element {
  switch (status) {
    case "success":
      return <Text color="green">success</Text>;
    case "failed":
      return <Text color="red">failed</Text>;
    case "running":
      return <Text color="yellow">running</Text>;
    case "canceled":
      return <Text color="gray">canceled</Text>;
    case "pending":
    default:
      return <Text dimColor>queued</Text>;
  }
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
