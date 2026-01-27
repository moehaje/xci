import { RunStatus, Workflow } from "../../core/types.js";
import { formatDuration } from "./format.js";
import { formatStatusText } from "./status.js";

export function buildDiagramLines(
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

function padRight(value: string, length: number): string {
  if (value.length >= length) {
    return value;
  }
  return value + " ".repeat(length - value.length);
}
