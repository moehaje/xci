import process from "node:process";
import { cancel, confirm, isCancel } from "@clack/prompts";

export async function runPreflightChecks(
	containerEngine: string,
	interactive: boolean,
): Promise<boolean> {
	const actOk = await ensureActAvailable(interactive);
	const engineOk = await ensureEngineAvailable(containerEngine, interactive);
	return actOk && engineOk;
}

async function checkCommand(command: string, args: string[], label: string): Promise<boolean> {
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(command, args, { stdio: "ignore" });
	if (result.status !== 0) {
		process.stderr.write(`${label} is not available. Install and retry.\n`);
		return false;
	}
	return true;
}

async function ensureActAvailable(interactive: boolean): Promise<boolean> {
	const ok = await checkCommand("act", ["--version"], "act");
	if (ok || !interactive) {
		return ok;
	}
	const shouldInstall = await confirm({
		message: "act is not installed. Install it now?",
		initialValue: true,
	});
	if (isCancel(shouldInstall) || !shouldInstall) {
		cancel("Canceled.");
		return false;
	}
	const installed = await installAct();
	if (!installed) {
		process.stderr.write("Failed to install act. Install it manually and retry.\n");
		return false;
	}
	return checkCommand("act", ["--version"], "act");
}

async function ensureEngineAvailable(engine: string, interactive: boolean): Promise<boolean> {
	const available = await commandExists(engine);
	if (!available) {
		process.stderr.write(`${engine} is not available. Install and retry.\n`);
		return false;
	}
	const ok = await checkEngineInfo(engine);
	if (ok || !interactive) {
		if (!ok && !interactive) {
			process.stderr.write(`${engine} is not running. Start it and retry.\n`);
		}
		return ok;
	}
	const shouldStart = await confirm({
		message: `${engine} is not running. Start it now?`,
		initialValue: true,
	});
	if (isCancel(shouldStart) || !shouldStart) {
		cancel("Canceled.");
		return false;
	}
	const started = await startContainerEngine(engine);
	if (!started) {
		process.stderr.write(`Failed to start ${engine}. Please start it and retry.\n`);
		return false;
	}
	const ready = await waitForEngine(engine);
	if (!ready) {
		process.stderr.write(`${engine} is still not running. Please retry in a moment.\n`);
		return false;
	}
	return true;
}

async function installAct(): Promise<boolean> {
	const { spawnSync } = await import("node:child_process");
	const platform = process.platform;
	if (platform === "darwin") {
		if (!(await commandExists("brew"))) {
			process.stderr.write("Homebrew not found. Install Homebrew to install act.\n");
			return false;
		}
		return spawnSync("brew", ["install", "act"], { stdio: "inherit" }).status === 0;
	}

	if (platform === "linux") {
		if (await commandExists("apt-get")) {
			if (spawnSync("sudo", ["apt-get", "update"], { stdio: "inherit" }).status !== 0) {
				return false;
			}
			return (
				spawnSync("sudo", ["apt-get", "install", "-y", "act"], { stdio: "inherit" }).status === 0
			);
		}
		if (await commandExists("dnf")) {
			return spawnSync("sudo", ["dnf", "install", "-y", "act"], { stdio: "inherit" }).status === 0;
		}
		if (await commandExists("yum")) {
			return spawnSync("sudo", ["yum", "install", "-y", "act"], { stdio: "inherit" }).status === 0;
		}
		if (await commandExists("pacman")) {
			return (
				spawnSync("sudo", ["pacman", "-S", "--noconfirm", "act"], { stdio: "inherit" }).status === 0
			);
		}
	}

	if (platform === "win32") {
		if (await commandExists("winget")) {
			return (
				spawnSync("winget", ["install", "--id", "nektos.act"], { stdio: "inherit" }).status === 0
			);
		}
		if (await commandExists("choco")) {
			return spawnSync("choco", ["install", "act", "-y"], { stdio: "inherit" }).status === 0;
		}
	}

	process.stderr.write("No supported package manager found for act installation.\n");
	return false;
}

async function startContainerEngine(engine: string): Promise<boolean> {
	const { spawnSync } = await import("node:child_process");
	const platform = process.platform;

	if (engine === "docker" && platform === "darwin") {
		const openResult = spawnSync("open", ["-g", "-a", "Docker"], { stdio: "ignore" });
		if (openResult.status !== 0) {
			return false;
		}
		return true;
	}

	if (platform === "linux") {
		if (await commandExists("systemctl")) {
			const result = spawnSync("sudo", ["systemctl", "start", engine], { stdio: "inherit" });
			return result.status === 0;
		}
	}

	if (engine === "podman") {
		if (await commandExists("podman")) {
			const result = spawnSync("podman", ["machine", "start"], { stdio: "inherit" });
			return result.status === 0;
		}
	}

	if (engine === "docker" && platform === "win32") {
		const result = spawnSync(
			"powershell.exe",
			["-NoProfile", "-Command", "Start-Service com.docker.service"],
			{ stdio: "ignore" },
		);
		return result.status === 0;
	}

	return false;
}

async function commandExists(command: string): Promise<boolean> {
	const { spawnSync } = await import("node:child_process");
	const checker = process.platform === "win32" ? "where" : "which";
	return spawnSync(checker, [command], { stdio: "ignore" }).status === 0;
}

async function checkEngineInfo(engine: string): Promise<boolean> {
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(engine, ["info"], { stdio: "ignore" });
	return result.status === 0;
}

async function waitForEngine(engine: string): Promise<boolean> {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		if (await checkEngineInfo(engine)) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return false;
}
