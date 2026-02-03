import type { RunStatus } from "../../../core/types.js";
import { SPINNER_FRAMES } from "./constants.js";

export const STATUS_LABELS: Record<RunStatus, string> = {
	pending: "queued",
	running: "running",
	success: "success",
	failed: "failed",
	canceled: "canceled",
};

export function formatStatusText(status: RunStatus, spinnerIndex: number): string {
	switch (status) {
		case "success":
			return "●";
		case "failed":
			return "✕";
		case "running":
			return SPINNER_FRAMES[spinnerIndex] ?? "⠋";
		case "canceled":
			return "◌";
		default:
			return "○";
	}
}

export function colorForStatus(status: RunStatus): "green" | "red" | "yellow" | "gray" | undefined {
	switch (status) {
		case "success":
			return "green";
		case "failed":
			return "red";
		case "running":
			return "yellow";
		case "canceled":
			return "gray";
		default:
			return undefined;
	}
}

export function renderStatusGlyph(status: RunStatus, spinnerIndex: number): string {
	return formatStatusText(status, spinnerIndex);
}
