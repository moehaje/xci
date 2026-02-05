import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		...options,
	});
	if (result.status !== 0) {
		const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(`Command failed: ${command} ${args.join(" ")}\n${details}`);
	}
	return result;
}

const tmpPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "xci-pack-"));
const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "xci-smoke-empty-"));

const packed = run("npm", ["pack", "--silent"]);
const tarball = packed.stdout.trim().split("\n").filter(Boolean).at(-1);
if (!tarball) {
	throw new Error("Failed to resolve packed tarball name.");
}

try {
	run("npm", ["install", "--prefix", tmpPrefix, tarball]);
	const cli = path.join(tmpPrefix, "node_modules", ".bin", "xci");

	run(cli, ["--version"]);
	const help = run(cli, ["--help"]);
	if (!help.stdout.includes("xci <command> [options]")) {
		throw new Error("Expected help output to include command usage.");
	}

	const runJson = spawnSync(cli, ["run", "--json"], {
		cwd: emptyRepo,
		encoding: "utf-8",
	});
	if (runJson.status !== 1) {
		throw new Error(`Expected 'xci run --json' to exit 1 in empty repo, got ${runJson.status}.`);
	}
	if (!runJson.stderr.includes("No workflows found in .github/workflows.")) {
		throw new Error("Expected empty-repo error message from 'xci run --json'.");
	}
} finally {
	fs.rmSync(path.join(process.cwd(), tarball), { force: true });
	fs.rmSync(tmpPrefix, { recursive: true, force: true });
	fs.rmSync(emptyRepo, { recursive: true, force: true });
}
