import { describe, expect, it } from "vitest";
import { ensureWithinBase, sanitizePathSegment } from "../src/utils/path-safety.js";

describe("path safety", () => {
	it("blocks traversal outside base", () => {
		expect(() => ensureWithinBase("/tmp/xci", "../etc/passwd", "test")).toThrow(
			/escapes base directory/,
		);
	});

	it("normalizes path segments", () => {
		expect(sanitizePathSegment("Job: Build/Release", "fallback")).toBe("Job-Build-Release");
		expect(sanitizePathSegment("   ", "fallback")).toBe("fallback");
	});
});
