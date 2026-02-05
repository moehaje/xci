import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";

describe("cli args", () => {
	it("parses run options and repeatable matrix flags", () => {
		const parsed = parseArgs([
			"run",
			"--workflow",
			"ci.yml",
			"--job",
			"build,test",
			"--event",
			"pull_request",
			"--event-path",
			"payload.json",
			"--matrix",
			"node:20",
			"--matrix",
			"os:ubuntu-latest",
			"--json",
			"--no-cleanup",
			"--cleanup-mode",
			"full",
		]);

		expect(parsed).toMatchObject({
			command: "run",
			workflow: "ci.yml",
			jobs: ["build", "test"],
			event: "pull_request",
			eventPath: "payload.json",
			matrix: ["node:20", "os:ubuntu-latest"],
			json: true,
			noCleanup: true,
			cleanupMode: "full",
			unknown: [],
			errors: [],
		});
	});

	it("captures unknown options", () => {
		const parsed = parseArgs(["--wat", "--all"]);
		expect(parsed.unknown).toEqual(["--wat"]);
		expect(parsed.all).toBe(true);
	});

	it("reports missing values for valued flags", () => {
		const parsed = parseArgs(["--workflow", "--event", "push"]);
		expect(parsed.errors).toEqual(["Missing value for --workflow"]);
		expect(parsed.event).toBe("push");
	});

	it("reports invalid cleanup mode", () => {
		const parsed = parseArgs(["--cleanup-mode", "deep"]);
		expect(parsed.cleanupMode).toBeUndefined();
		expect(parsed.errors).toEqual([
			"Invalid value for --cleanup-mode: deep (expected off|fast|full)",
		]);
	});

	it("parses other subcommands", () => {
		expect(parseArgs(["init"]).command).toBe("init");
		expect(parseArgs(["cleanup", "--full"]).command).toBe("cleanup");
		expect(parseArgs(["cleanup", "--full"]).full).toBe(true);
	});
});
