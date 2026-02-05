import type { RunStatus } from "../../../core/types.js";

export type RunViewMode = "summary" | "details";
export type RunViewFocus = "jobs" | "steps";

export type HelpTextInput = {
	viewMode: RunViewMode;
	focusedPane: RunViewFocus;
	quitPromptVisible: boolean;
	statusText: RunStatus;
};

export function formatHelpText({
	viewMode,
	focusedPane,
	quitPromptVisible,
	statusText,
}: HelpTextInput): string {
	if (quitPromptVisible) {
		return statusText === "running"
			? "Y: confirm cancel · N/Enter/Esc: continue run"
			: "Y: cleanup and exit · N/Enter: exit · Esc: back";
	}
	if (viewMode === "summary") {
		return "Tab: switch view · D: details · S: summary · Q: exit";
	}
	const paneHint =
		focusedPane === "jobs" ? "Left/Right: focus pane (jobs)" : "Left/Right: focus pane (steps)";
	return `${paneHint} · Up/Down: move · Space/Enter: toggle step · Tab: switch view · S: summary · Q: exit`;
}
