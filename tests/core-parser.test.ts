import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../src/core/parser.js";

describe("core parser", () => {
	it("parses workflow metadata, events, jobs and steps", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xci-parser-"));
		const workflowPath = path.join(tmpDir, "ci.yml");
		fs.writeFileSync(
			workflowPath,
			[
				"name: CI",
				"on:",
				"  push:",
				"  pull_request:",
				"jobs:",
				"  build:",
				"    name: Build job",
				"    needs: test",
				"    runs-on: [ubuntu-latest, self-hosted]",
				"    env:",
				"      NODE_ENV: test",
				"    strategy:",
				"      matrix:",
				"        node: [18, 20]",
				"    steps:",
				"      - run: npm ci",
				"      - uses: actions/setup-node@v4",
			].join("\n"),
		);

		const workflow = parseWorkflow(workflowPath);

		expect(workflow.name).toBe("CI");
		expect(workflow.events).toEqual(["push", "pull_request"]);
		expect(workflow.jobs).toHaveLength(1);
		expect(workflow.jobs[0]).toMatchObject({
			id: "build",
			name: "Build job",
			needs: ["test"],
			runsOn: "ubuntu-latest, self-hosted",
			env: { NODE_ENV: "test" },
			strategy: { matrix: { node: [18, 20] } },
		});
		expect(workflow.jobs[0]?.steps).toEqual([
			{
				id: "build-step-1",
				name: "npm ci",
				run: "npm ci",
				uses: undefined,
				if: undefined,
				env: undefined,
			},
			{
				id: "build-step-2",
				name: "actions/setup-node@v4",
				run: undefined,
				uses: "actions/setup-node@v4",
				if: undefined,
				env: undefined,
			},
		]);
	});

	it("parses on as string and array", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xci-parser-on-"));
		const singlePath = path.join(tmpDir, "single.yml");
		fs.writeFileSync(singlePath, ["on: push", "jobs: {}"].join("\n"));
		expect(parseWorkflow(singlePath).events).toEqual(["push"]);

		const multiPath = path.join(tmpDir, "multi.yml");
		fs.writeFileSync(multiPath, ["on: [push, workflow_dispatch]", "jobs: {}"].join("\n"));
		expect(parseWorkflow(multiPath).events).toEqual(["push", "workflow_dispatch"]);
	});

	it("includes file and location when yaml is invalid", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xci-parser-invalid-"));
		const workflowPath = path.join(tmpDir, "broken.yml");
		fs.writeFileSync(workflowPath, ["name: CI", "on", "jobs: {}"].join("\n"));

		expect(() => parseWorkflow(workflowPath)).toThrowError(
			new RegExp(`${workflowPath.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:\\d+:\\d+`),
		);
	});
});
