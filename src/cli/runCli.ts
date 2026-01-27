import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import React from "react";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  text
} from "@clack/prompts";
import { render } from "ink";
import { discoverWorkflows } from "../core/discovery.js";
import { buildRunPlan, expandJobIdsWithNeeds, filterJobsForEvent, sortJobsByNeeds } from "../core/plan.js";
import { RunPlan, RunPreset, Workflow } from "../core/types.js";
import { ActAdapter } from "../engines/act/actAdapter.js";
import { EngineAdapter, EngineContext, EngineRunResult } from "../core/engine.js";
import { loadConfig } from "../config/loadConfig.js";
import { RunStore } from "../store/runStore.js";
import { RunView } from "../tui/runView.js";

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

  const supportedEvents = resolveSupportedEvents(workflow);
  if (isTty && !args.event) {
    const event = await selectEvent(eventName, supportedEvents);
    if (!event) {
      process.exitCode = 130;
      return;
    }
    eventName = event;
  } else if (!supportedEvents.includes(eventName)) {
    process.stderr.write(
      `Event "${eventName}" is not enabled for this workflow. Use --event with one of: ${supportedEvents.join(", ")}.\n`
    );
    process.exitCode = 2;
    return;
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

  const runStore = new RunStore(path.join(repoRoot, ".xci", "runs"));
  const runDir = runStore.createRunDir(plan.runId);
  const inputFiles = prepareInputFiles(runDir, config);
  if (!inputFiles.ok) {
    process.stderr.write(`${inputFiles.error}\n`);
    process.exitCode = 2;
    return;
  }

  const platformMap = resolvePlatformMap(config.runtime.image, config.runtime.platformMap);

  const engineContext: EngineContext = {
    repoRoot,
    workflowsPath: path.dirname(workflow.path),
    eventName: plan.event.name,
    eventPayloadPath: plan.event.payloadPath,
    artifactDir: path.join(repoRoot, ".xci", "runs", plan.runId, "artifacts"),
    containerArchitecture: config.runtime.architecture,
    platformMap,
    envFile: inputFiles.envFile,
    varsFile: inputFiles.varsFile,
    secretsFile: inputFiles.secretsFile,
    matrixOverride: plan.jobs[0]?.matrix ?? undefined
  };

  const preflightOk = await runPreflightChecks(config.runtime.container, isTty && !args.mentionJson);
  if (!preflightOk) {
    process.exitCode = 1;
    return;
  }

  const adapter = new ActAdapter();
  const planned = await adapter.plan(engineContext, plan);

  let result;
  if (isTty && !args.mentionJson) {
    result = await runWithInk(adapter, planned, engineContext, workflow, path.join(repoRoot, ".xci", "runs"));
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

async function selectEvent(defaultEvent: string, events: string[]): Promise<string | null> {
  const selection = await select({
    message: "Select an event",
    initialValue: events.includes(defaultEvent) ? defaultEvent : events[0],
    options: events.map((event) => ({ value: event, label: event }))
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

function resolvePlatformMap(
  imageMap: Record<string, string>,
  platformMap: Record<string, string>
): Record<string, string> {
  const merged = { ...imageMap, ...platformMap };
  if (Object.keys(merged).length > 0) {
    return merged;
  }
  return {
    "ubuntu-latest": "ghcr.io/catthehacker/ubuntu:act-latest"
  };
}

function resolveSupportedEvents(workflow: Workflow): string[] {
  if (workflow.events.length > 0) {
    return workflow.events;
  }
  return ["push", "pull_request", "workflow_dispatch"];
}

type InputFileResult = {
  ok: boolean;
  envFile?: string;
  varsFile?: string;
  secretsFile?: string;
  error?: string;
};

function prepareInputFiles(runDir: string, config: { env: Record<string, string>; vars: Record<string, string>; secrets: Record<string, string>; envFile?: string; varsFile?: string; secretsFile?: string }): InputFileResult {
  const inputsDir = path.join(runDir, "inputs");
  fs.mkdirSync(inputsDir, { recursive: true });

  const envFile = buildInputFile(inputsDir, "env", config.envFile, config.env);
  if (!envFile.ok) {
    return envFile;
  }

  const varsFile = buildInputFile(inputsDir, "vars", config.varsFile, config.vars);
  if (!varsFile.ok) {
    return varsFile;
  }

  const secretsFile = buildInputFile(inputsDir, "secrets", config.secretsFile, config.secrets);
  if (!secretsFile.ok) {
    return secretsFile;
  }

  return {
    ok: true,
    envFile: envFile.path,
    varsFile: varsFile.path,
    secretsFile: secretsFile.path
  };
}

function buildInputFile(
  inputsDir: string,
  label: string,
  sourcePath: string | undefined,
  entries: Record<string, string>
): { ok: boolean; path?: string; error?: string } {
  const hasEntries = Object.keys(entries).length > 0;
  if (!sourcePath && !hasEntries) {
    return { ok: true };
  }

  let content = "";
  if (sourcePath) {
    if (!fs.existsSync(sourcePath)) {
      return { ok: false, error: `Configured ${label} file not found: ${sourcePath}` };
    }
    const raw = fs.readFileSync(sourcePath, "utf-8");
    content = raw.endsWith("\n") || raw.length === 0 ? raw : `${raw}\n`;
  }

  if (hasEntries) {
    content += serializeKeyValues(entries);
  }

  const outPath = path.join(inputsDir, `${label}.env`);
  fs.writeFileSync(outPath, content);
  return { ok: true, path: outPath };
}

function serializeKeyValues(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${escapeEnvValue(value)}`)
    .join("\n")
    .concat("\n");
}

function escapeEnvValue(value: string): string {
  return value.replace(/\n/g, "\\n");
}

async function runPreflightChecks(containerEngine: string, interactive: boolean): Promise<boolean> {
  const actOk = await ensureActAvailable(interactive);
  const engineOk = await ensureEngineAvailable(containerEngine, interactive);
  return actOk && engineOk;
}

async function runWithInk(
  adapter: EngineAdapter,
  plan: RunPlan,
  context: EngineContext,
  workflow: Workflow,
  runStoreBase: string
): Promise<EngineRunResult> {
  return new Promise((resolve) => {
    let resolved = false;
    const handleComplete = (result: EngineRunResult): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(result);
    };

    const { waitUntilExit, unmount } = render(
      React.createElement(RunView, {
        adapter,
        context,
        plan,
        workflow,
        runStoreBase,
        onComplete: handleComplete
      })
    );

    waitUntilExit().then(() => {
      unmount();
    });
  });
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

async function ensureActAvailable(interactive: boolean): Promise<boolean> {
  const ok = await checkCommand("act", ["--version"], "act");
  if (ok || !interactive) {
    return ok;
  }
  const shouldInstall = await confirm({
    message: "act is not installed. Install it now?",
    initialValue: true
  });
  if (isCancel(shouldInstall) || !shouldInstall) {
    cancel("Canceled.");
    return false;
  }
  const installed = await installAct();
  if (!installed) {
    process.stderr.write("Failed to install act. Install it manually and retry.\n");
    return false;
  }
  return checkCommand("act", ["--version"], "act");
}

async function ensureEngineAvailable(engine: string, interactive: boolean): Promise<boolean> {
  const ok = await checkCommand(engine, ["info"], engine);
  if (ok || !interactive) {
    return ok;
  }
  const shouldStart = await confirm({
    message: `${engine} is not running. Start it now?`,
    initialValue: true
  });
  if (isCancel(shouldStart) || !shouldStart) {
    cancel("Canceled.");
    return false;
  }
  const started = await startContainerEngine(engine);
  if (!started) {
    process.stderr.write(`Failed to start ${engine}. Please start it and retry.\n`);
    return false;
  }
  return checkCommand(engine, ["info"], engine);
}

async function installAct(): Promise<boolean> {
  const { spawnSync } = await import("node:child_process");
  const platform = process.platform;
  if (platform === "darwin") {
    if (!(await commandExists("brew"))) {
      process.stderr.write("Homebrew not found. Install Homebrew to install act.\n");
      return false;
    }
    return spawnSync("brew", ["install", "act"], { stdio: "inherit" }).status === 0;
  }

  if (platform === "linux") {
    if (await commandExists("apt-get")) {
      if (spawnSync("sudo", ["apt-get", "update"], { stdio: "inherit" }).status !== 0) {
        return false;
      }
      return spawnSync("sudo", ["apt-get", "install", "-y", "act"], { stdio: "inherit" }).status === 0;
    }
    if (await commandExists("dnf")) {
      return spawnSync("sudo", ["dnf", "install", "-y", "act"], { stdio: "inherit" }).status === 0;
    }
    if (await commandExists("yum")) {
      return spawnSync("sudo", ["yum", "install", "-y", "act"], { stdio: "inherit" }).status === 0;
    }
    if (await commandExists("pacman")) {
      return spawnSync("sudo", ["pacman", "-S", "--noconfirm", "act"], { stdio: "inherit" }).status === 0;
    }
  }

  if (platform === "win32") {
    if (await commandExists("winget")) {
      return spawnSync("winget", ["install", "--id", "nektos.act"], { stdio: "inherit" }).status === 0;
    }
    if (await commandExists("choco")) {
      return spawnSync("choco", ["install", "act", "-y"], { stdio: "inherit" }).status === 0;
    }
  }

  process.stderr.write("No supported package manager found for act installation.\n");
  return false;
}

async function startContainerEngine(engine: string): Promise<boolean> {
  const { spawnSync } = await import("node:child_process");
  const platform = process.platform;

  if (engine === "docker" && platform === "darwin") {
    const openResult = spawnSync("open", ["-a", "Docker"], { stdio: "ignore" });
    if (openResult.status !== 0) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return true;
  }

  if (platform === "linux") {
    if (await commandExists("systemctl")) {
      const result = spawnSync("sudo", ["systemctl", "start", engine], { stdio: "inherit" });
      return result.status === 0;
    }
  }

  if (engine === "podman") {
    if (await commandExists("podman")) {
      const result = spawnSync("podman", ["machine", "start"], { stdio: "inherit" });
      return result.status === 0;
    }
  }

  return false;
}

async function commandExists(command: string): Promise<boolean> {
  const { spawnSync } = await import("node:child_process");
  const checker = process.platform === "win32" ? "where" : "which";
  return spawnSync(checker, [command], { stdio: "ignore" }).status === 0;
}
