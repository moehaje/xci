import path from "node:path";
import process from "node:process";
import {
  cancel,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  spinner,
  text
} from "@clack/prompts";
import { discoverWorkflows } from "../core/discovery.js";
import { buildRunPlan, expandJobIdsWithNeeds, filterJobsForEvent, sortJobsByNeeds } from "../core/plan.js";
import { RunPreset, Workflow } from "../core/types.js";
import { ActAdapter } from "../engines/act/actAdapter.js";
import { EngineContext } from "../core/engine.js";
import { loadConfig } from "../config/loadConfig.js";

type CliOptions = {
  command: "run";
  workflow?: string;
  jobs?: string[];
  all?: boolean;
  mentionJson?: boolean;
  event?: string;
  eventPath?: string;
  matrix?: string[];
  preset?: string;
};

export async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "run") {
    process.stderr.write("Only `xci run` is supported right now.\n");
    process.exitCode = 2;
    return;
  }

  const repoRoot = process.cwd();
  let workflows: Workflow[] = [];
  try {
    workflows = discoverWorkflows(repoRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown workflow parse error.";
    process.stderr.write(`Workflow parse error: ${message}\n`);
    process.exitCode = 1;
    return;
  }
  if (workflows.length === 0) {
    process.stderr.write("No workflows found in .github/workflows.\n");
    process.exitCode = 1;
    return;
  }

  const { config } = loadConfig(repoRoot);
  const isTty = Boolean(process.stdout.isTTY);
  let eventName = args.event ?? "push";

  let workflow = resolveWorkflow(workflows, args.workflow);
  if (!workflow && isTty) {
    intro("XCI");
    const selected = await select({
      message: "Select a workflow",
      options: workflows.map((wf) => ({
        value: wf.id,
        label: wf.name
      }))
    });
    if (isCancel(selected)) {
      cancel("Canceled.");
      process.exitCode = 130;
      return;
    }
    workflow = workflows.find((wf) => wf.id === selected) ?? workflows[0];
  }

  if (!workflow) {
    process.stderr.write("No workflow selected. Use --workflow.\n");
    process.exitCode = 2;
    return;
  }

  if (isTty && !args.event) {
    const event = await selectEvent(eventName);
    if (!event) {
      process.exitCode = 130;
      return;
    }
    eventName = event;
  }

  const availableJobs = filterJobsForEvent(workflow.jobs, eventName);
  const presets = resolvePresets(config.presets, availableJobs, config.defaultPreset);
  const presetId = args.preset ?? config.defaultPreset ?? "quick";
  const preset = presets.find((item) => item.id === presetId) ?? presets[0];

  let selectedJobs = resolveJobsFromArgs(args, preset);
  if (args.all) {
    selectedJobs = availableJobs.map((job) => job.id);
  }

  if (isTty && !selectedJobs) {
    const presetChoice = await selectPreset(presets, presetId);
    if (!presetChoice) {
      process.exitCode = 130;
      return;
    }

    const jobChoice = await selectJobs(availableJobs, presetChoice.jobIds);
    if (!jobChoice) {
      process.exitCode = 130;
      return;
    }

    const matrixChoice = await promptMatrix();
    if (matrixChoice === null) {
      process.exitCode = 130;
      return;
    }

    selectedJobs = jobChoice;
    args.matrix = matrixChoice ?? args.matrix;
  }

  if (!selectedJobs) {
    selectedJobs = preset?.jobIds?.length ? preset.jobIds : availableJobs.map((job) => job.id);
  }

  const expanded = expandJobIdsWithNeeds(workflow, selectedJobs);
  const ordered = sortJobsByNeeds(workflow, expanded);
  const effectiveEvent = args.event ?? preset?.event?.name ?? eventName;
  const effectivePayloadPath = args.eventPath ?? preset?.event?.payloadPath;

  const plan = buildRunPlan({
    workflow,
    jobIds: ordered,
    eventName: effectiveEvent,
    eventPayloadPath: effectivePayloadPath,
    preset,
    matrixOverride: args.matrix ?? preset?.matrixOverride
  });

  const engineContext: EngineContext = {
    repoRoot,
    workflowsPath: path.dirname(workflow.path),
    eventName: plan.event.name,
    eventPayloadPath: plan.event.payloadPath,
    artifactDir: path.join(repoRoot, ".xci", "runs", plan.runId, "artifacts"),
    containerArchitecture: config.runtime.architecture,
    platformMap: {
      ...config.runtime.image,
      ...config.runtime.platformMap
    },
    envFile: config.envFile,
    varsFile: config.varsFile,
    secretsFile: config.secretsFile,
    matrixOverride: plan.jobs[0]?.matrix ?? undefined
  };

  const preflightOk = await runPreflightChecks(config.runtime.container);
  if (!preflightOk) {
    process.exitCode = 1;
    return;
  }

  const adapter = new ActAdapter();
  const planned = await adapter.plan(engineContext, plan);

  let result;
  if (isTty && !args.mentionJson) {
    const runSpinner = spinner();
    runSpinner.start(`Running ${planned.jobs.length} job(s) with act...`);
    result = await adapter.run(planned, engineContext);
    runSpinner.stop(`Finished with exit code ${result.exitCode}`);
    outro(`Logs: ${result.logsPath}`);
  } else {
    if (!args.mentionJson) {
      process.stdout.write(`Running ${planned.jobs.length} job(s) with act...\\n`);
    }
    result = await adapter.run(planned, engineContext);
    if (!args.mentionJson) {
      process.stdout.write(`Finished with exit code ${result.exitCode}\\n`);
    }
    if (!args.mentionJson) {
      process.stdout.write(`Logs: ${result.logsPath}\\n`);
    }
  }
  if (args.mentionJson) {
    const summary = await buildJsonSummary(repoRoot, plan.runId, workflow, ordered);
    process.stdout.write(`${JSON.stringify(summary)}\\n`);
  }
  process.exitCode = result.exitCode;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { command: "run" };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) {
    options.command = "run";
    args.shift();
  }

  while (args.length) {
    const arg = args.shift();
    switch (arg) {
      case "--workflow":
        options.workflow = args.shift();
        break;
      case "--job":
        options.jobs = (args.shift() ?? "").split(",").filter(Boolean);
        break;
      case "--all":
        options.all = true;
        break;
      case "--event":
        options.event = args.shift();
        break;
      case "--event-path":
        options.eventPath = args.shift();
        break;
      case "--matrix":
        options.matrix = collectMatrices(options.matrix, args.shift());
        break;
      case "--preset":
        options.preset = args.shift();
        break;
      case "--json":
        options.mentionJson = true;
        break;
      default:
        break;
    }
  }

  return options;
}

