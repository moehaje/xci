import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { ActAdapter } from "../src/engines/act/act-adapter.js";
import type { EngineContext } from "../src/core/engine.js";
import type { RunPlan } from "../src/core/types.js";

function makePlan(overrides: Partial<RunPlan> = {}): RunPlan {
	return {
		runId: "20260205-abc123",
		workflow: {
			id: "wf-1",
			name: "CI",
			path: ".github/workflows/ci.yml",
			events: ["push", "pull_request"],
			jobs: [],
		},
		event: {
			name: "push",
		},
		jobs: [
			{
				jobId: "build-and-test",
				matrix: ["node:20"],
				engineArgs: [],
			},
		],
		...overrides,
	};
}

function makeContext(tmpDir: string, overrides: Partial<EngineContext> = {}): EngineContext {
	return {
		repoRoot: tmpDir,
		runDir: path.join(tmpDir, ".xci/runs/20260205-abc123"),
		logsDir: path.join(tmpDir, ".xci/runs/20260205-abc123/logs"),
		workflowsPath: path.join(tmpDir, ".github/workflows"),
		eventName: "push",
		artifactDir: path.join(tmpDir, ".xci/runs/20260205-abc123/artifacts"),
		containerArchitecture: "amd64",
		platformMap: {
			"ubuntu-latest": "ghcr.io/catthehacker/ubuntu:act-latest",
		},
		envFile: path.join(tmpDir, ".xci/runs/20260205-abc123/env.list"),
		varsFile: path.join(tmpDir, ".xci/runs/20260205-abc123/vars.list"),
		secretsFile: path.join(tmpDir, ".xci/runs/20260205-abc123/secrets.list"),
		...overrides,
	};
}

test("act plan builds deterministic args with matrix and injection files", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xci-act-plan-"));
	const adapter = new ActAdapter();
	const context = makeContext(tmpDir);
	fs.mkdirSync(context.runDir, { recursive: true });

	const planned = await adapter.plan(context, makePlan());
	const args = planned.jobs[0]?.engineArgs ?? [];

	assert.deepEqual(args, [
		"act",
		"push",
		"--workflows",
		context.workflowsPath,
		"--job",
		"build-and-test",
		"--rm",
		"--eventpath",
		path.join(context.runDir, "event.json"),
		"--matrix",
		"node:20",
		"--artifact-server-path",
		context.artifactDir,
		"--artifact-server-addr",
		"127.0.0.1",
		"--artifact-server-port",
		"0",
		"--container-architecture",
		"linux/amd64",
		"--platform",
		"ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest",
		"--env-file",
		context.envFile ?? "",
		"--var-file",
		context.varsFile ?? "",
		"--secret-file",
		context.secretsFile ?? "",
	]);
});

test("act plan writes default event payload when event path is missing", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xci-act-event-"));
	const adapter = new ActAdapter();
	const context = makeContext(tmpDir);
	fs.mkdirSync(context.runDir, { recursive: true });

	const planned = await adapter.plan(context, makePlan({ event: { name: "pull_request" } }));
	assert.ok(planned.event.payloadPath);
	assert.equal(fs.existsSync(planned.event.payloadPath as string), true);
});

test("act plan preserves existing event payload path", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xci-act-event-existing-"));
	const adapter = new ActAdapter();
	const payloadPath = path.join(tmpDir, "payload.json");
	fs.writeFileSync(payloadPath, JSON.stringify({ ref: "refs/heads/main" }));
	const context = makeContext(tmpDir, { eventPayloadPath: payloadPath });
	fs.mkdirSync(context.runDir, { recursive: true });

	const planned = await adapter.plan(context, makePlan());
	assert.equal(planned.event.payloadPath, payloadPath);
});
