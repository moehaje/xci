import type { RunStatus } from "../../../core/types.js";
import type { Edge } from "../model/summary-graph.js";

export type CanvasStyle = {
	color?: "green" | "red" | "yellow" | "gray";
	dim?: boolean;
	backgroundColor?: "black" | "gray";
	bold?: boolean;
};

export type CanvasCell = {
	char: string;
	style?: CanvasStyle;
};

export type Canvas = {
	width: number;
	height: number;
	cells: CanvasCell[][];
};

export type CardLayout = {
	cardId: string;
	x: number;
	y: number;
	width: number;
	height: number;
	status: RunStatus;
};

const DIR_N = 1;
const DIR_E = 2;
const DIR_S = 4;
const DIR_W = 8;

type ConnectorCell = {
	mask: number;
	status: RunStatus;
};

const STATUS_PRIORITY: Record<RunStatus, number> = {
	success: 0,
	canceled: 1,
	pending: 2,
	running: 3,
	failed: 4,
};

export function createCanvas(width: number, height: number): Canvas {
	const cells: CanvasCell[][] = Array.from({ length: height }, () =>
		Array.from({ length: width }, () => ({ char: " " })),
	);
	return { width, height, cells };
}

export function drawEdges(
	canvas: Canvas,
	edges: Edge[],
	layoutByCard: Map<string, CardLayout>,
	spinnerIndex: number,
): void {
	const connectorCells = new Map<string, ConnectorCell>();

	for (const edge of edges) {
		const from = layoutByCard.get(edge.fromCardId);
		const to = layoutByCard.get(edge.toCardId);
		if (!from || !to) {
			continue;
		}
		const startX = from.x + from.width - 1;
		const startY = from.y + Math.floor(from.height / 2);
		const endX = to.x;
		const endY = to.y + Math.floor(to.height / 2);

		const bridgeStartX = Math.min(canvas.width - 1, startX + 1);
		const bridgeEndX = Math.max(0, endX - 1);
		const midX = Math.floor((bridgeStartX + bridgeEndX) / 2);

		addOrthogonalPath(connectorCells, bridgeStartX, startY, midX, startY, edge.status);
		addOrthogonalPath(connectorCells, midX, startY, midX, endY, edge.status);
		addOrthogonalPath(connectorCells, midX, endY, bridgeEndX, endY, edge.status);
		addOrthogonalPath(connectorCells, startX, startY, bridgeStartX, startY, edge.status);
		addOrthogonalPath(connectorCells, bridgeEndX, endY, endX, endY, edge.status);
	}

	for (const [key, value] of connectorCells.entries()) {
		const [xText, yText] = key.split(":");
		const x = Number.parseInt(xText ?? "", 10);
		const y = Number.parseInt(yText ?? "", 10);
		if (Number.isNaN(x) || Number.isNaN(y)) {
			continue;
		}
		if (!isInBounds(canvas, x, y)) {
			continue;
		}
		const char = maskToChar(value.mask);
		if (!char) {
			continue;
		}
		canvas.cells[y][x] = {
			char,
			style: statusToConnectorStyle(value.status, spinnerIndex, x, y),
		};
	}
}

export function drawPort(canvas: Canvas, x: number, y: number, status: RunStatus, spinnerIndex: number): void {
	if (!isInBounds(canvas, x, y)) {
		return;
	}
	canvas.cells[y][x] = {
		char: "●",
		style: statusToPortStyle(status, spinnerIndex, x, y),
	};
}

function addOrthogonalPath(
	cells: Map<string, ConnectorCell>,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	status: RunStatus,
): void {
	if (x1 === x2 && y1 === y2) {
		updateCell(cells, x1, y1, 0, status);
		return;
	}
	if (x1 !== x2 && y1 !== y2) {
		return;
	}
	if (x1 === x2) {
		const [fromY, toY] = y1 <= y2 ? [y1, y2] : [y2, y1];
		for (let y = fromY; y <= toY; y += 1) {
			let mask = 0;
			if (y > fromY) {
				mask |= DIR_N;
			}
			if (y < toY) {
				mask |= DIR_S;
			}
			updateCell(cells, x1, y, mask, status);
		}
		return;
	}

	const [fromX, toX] = x1 <= x2 ? [x1, x2] : [x2, x1];
	for (let x = fromX; x <= toX; x += 1) {
		let mask = 0;
		if (x > fromX) {
			mask |= DIR_W;
		}
		if (x < toX) {
			mask |= DIR_E;
		}
		updateCell(cells, x, y1, mask, status);
	}
}

function updateCell(
	cells: Map<string, ConnectorCell>,
	x: number,
	y: number,
	mask: number,
	status: RunStatus,
): void {
	const key = `${x}:${y}`;
	const current = cells.get(key);
	if (!current) {
		cells.set(key, { mask, status });
		return;
	}
	current.mask |= mask;
	if (STATUS_PRIORITY[status] > STATUS_PRIORITY[current.status]) {
		current.status = status;
	}
}

function maskToChar(mask: number): string {
	switch (mask) {
		case DIR_E | DIR_W:
			return "─";
		case DIR_N | DIR_S:
			return "│";
		case DIR_S | DIR_E:
			return "╭";
		case DIR_S | DIR_W:
			return "╮";
		case DIR_N | DIR_E:
			return "╰";
		case DIR_N | DIR_W:
			return "╯";
		case DIR_N | DIR_S | DIR_E:
			return "├";
		case DIR_N | DIR_S | DIR_W:
			return "┤";
		case DIR_E | DIR_W | DIR_S:
			return "┬";
		case DIR_E | DIR_W | DIR_N:
			return "┴";
		case DIR_N | DIR_E | DIR_S | DIR_W:
			return "┼";
		default:
			return "";
	}
}

function statusToConnectorStyle(
	status: RunStatus,
	spinnerIndex: number,
	x: number,
	y: number,
): CanvasStyle {
	switch (status) {
		case "failed":
			return { color: "red" };
		case "running": {
			const pulse = (x + y - spinnerIndex + 700) % 7;
			return { color: "yellow", dim: pulse >= 3 };
		}
		case "pending":
			return { color: "gray", dim: true };
		case "canceled":
			return { color: "gray", dim: true };
		default:
			return { color: "green", dim: true };
	}
}

function statusToPortStyle(
	status: RunStatus,
	spinnerIndex: number,
	x: number,
	y: number,
): CanvasStyle {
	const base = statusToConnectorStyle(status, spinnerIndex, x, y);
	if (status !== "running") {
		return base;
	}
	return { ...base, dim: (spinnerIndex + x + y) % 5 >= 2 };
}

function isInBounds(canvas: Canvas, x: number, y: number): boolean {
	return x >= 0 && y >= 0 && x < canvas.width && y < canvas.height;
}