function resolveWorkflow(workflows: Workflow[], selector?: string): Workflow | undefined {
  if (!selector) {
    return workflows.length === 1 ? workflows[0] : undefined;
  }
  return workflows.find((wf) => wf.id.endsWith(selector) || wf.name === selector);
}

function resolveJobsFromArgs(options: CliOptions, preset?: RunPreset): string[] | undefined {
  if (options.all) {
    return undefined;
  }
  if (options.jobs?.length) {
    return options.jobs;
  }
  if (options.preset && preset?.jobIds?.length) {
    return preset.jobIds;
  }
  return undefined;
}

function resolvePresets(
  presets: Record<string, { jobs: string[]; event?: { name: string; payloadPath?: string }; matrix?: string[] }>,
  availableJobs: { id: string }[],
  defaultPreset?: string
): RunPreset[] {
  const resolved: RunPreset[] = Object.entries(presets).map(([id, preset]) => ({
    id,
    label: id,
    jobIds: preset.jobs,
    event: preset.event,
    matrixOverride: preset.matrix
  }));

  if (!resolved.some((preset) => preset.id === "quick")) {
    resolved.push({
      id: "quick",
      label: "quick",
      jobIds: availableJobs.slice(0, 2).map((job) => job.id)
    });
  }

  if (!resolved.some((preset) => preset.id === "full")) {
    resolved.push({
      id: "full",
      label: "full",
      jobIds: availableJobs.map((job) => job.id)
    });
  }

  if (defaultPreset && !resolved.some((preset) => preset.id === defaultPreset)) {
    resolved.unshift({
      id: defaultPreset,
      label: defaultPreset,
      jobIds: availableJobs.map((job) => job.id)
    });
  }

  return resolved;
}

