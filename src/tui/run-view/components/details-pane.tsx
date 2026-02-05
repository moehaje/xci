import { Box, Text } from "ink";
import type { Job, RunStatus } from "../../../core/types.js";
import { formatDuration } from "../utils/format.js";
import { colorForStatus, renderStatusGlyph, STATUS_LABELS } from "../utils/status.js";

export type DetailsPaneFocus = "jobs" | "steps";

export type OrderedJob = {
	jobId: string;
	status: RunStatus;
	durationMs?: number;
};

export type DetailsPaneProps = {
	focusedPane: DetailsPaneFocus;
	orderedJobs: OrderedJob[];
	selectedJobIndex: number;
	selectedJob?: OrderedJob;
	selectedSteps: Job["steps"];
	selectedStepIndex: number;
	expandedSteps: Record<string, boolean>;
	stepStatuses: Record<string, RunStatus>;
	stepOutputs: Record<string, string[]>;
	maxDetailsLogLines: number;
	spinnerIndex: number;
};

const ROW_PADDING_X = 2;
const JOB_ROW_WIDTH = 30;
const STEP_ROW_WIDTH = 36;

export function DetailsPane({
	focusedPane,
	orderedJobs,
	selectedJobIndex,
	selectedJob,
	selectedSteps,
	selectedStepIndex,
	expandedSteps,
	stepStatuses,
	stepOutputs,
	maxDetailsLogLines,
	spinnerIndex,
}: DetailsPaneProps): JSX.Element {
	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<Box flexDirection="column" width={34}>
					<Text dimColor>Jobs {focusedPane === "jobs" ? "•" : ""}</Text>
					{orderedJobs.map((job, index) => {
						const isSelected = index === selectedJobIndex;
						const glyph = renderStatusGlyph(job.status, spinnerIndex);
						const rowText = formatRowText(`${glyph} ${job.jobId}`, JOB_ROW_WIDTH, ROW_PADDING_X);
						return (
							<Text
								key={job.jobId}
								color={colorForStatus(job.status)}
								backgroundColor={isSelected ? "gray" : undefined}
								bold={isSelected && focusedPane === "jobs"}
								dimColor={isSelected && focusedPane !== "jobs"}
							>
								{rowText}
							</Text>
						);
					})}
				</Box>
				<Box flexDirection="column">
					<Text dimColor>│</Text>
					{Array.from(
						{
							length: Math.max(
								orderedJobs.length,
								selectedSteps.length + (selectedSteps.length === 0 ? 4 : 3),
							),
						},
						(_, rowIndex) => `divider-${rowIndex + 1}`,
					).map((dividerKey) => (
						<Text key={dividerKey} dimColor>
							│
						</Text>
					))}
				</Box>
				<Box flexDirection="column" marginLeft={1} flexGrow={1}>
					<Text dimColor>Steps {focusedPane === "steps" ? "•" : ""}</Text>
					<Text>{selectedJob?.jobId ?? "No job selected"}</Text>
					{selectedJob ? (
						<Text dimColor>
							{STATUS_LABELS[selectedJob.status]}{" "}
							{selectedJob.durationMs ? `· ${formatDuration(selectedJob.durationMs)}` : ""}
						</Text>
					) : null}
					<Box flexDirection="column" marginTop={1}>
						{selectedSteps.length === 0 ? (
							<Text dimColor>No steps found.</Text>
						) : (
							selectedSteps.map((step, index) => {
								const isSelected = index === selectedStepIndex;
								const isExpanded = Boolean(expandedSteps[step.id]);
								const stepStatus = stepStatuses[step.id] ?? "pending";
								const stepOutput = stepOutputs[step.id] ?? [];
								const caret = isExpanded ? "▾" : "▸";
								const glyph = renderStatusGlyph(stepStatus, spinnerIndex);
								const rowText = formatRowText(
									`${glyph} ${caret} ${step.name}`,
									STEP_ROW_WIDTH,
									ROW_PADDING_X,
								);
								return (
									<Box flexDirection="column" key={step.id}>
										<Text
											color={colorForStatus(stepStatus)}
											backgroundColor={isSelected ? "gray" : undefined}
											bold={isSelected && focusedPane === "steps"}
											dimColor={isSelected && focusedPane !== "steps"}
										>
											{rowText}
										</Text>
										{isExpanded ? (
											<Box flexDirection="column" paddingLeft={2}>
												{stepOutput.length === 0 ? (
													<Text dimColor>Waiting for output...</Text>
												) : (
													<>
														{stepOutput.slice(-maxDetailsLogLines).map((line, lineIndex) => (
															<Text key={`${step.id}-${lineIndex}`} dimColor>
																{line}
															</Text>
														))}
														{stepOutput.length > maxDetailsLogLines ? (
															<Text dimColor>
																… {stepOutput.length - maxDetailsLogLines} more line(s)
															</Text>
														) : null}
													</>
												)}
											</Box>
										) : null}
									</Box>
								);
							})
						)}
					</Box>
				</Box>
			</Box>
		</Box>
	);
}

function formatRowText(value: string, width: number, paddingX: number): string {
	const innerWidth = Math.max(0, width - paddingX * 2);
	const clipped =
		value.length <= innerWidth
			? value
			: innerWidth > 1
				? `${value.slice(0, innerWidth - 1)}…`
				: value.slice(0, innerWidth);
	return `${" ".repeat(paddingX)}${clipped.padEnd(innerWidth, " ")}${" ".repeat(paddingX)}`;
}
