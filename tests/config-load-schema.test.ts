import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load-config.js";
import { ConfigSchema } from "../src/config/schema.js";

describe("config schema", () => {
	it("applies defaults", () => {
		const parsed = ConfigSchema.parse({});
		expect(parsed).toMatchObject({
			engine: "act",
			runtime: {
				container: "docker",
				architecture: "auto",
				cleanup: true,
				cleanupMode: "fast",
				image: {},
				platformMap: {},
			},
			env: {},
			vars: {},
			secrets: {},
			presets: {},
		});
	});

	it("rejects invalid runtime values", () => {
		expect(() =>
			ConfigSchema.parse({
				runtime: {
					container: "nerdctl",
				},
			}),
		).toThrow();
	});
});

describe("load config", () => {
	it("returns defaults when .xci.yml does not exist", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xci-config-empty-"));
		const loaded = loadConfig(repoRoot);

		expect(loaded.path).toBeUndefined();
		expect(loaded.config.engine).toBe("act");
		expect(loaded.config.runtime.container).toBe("docker");
	});

	it("loads and validates .xci.yml", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xci-config-ok-"));
		const configPath = path.join(repoRoot, ".xci.yml");
		fs.writeFileSync(
			configPath,
			[
				"engine: act",
				"runtime:",
				"  container: podman",
				"  cleanupMode: full",
				"presets:",
				"  quick:",
				"    jobs: [build]",
				"    event:",
				"      name: workflow_dispatch",
			].join("\n"),
		);

		const loaded = loadConfig(repoRoot);
		expect(loaded.path).toBe(configPath);
		expect(loaded.config.runtime.container).toBe("podman");
		expect(loaded.config.runtime.cleanupMode).toBe("full");
		expect(loaded.config.presets.quick?.event?.name).toBe("workflow_dispatch");
	});

	it("throws on invalid config shape", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xci-config-invalid-"));
		const configPath = path.join(repoRoot, ".xci.yml");
		fs.writeFileSync(configPath, ["runtime:", "  cleanupMode: turbo"].join("\n"));

		expect(() => loadConfig(repoRoot)).toThrow();
	});
});
