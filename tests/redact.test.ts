import { describe, expect, it } from "vitest";
import { redactArgs } from "../src/utils/redact.js";

describe("redact args", () => {
	it("redacts file flags and inline values", () => {
		const args = [
			"act",
			"push",
			"--env-file",
			"/tmp/env",
			"--secret-file=/tmp/secret",
			"--var-file",
			"vars.env",
			"--platform",
			"ubuntu-latest=img",
		];

		expect(redactArgs(args)).toEqual([
			"act",
			"push",
			"--env-file",
			"<redacted>",
			"--secret-file=<redacted>",
			"--var-file",
			"<redacted>",
			"--platform",
			"ubuntu-latest=img",
		]);
	});
});
