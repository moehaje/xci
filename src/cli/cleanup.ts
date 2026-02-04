import { spawnSync } from "node:child_process";

export type CleanupMode = "default" | "full";

export type CleanupSummary = {
	engine: "docker" | "podman";
	removedActContainers: number;
	removedActVolumes: number;
	removedActImages: number;
	errors: string[];
};

export function cleanupRuntime(
	engine: "docker" | "podman",
	mode: CleanupMode = "default",
): CleanupSummary {
	const summary: CleanupSummary = {
		engine,
		removedActContainers: 0,
		removedActVolumes: 0,
		removedActImages: 0,
		errors: [],
	};

	const actContainers = listActContainers(engine);
	if (actContainers.length > 0) {
		const removal = run(engine, ["rm", "-f", ...actContainers.map((container) => container.id)]);
		if (removal.ok) {
			summary.removedActContainers = actContainers.length;
		} else {
			summary.errors.push(`failed to remove act containers: ${removal.error}`);
		}
	}

	const actVolumes = listActVolumes(engine);
	if (actVolumes.length > 0) {
		const removal = run(engine, ["volume", "rm", "-f", ...actVolumes]);
		if (removal.ok) {
			summary.removedActVolumes = actVolumes.length;
		} else {
			summary.errors.push(`failed to remove act volumes: ${removal.error}`);
		}
	}

	const actImages = listActImages(engine);
	if (actImages.length > 0) {
		const removal = run(engine, ["rmi", "-f", ...actImages]);
		if (removal.ok) {
			summary.removedActImages = actImages.length;
		} else {
			summary.errors.push(`failed to remove act images: ${removal.error}`);
		}
	}

	void mode;

	return summary;
}

function listActContainers(engine: "docker" | "podman"): { id: string; status: string }[] {
	const result = run(engine, ["ps", "-a", "--filter", "name=^act-", "--format", "{{.ID}}\t{{.Status}}"]);
	if (!result.ok || !result.stdout) {
		return [];
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [id, ...statusParts] = line.split("\t");
			return { id, status: statusParts.join("\t") };
		})
		.filter((item) => item.id.length > 0);
}

function listActVolumes(engine: "docker" | "podman"): string[] {
	const result = run(engine, ["volume", "ls", "--format", "{{.Name}}"]);
	if (!result.ok || !result.stdout) {
		return [];
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((name) => name.startsWith("act-"));
}

function listActImages(engine: "docker" | "podman"): string[] {
	const result = run(engine, ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]);
	if (!result.ok || !result.stdout) {
		return [];
	}
	const images = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((image) => isActImage(image));
	return Array.from(new Set(images));
}

function isActImage(image: string): boolean {
	if (image.startsWith("ghcr.io/catthehacker/ubuntu:act-")) {
		return true;
	}
	if (image.startsWith("nektos/act-environments-")) {
		return true;
	}
	if (image.startsWith("catthehacker/ubuntu:act-")) {
		return true;
	}
	return false;
}

function run(
	command: string,
	args: string[],
): { ok: true; stdout: string } | { ok: false; error: string } {
	const result = spawnSync(command, args, { encoding: "utf-8" });
	if (result.status === 0) {
		return { ok: true, stdout: result.stdout ?? "" };
	}
	const stderr = result.stderr?.trim();
	const stdout = result.stdout?.trim();
	const message = stderr || stdout || `exit ${result.status ?? "unknown"}`;
	return { ok: false, error: message };
}
