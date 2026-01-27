import type { RunPlan } from "./types.js";

export type EngineCapabilities = {
  matrix: boolean;
  artifacts: boolean;
  eventPayloads: boolean;
  services: boolean;
};

export type EngineContext = {
  repoRoot: string;
  workflowsPath: string;
  eventName: string;
  eventPayloadPath?: string;
  artifactDir: string;
  containerArchitecture?: string;
  envFile?: string;
  varsFile?: string;
  secretsFile?: string;
  matrixOverride?: string[];
  platformMap?: Record<string, string>;
  extraArgs?: string[];
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void;
};

export type EngineRunResult = {
  exitCode: number;
  logsPath: string;
};

export interface EngineAdapter {
  readonly id: string;
  capabilities(): EngineCapabilities;
  plan(context: EngineContext, plan: RunPlan): Promise<RunPlan>;
  run(plan: RunPlan, context: EngineContext): Promise<EngineRunResult>;
}
