import path from "node:path";

export function ensureWithinBase(baseDir: string, childPath: string, label: string): string {
	const base = path.resolve(baseDir);
	const resolved = path.resolve(base, childPath);
	const rel = path.relative(base, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Invalid ${label}: path escapes base directory`);
	}
	return resolved;
}

export function sanitizePathSegment(value: string, fallback: string): string {
	const normalized = value
		.trim()
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return normalized.length > 0 ? normalized : fallback;
}
