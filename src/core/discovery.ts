import fs from "node:fs";
import path from "node:path";
import { parseWorkflow } from "./parser.js";
import { Workflow } from "./types.js";

export function findWorkflowFiles(repoRoot: string): string[] {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  if (!fs.existsSync(workflowsDir)) {
    return [];
  }

  return fs
    .readdirSync(workflowsDir)
    .filter((file: string) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file: string) => path.join(workflowsDir, file));
}

export function discoverWorkflows(repoRoot: string): Workflow[] {
  return findWorkflowFiles(repoRoot).map((workflowPath) =>
    parseWorkflow(workflowPath)
  );
}
