import { Box, Text } from "ink";
import type { RunStatus } from "../../core/types.js";
import { formatDuration } from "./format.js";
import { colorForStatus } from "./status.js";
import {
	type Canvas,
	type CanvasStyle,
	type CardLayout,
	createCanvas,
	drawEdges,
	drawPort,
} from "./summary-connectors.js";
import type { CardNode, SummaryGraph } from "./summary-graph.js";

const CARD_WIDTH = 34;
const CARD_GAP_Y = 1;
const COLUMN_GAP = 8;
const LEFT_PADDING = 2;
const TOP_PADDING = 1;
const CARD_PADDING_Y = 1;
const ROW_LEFT_INSET = 1;

type CanvasSegment = {
	id: string;
	text: string;
	style?: CanvasStyle;
};

type CanvasLine = {
	id: string;
	segments: CanvasSegment[];
};

export type SummaryGraphViewProps = {
	graph: SummaryGraph;
	spinnerIndex: number;
};

export function SummaryGraphView({ graph, spinnerIndex }: SummaryGraphViewProps): JSX.Element {
	if (graph.stages.length === 0) {
		return (
			<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
				<Text dimColor>Summary</Text>
				<Text dimColor>No jobs selected.</Text>
			</Box>
		);
	}

	const layout = buildLayout(graph);
	const canvas = createCanvas(layout.width, layout.height);
	drawEdges(canvas, graph.edges, layout.layoutByCard, spinnerIndex);
	const incomingCards = new Set(graph.edges.map((edge) => edge.toCardId));
	const outgoingCards = new Set(graph.edges.map((edge) => edge.fromCardId));

	for (const stage of graph.stages) {
		for (const card of stage.cards) {
			const cardLayout = layout.layoutByCard.get(card.id);
			if (!cardLayout) {
				continue;
			}
			drawCard(
				canvas,
				cardLayout,
				card,
				spinnerIndex,
				incomingCards.has(card.id),
				outgoingCards.has(card.id),
			);
		}
	}

	const lines = canvasToLines(canvas);

	return (
		<Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} paddingY={1}>
			<Text dimColor>Summary Graph</Text>
			{lines.map((line) => (
				<Text key={line.id}>
					{line.segments.map((segment) => (
						<Text
							key={segment.id}
							color={segment.style?.color}
							dimColor={segment.style?.dim}
							backgroundColor={segment.style?.backgroundColor}
							bold={segment.style?.bold}
						>
							{segment.text}
						</Text>
					))}
				</Text>
			))}
		</Box>
	);
}

export function estimateSummaryGraphWidth(stageCount: number): number {
	if (stageCount <= 0) {
		return 0;
	}
	return LEFT_PADDING + stageCount * CARD_WIDTH + (stageCount - 1) * COLUMN_GAP + LEFT_PADDING;
}

function buildLayout(graph: SummaryGraph): {
	width: number;
	height: number;
	layoutByCard: Map<string, CardLayout>;
} {
	const columnHeights: number[] = graph.stages.map((stage) => {
		if (stage.cards.length === 0) {
			return 0;
		}
		return stage.cards.reduce((acc, card, index) => {
			const height = getCardHeight(card);
			return acc + height + (index < stage.cards.length - 1 ? CARD_GAP_Y : 0);
		}, 0);
	});

	const contentHeight = Math.max(...columnHeights, 0);
	const height = TOP_PADDING * 2 + contentHeight;
	const width = estimateSummaryGraphWidth(graph.stages.length);
	const layoutByCard = new Map<string, CardLayout>();

	graph.stages.forEach((stage, stageIndex) => {
		const startX = LEFT_PADDING + stageIndex * (CARD_WIDTH + COLUMN_GAP);
		const stageHeight = columnHeights[stageIndex] ?? 0;
		let currentY = TOP_PADDING + Math.floor((contentHeight - stageHeight) / 2);
		for (const card of stage.cards) {
			const cardHeight = getCardHeight(card);
			layoutByCard.set(card.id, {
				cardId: card.id,
				x: startX,
				y: currentY,
				width: CARD_WIDTH,
				height: cardHeight,
				status: card.status,
			});
			currentY += cardHeight + CARD_GAP_Y;
		}
	});

	return {
		width,
		height,
		layoutByCard,
	};
}

function getCardHeight(card: CardNode): number {
	const headerHeight = card.header ? 2 : 0;
	return 2 + CARD_PADDING_Y * 2 + headerHeight + card.rows.length;
}

function drawCard(
	canvas: Canvas,
	layout: CardLayout,
	card: CardNode,
	spinnerIndex: number,
	hasIncomingEdge: boolean,
	hasOutgoingEdge: boolean,
): void {
	const { x, y, width, height } = layout;
	drawBorder(canvas, x, y, width, height);
	fillCardBackground(canvas, x + 1, y + 1, width - 2, height - 2);

	let lineOffset = y + 1 + CARD_PADDING_Y;
	if (card.header) {
		drawTextInCard(canvas, x, lineOffset, width, card.header, {
			color: "gray",
			bold: true,
			backgroundColor: "black",
		});
		lineOffset += 1;
		drawHorizontalRule(canvas, x, lineOffset, width);
		lineOffset += 1;
	}

	for (const row of card.rows) {
		const glyph = renderSummaryRowGlyph(row.status, spinnerIndex);
		const statusColor = colorForStatus(row.status);
		const duration = row.durationMs ? formatDuration(row.durationMs) : "";
		const left = `${" ".repeat(ROW_LEFT_INSET)}${glyph} ${truncate(row.label, width - 17 - ROW_LEFT_INSET)}`;
		const content = duration ? padWithRightLabel(left, duration, width - 2) : left;
		drawTextInCard(canvas, x, lineOffset, width, content, {
			color: statusColor,
			backgroundColor: "black",
		});
		lineOffset += 1;
	}

	const portY = y + Math.floor(height / 2);
	if (hasIncomingEdge) {
		drawPort(canvas, x, portY, card.status, spinnerIndex);
	}
	if (hasOutgoingEdge) {
		drawPort(canvas, x + width - 1, portY, card.status, spinnerIndex);
	}
}

