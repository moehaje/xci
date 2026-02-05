import assert from "node:assert/strict";
import test from "node:test";
import type { RunStatus, Step } from "../src/core/types.js";
import {
	createStepChunkParser,
	mergeStepOutputs,
	mergeStepStatuses,
	parseStepChunk,
} from "../src/tui/run-view/utils/parser.js";

const steps: Step[] = [
	{ id: "job-step-1", name: "Install deps" },
	{ id: "job-step-2", name: "Run tests" },
];

test("step parser parses chunked live output incrementally", () => {
	const parser = createStepChunkParser(steps);
	const statuses: Record<string, RunStatus> = {};
	let outputs: Record<string, string[]> = {};

	const chunk1 = "[job] ⭐ Run Install deps\n";
	const first = parseStepChunk(parser, chunk1);
	Object.assign(statuses, mergeStepStatuses(statuses, first.statuses));
	outputs = mergeStepOutputs(outputs, first.outputs);
	assert.equal(statuses["job-step-1"], "running");
	assert.deepEqual(outputs["job-step-1"] ?? [], []);

	const chunk2 = "npm ci\n✅ Success - Install deps\n";
	const second = parseStepChunk(parser, chunk2);
	Object.assign(statuses, mergeStepStatuses(statuses, second.statuses));
	outputs = mergeStepOutputs(outputs, second.outputs);
	assert.equal(statuses["job-step-1"], "success");
	assert.deepEqual(outputs["job-step-1"], ["npm ci"]);

	const chunk3 = "⭐ Run Run tests\nnode --test\n";
	const third = parseStepChunk(parser, chunk3);
	Object.assign(statuses, mergeStepStatuses(statuses, third.statuses));
	outputs = mergeStepOutputs(outputs, third.outputs);
	assert.equal(statuses["job-step-2"], "running");
	assert.deepEqual(outputs["job-step-2"], ["node --test"]);
});
