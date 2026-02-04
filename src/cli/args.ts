import fs from "node:fs";
import type { CleanupMode } from "./cleanup.js";

export type CliOptions = {
	command: "run" | "init" | "cleanup";
	workflow?: string;
	jobs?: string[];
	all?: boolean;
	json?: boolean;
	event?: string;
	eventPath?: string;
	matrix?: string[];
	preset?: string;
	noCleanup?: boolean;
	cleanupMode?: CleanupMode;
	full?: boolean;
	help?: boolean;
	version?: boolean;
	unknown?: string[];
	errors?: string[];
};

export function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { command: "run", unknown: [], errors: [] };
	const args = [...argv];
	if (args[0] && !args[0].startsWith("-")) {
		const command = args[0];
		if (command === "run" || command === "init" || command === "cleanup") {
			options.command = command;
		} else {
			options.command = command as CliOptions["command"];
		}
		args.shift();
	}

	while (args.length) {
		const arg = args.shift();
		switch (arg) {
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--version":
			case "-v":
				options.version = true;
				break;
			case "--workflow":
				options.workflow = takeValue("--workflow", args, options);
				break;
			case "--job":
				{
					const value = takeValue("--job", args, options);
					if (value) {
						options.jobs = value.split(",").filter(Boolean);
					}
				}
				break;
			case "--all":
				options.all = true;
				break;
			case "--event":
				options.event = takeValue("--event", args, options);
				break;
			case "--event-path":
				options.eventPath = takeValue("--event-path", args, options);
				break;
			case "--matrix":
				{
					const value = takeValue("--matrix", args, options);
					if (value) {
						options.matrix = collectMatrices(options.matrix, value);
					}
				}
				break;
			case "--preset":
				options.preset = takeValue("--preset", args, options);
				break;
			case "--json":
				options.json = true;
				break;
			case "--no-cleanup":
				options.noCleanup = true;
				break;
			case "--cleanup-mode":
				{
					const value = takeValue("--cleanup-mode", args, options);
					if (value) {
						const normalized = toCleanupMode(value);
						if (normalized) {
							options.cleanupMode = normalized;
						} else {
							options.errors?.push(`Invalid value for --cleanup-mode: ${value} (expected off|fast|full)`);
						}
					}
				}
				break;
			case "--full":
				options.full = true;
				break;
			default:
				if (arg) {
					options.unknown?.push(arg);
				}
				break;
		}
	}

	return options;
}

export function printHelp(): void {
	process.stdout.write(`xci <command> [options]\n\n`);
	process.stdout.write(`Commands:\n`);
	process.stdout.write(`  run                  Run workflows (default)\n`);
	process.stdout.write(`  init                 Add .xci to .gitignore\n\n`);
	process.stdout.write(`  cleanup              Remove local act containers/volumes/images\n\n`);
	process.stdout.write(`Options:\n`);
	process.stdout.write(`  --workflow <file>     Workflow file name or id\n`);
	process.stdout.write(`  --job <ids>           Comma-separated job ids\n`);
	process.stdout.write(`  --all                 Run all jobs\n`);
	process.stdout.write(
		`  --event <name>        Event name (push, pull_request, workflow_dispatch)\n`,
	);
	process.stdout.write(`  --event-path <file>   JSON payload path\n`);
	process.stdout.write(`  --matrix <k:v>        Matrix override (repeatable)\n`);
	process.stdout.write(`  --preset <name>       Preset id\n`);
	process.stdout.write(`  --no-cleanup          Disable post-run act cleanup\n`);
	process.stdout.write(`  --cleanup-mode <m>    Cleanup mode: off|fast|full\n`);
	process.stdout.write(`  --full                For cleanup command, remove act images/toolcache too\n`);
	process.stdout.write(`  --json                Print JSON summary\n`);
	process.stdout.write(`  -h, --help            Show help\n`);
	process.stdout.write(`  -v, --version         Show version\n`);
}

export function readPackageVersion(): string {
	const pkgUrl = new URL("../../package.json", import.meta.url);
	const raw = fs.readFileSync(pkgUrl, "utf-8");
	const parsed = JSON.parse(raw) as { version?: string };
	return parsed.version ?? "0.0.0";
}

function collectMatrices(current: string[] | undefined, value?: string): string[] | undefined {
	if (!value) {
		return current;
	}
	return [...(current ?? []), value];
}

function takeValue(flag: string, args: string[], options: CliOptions): string | undefined {
	const value = args.shift();
	if (!value || value.startsWith("-")) {
		options.errors?.push(`Missing value for ${flag}`);
		if (value) {
			args.unshift(value);
		}
		return undefined;
	}
	return value;
}

function toCleanupMode(value: string): CleanupMode | undefined {
	if (value === "off" || value === "fast" || value === "full") {
		return value;
	}
	return undefined;
}
