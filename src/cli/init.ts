import fs from "node:fs";
import path from "node:path";

const ignoreEntry = ".xci";

export type GitignoreResult = "added" | "present" | "skipped";

export function ensureGitignore(repoRoot: string): GitignoreResult {
	const gitDir = path.join(repoRoot, ".git");
	if (!fs.existsSync(gitDir)) {
		return "skipped";
	}

	const ignorePath = path.join(repoRoot, ".gitignore");
	const hasIgnoreFile = fs.existsSync(ignorePath);
	const current = hasIgnoreFile ? fs.readFileSync(ignorePath, "utf-8") : "";
	const lines = current.split(/\r?\n/);
	const hasEntry = lines.some((line) => normalizeIgnoreLine(line) === ignoreEntry);

	if (hasEntry) {
		return "present";
	}

	const next = buildUpdatedIgnore(current, hasIgnoreFile);
	fs.writeFileSync(ignorePath, next);
	return "added";
}

export function runInit(repoRoot: string): void {
	const result = ensureGitignore(repoRoot);
	if (result === "added") {
		process.stdout.write("Added '.xci' to .gitignore.\n");
		return;
	}
	if (result === "present") {
		process.stdout.write("'.xci' is already in .gitignore.\n");
		return;
	}
	process.stdout.write("Skipped: not a git repository.\n");
}

function normalizeIgnoreLine(line: string): string {
	const trimmed = line.trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildUpdatedIgnore(current: string, hasIgnoreFile: boolean): string {
	if (!hasIgnoreFile || current.trim().length === 0) {
		return `${ignoreEntry}\n`;
	}
	const endsWithNewline = current.endsWith("\n");
	const prefix = endsWithNewline ? current : `${current}\n`;
	return `${prefix}${ignoreEntry}\n`;
}
