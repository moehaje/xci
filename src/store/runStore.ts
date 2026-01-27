import fs from "node:fs";
import path from "node:path";
import { RunRecord } from "../core/types.js";

export class RunStore {
  constructor(private readonly baseDir: string) {}

  ensureBaseDir(): void {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  createRunDir(runId: string): string {
    this.ensureBaseDir();
    const runDir = path.join(this.baseDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    return runDir;
  }

  createLogsDir(runId: string): string {
    const runDir = this.createRunDir(runId);
    const logsDir = path.join(runDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    return logsDir;
  }

  createArtifactsDir(runId: string): string {
    const runDir = this.createRunDir(runId);
    const artifactsDir = path.join(runDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    return artifactsDir;
  }

  createLogFile(runId: string, jobId: string): string {
    const logsDir = this.createLogsDir(runId);
    return path.join(logsDir, `${jobId}.log`);
  }

  writeRun(run: RunRecord): void {
    this.ensureBaseDir();
    const runDir = path.join(this.baseDir, run.id);
    fs.mkdirSync(runDir, { recursive: true });
    const recordPath = path.join(runDir, "run.json");
    fs.writeFileSync(recordPath, JSON.stringify(run, null, 2));
  }
}
