import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ActAdapter } from "../src/engines/act/act-adapter.js";
import type { EngineContext, EngineRuntimeEvent } from "../src/core/engine.js";
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

describe("act adapter", () => {
	it("plans deterministic args with matrix and injection files", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xci-act-plan-"));
		const adapter = new ActAdapter();
		const context = makeContext(tmpDir);
		fs.mkdirSync(context.runDir, { recursive: true });

		const planned = await adapter.plan(context, makePlan());
		const args = planned.jobs[0]?.engineArgs ?? [];

		expect(args).toEqual([
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

	it("writes default event payload when event path is missing", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xci-act-event-"));
		const adapter = new ActAdapter();
		const context = makeContext(tmpDir);
		fs.mkdirSync(context.runDir, { recursive: true });

		const planned = await adapter.plan(context, makePlan({ event: { name: "pull_request" } }));
		expect(planned.event.payloadPath).toBeTruthy();
		expect(fs.existsSync(planned.event.payloadPath as string)).toBe(true);
	});

	it("preserves existing event payload path", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xci-act-event-existing-"));
		const adapter = new ActAdapter();
		const payloadPath = path.join(tmpDir, "payload.json");
		fs.writeFileSync(payloadPath, JSON.stringify({ ref: "refs/heads/main" }));
		const context = makeContext(tmpDir, { eventPayloadPath: payloadPath });
		fs.mkdirSync(context.runDir, { recursive: true });

		const planned = await adapter.plan(context, makePlan());
		expect(planned.event.payloadPath).toBe(payloadPath);
	});

	it("emits canceled events and returns 130 when signal is pre-aborted", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xci-act-cancel-"));
		const adapter = new ActAdapter();
		const events: EngineRuntimeEvent[] = [];
		const abort = new AbortController();
		abort.abort();
		const context = makeContext(tmpDir, {
			signal: abort.signal,
			onEvent: (event) => events.push(event),
		});
		fs.mkdirSync(context.runDir, { recursive: true });
		fs.mkdirSync(context.logsDir, { recursive: true });

		const result = await adapter.run(
			makePlan({
				jobs: [
					{
						jobId: "build-and-test",
						matrix: null,
						engineArgs: [],
					},
					{
						jobId: "lint",
						matrix: null,
						engineArgs: [],
					},
				],
			}),
			context,
		);

		expect(result.exitCode).toBe(130);
		expect(events.map((event) => event.type)).toEqual([
			"run-started",
			"jobs-canceled",
			"run-finished",
		]);
	});
});
