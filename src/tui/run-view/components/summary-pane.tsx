import { Box, Text } from "ink";
import type { SummaryGraph } from "../model/summary-graph.js";
import type { DiagramLine } from "../render/diagram.js";
import { SummaryGraphView } from "./summary-graph-view.js";

export type SummaryPaneProps = {
	shouldUseFallback: boolean;
	diagramLines: DiagramLine[];
	summaryGraph: SummaryGraph;
	spinnerIndex: number;
};

export function SummaryPane({
	shouldUseFallback,
	diagramLines,
	summaryGraph,
	spinnerIndex,
}: SummaryPaneProps): JSX.Element {
	if (!shouldUseFallback) {
		return <SummaryGraphView graph={summaryGraph} spinnerIndex={spinnerIndex} />;
	}

	return (
		<Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
			<Text dimColor>Summary</Text>
			{diagramLines.map((line) => (
				<Text key={line.id}>
					{line.segments.map((segment) => (
						<Text key={segment.id} color={segment.color} dimColor={segment.dim}>
							{segment.text}
						</Text>
					))}
				</Text>
			))}
		</Box>
	);
}
