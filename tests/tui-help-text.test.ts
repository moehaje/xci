import { describe, expect, it } from "vitest";
import { formatHelpText } from "../src/tui/run-view/utils/help.js";

describe("tui help text", () => {
	it("shows summary mode controls", () => {
		const text = formatHelpText({
			viewMode: "summary",
			focusedPane: "jobs",
			quitPromptVisible: false,
			statusText: "running",
		});
		expect(text).toContain("D: details");
		expect(text).toContain("Q: exit");
	});

	it("shows details mode controls", () => {
		const text = formatHelpText({
			viewMode: "details",
			focusedPane: "steps",
			quitPromptVisible: false,
			statusText: "running",
		});
		expect(text).toContain("Space/Enter: toggle step");
		expect(text).toContain("focus pane");
	});

	it("shows quit confirmation controls", () => {
		const text = formatHelpText({
			viewMode: "details",
			focusedPane: "steps",
			quitPromptVisible: true,
			statusText: "running",
		});
		expect(text).toBe("Y: confirm cancel · N/Enter/Esc: continue run");
	});
});
