import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const cliPath = path.join(repoRoot, "dist", "index.js");

type CliRunResult = {
	status: number | null;
	stdout: string;
	stderr: string;
};

function runCli(args: string[], cwd = repoRoot): CliRunResult {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		cwd,
		encoding: "utf-8",
		env: process.env,
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

describe("packaged cli smoke", () => {
	it("has built entrypoint", () => {
		expect(fs.existsSync(cliPath)).toBe(true);
	});

	it("prints help", () => {
		const result = runCli(["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("xci <command> [options]");
	});

	it("prints version", () => {
		const result = runCli(["--version"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/^xci \d+\.\d+\.\d+/);
	});

	it("handles run --json in repos without workflows", () => {
		const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "xci-smoke-empty-"));
		const result = runCli(["run", "--json"], tmpRepo);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("No workflows found in .github/workflows.");
	});
});
