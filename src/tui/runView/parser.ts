import { Job, RunStatus } from "../../core/types.js";
import { MAX_LOG_LINES } from "./constants.js";

export type StepParseResult = {
  statuses: Record<string, RunStatus>;
  outputs: Record<string, string[]>;
};

export function parseStepData(
  steps: Job["steps"],
  raw: string,
  jobStatus: RunStatus
): StepParseResult {
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

export function mergeStepStatuses(
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

function isFinalStatus(status: RunStatus): boolean {
  return status === "success" || status === "failed" || status === "canceled";
}