async function selectEvent(defaultEvent: string): Promise<string | null> {
  const selection = await select({
    message: "Select an event",
    initialValue: defaultEvent,
    options: [
      { value: "push", label: "push" },
      { value: "pull_request", label: "pull_request" },
      { value: "workflow_dispatch", label: "workflow_dispatch" }
    ]
  });
  if (isCancel(selection)) {
    cancel("Canceled.");
    return null;
  }
  return selection;
}

async function selectPreset(presets: RunPreset[], current: string): Promise<RunPreset | null> {
  const selection = await select({
    message: "Select a preset",
    initialValue: current,
    options: presets.map((preset) => ({
      value: preset.id,
      label: preset.label
    }))
  });
  if (isCancel(selection)) {
    cancel("Canceled.");
    return null;
  }
  return presets.find((preset) => preset.id === selection) ?? null;
}

async function selectJobs(jobs: { id: string; name: string }[], initial: string[]): Promise<string[] | null> {
  const selection = await multiselect({
    message: "Select jobs to run",
    options: jobs.map((job) => ({
      value: job.id,
      label: job.name
    })),
    initialValues: initial
  });
  if (isCancel(selection)) {
    cancel("Canceled.");
    return null;
  }
  return selection;
}

async function promptMatrix(): Promise<string[] | undefined | null> {
  const selection = await text({
    message: "Matrix override (optional, format: key:value,key:value)",
    placeholder: "node:20,os:ubuntu-latest"
  });
  if (isCancel(selection)) {
    cancel("Canceled.");
    return null;
  }
  if (!selection) {
    return undefined;
  }
  return parseMatrixInput(selection);
}

function collectMatrices(current: string[] | undefined, value?: string): string[] | undefined {
  if (!value) {
    return current;
  }
  return [...(current ?? []), value];
}

function parseMatrixInput(input: string): string[] | undefined {
  const items = input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

async function buildJsonSummary(
  repoRoot: string,
  runId: string,
  workflow: Workflow,
  orderedJobs: string[]
): Promise<Record<string, unknown>> {
  const { readFile } = await import("node:fs/promises");
  const runFile = path.join(repoRoot, ".xci", "runs", runId, "run.json");
  const raw = await readFile(runFile, "utf-8");
  const run = JSON.parse(raw) as {
    jobs: { jobId: string; status: string; exitCode?: number; durationMs?: number }[];
    logDir?: string;
    artifactDir?: string;
  };

  return {
    runId,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      path: workflow.path
    },
    jobs: orderedJobs.map((jobId) => {
      const job = run.jobs.find((item) => item.jobId === jobId);
      return {
        jobId,
        status: job?.status ?? "unknown",
        exitCode: job?.exitCode,
        durationMs: job?.durationMs
      };
    }),
    logsDir: run.logDir,
    artifactsDir: run.artifactDir
  };
}

async function runPreflightChecks(containerEngine: string): Promise<boolean> {
  const actOk = await checkCommand("act", ["--version"], "act");
  const engineOk = await checkCommand(containerEngine, ["info"], containerEngine);
  return actOk && engineOk;
}

async function checkCommand(command: string, args: string[], label: string): Promise<boolean> {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.status !== 0) {
    process.stderr.write(`${label} is not available. Install and retry.\n`);
    return false;
  }
  return true;
}