function renderSummaryRowGlyph(status: RunStatus, spinnerIndex: number): string {
	switch (status) {
		case "success":
			return "●";
		case "failed":
			return "●";
		case "running":
			return spinnerIndex % 2 === 0 ? "●" : "◉";
		case "canceled":
			return "◌";
		default:
			return "○";
	}
}

function drawBorder(canvas: Canvas, x: number, y: number, width: number, height: number): void {
	setCell(canvas, x, y, "╭", { color: "gray", dim: true });
	setCell(canvas, x + width - 1, y, "╮", { color: "gray", dim: true });
	setCell(canvas, x, y + height - 1, "╰", { color: "gray", dim: true });
	setCell(canvas, x + width - 1, y + height - 1, "╯", { color: "gray", dim: true });

	for (let currentX = x + 1; currentX < x + width - 1; currentX += 1) {
		setCell(canvas, currentX, y, "─", { color: "gray", dim: true });
		setCell(canvas, currentX, y + height - 1, "─", { color: "gray", dim: true });
	}
	for (let currentY = y + 1; currentY < y + height - 1; currentY += 1) {
		setCell(canvas, x, currentY, "│", { color: "gray", dim: true });
		setCell(canvas, x + width - 1, currentY, "│", { color: "gray", dim: true });
	}
}

function drawHorizontalRule(canvas: Canvas, x: number, y: number, width: number): void {
	setCell(canvas, x, y, "├", { color: "gray", dim: true });
	setCell(canvas, x + width - 1, y, "┤", { color: "gray", dim: true });
	for (let currentX = x + 1; currentX < x + width - 1; currentX += 1) {
		setCell(canvas, currentX, y, "─", { color: "gray", dim: true });
	}
}

function fillCardBackground(
	canvas: Canvas,
	x: number,
	y: number,
	width: number,
	height: number,
): void {
	for (let currentY = y; currentY < y + height; currentY += 1) {
		for (let currentX = x; currentX < x + width; currentX += 1) {
			setCell(canvas, currentX, currentY, " ", { backgroundColor: "black" });
		}
	}
}

function drawTextInCard(
	canvas: Canvas,
	x: number,
	y: number,
	width: number,
	value: string,
	style: CanvasStyle,
): void {
	const content = truncate(value, width - 2).padEnd(width - 2, " ");
	for (let i = 0; i < content.length; i += 1) {
		setCell(canvas, x + 1 + i, y, content[i] ?? " ", style);
	}
}

function setCell(canvas: Canvas, x: number, y: number, char: string, style?: CanvasStyle): void {
	if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
		return;
	}
	canvas.cells[y][x] = { char, style };
}

function canvasToLines(canvas: Canvas): CanvasLine[] {
	const lines: CanvasLine[] = [];
	for (let y = 0; y < canvas.height; y += 1) {
		const row = canvas.cells[y] ?? [];
		const lastContentIndex = findLastContentIndex(row);
		const segments: CanvasSegment[] = [];
		let currentStyleKey = "";
		let currentText = "";
		let currentStyle: CanvasStyle | undefined;

		for (let x = 0; x <= lastContentIndex; x += 1) {
			const cell = row[x] ?? { char: " " };
			const styleKey = styleToKey(cell.style);
			if (styleKey !== currentStyleKey && currentText.length > 0) {
				segments.push({
					id: `seg-${y}-${segments.length}`,
					text: currentText,
					style: currentStyle,
				});
				currentText = "";
			}
			currentStyleKey = styleKey;
			currentStyle = cell.style;
			currentText += cell.char;
		}

		if (currentText.length > 0) {
			segments.push({
				id: `seg-${y}-${segments.length}`,
				text: currentText,
				style: currentStyle,
			});
		}

		lines.push({ id: `line-${y}`, segments });
	}
	return lines;
}

function findLastContentIndex(row: Canvas["cells"][number]): number {
	for (let i = row.length - 1; i >= 0; i -= 1) {
		const cell = row[i];
		if ((cell?.char ?? " ") !== " ") {
			return i;
		}
		if (cell?.style?.backgroundColor || cell?.style?.color || cell?.style?.bold || cell?.style?.dim) {
			return i;
		}
	}
	return 0;
}

function styleToKey(style?: CanvasStyle): string {
	if (!style) {
		return "none";
	}
	return [style.color ?? "", style.dim ? "1" : "0", style.backgroundColor ?? "", style.bold ? "1" : "0"].join("|");
}

function padWithRightLabel(left: string, right: string, width: number): string {
	if (right.length >= width) {
		return right.slice(0, width);
	}
	const availableLeft = Math.max(0, width - right.length - 1);
	const leftValue = truncate(left, availableLeft).padEnd(availableLeft, " ");
	return `${leftValue} ${right}`;
}

function truncate(value: string, maxLength: number): string {
	if (maxLength <= 0) {
		return "";
	}
	if (value.length <= maxLength) {
		return value;
	}
	if (maxLength < 2) {
		return value.slice(0, maxLength);
	}
	return `${value.slice(0, maxLength - 1)}…`;
}
