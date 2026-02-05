import assert from "node:assert/strict";
import test from "node:test";
import { formatHelpText } from "../src/tui/run-view/utils/help.js";

test("help text reflects summary mode controls", () => {
	const text = formatHelpText({
		viewMode: "summary",
		focusedPane: "jobs",
		quitPromptVisible: false,
		statusText: "running",
	});
	assert.match(text, /D: details/);
	assert.match(text, /Q: exit/);
});

test("help text reflects details mode controls", () => {
	const text = formatHelpText({
		viewMode: "details",
		focusedPane: "steps",
		quitPromptVisible: false,
		statusText: "running",
	});
	assert.match(text, /Space\/Enter: toggle step/);
	assert.match(text, /focus pane/);
});

test("help text reflects quit confirmation controls", () => {
	const text = formatHelpText({
		viewMode: "details",
		focusedPane: "steps",
		quitPromptVisible: true,
		statusText: "running",
	});
	assert.equal(text, "Y: confirm cancel · N/Enter/Esc: continue run");
});
