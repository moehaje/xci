import { describe, expect, it } from "vitest";
import { expandJobIdsWithNeeds, filterJobsForEvent, sortJobsByNeeds } from "../src/core/plan.js";
import type { Workflow } from "../src/core/types.js";

const workflow: Workflow = {
	id: "wf-1",
	name: "CI",
	path: ".github/workflows/ci.yml",
	events: ["push", "pull_request"],
	jobs: [
		{ id: "build", name: "Build", needs: [], steps: [] },
		{ id: "test", name: "Test", needs: ["build"], steps: [] },
		{ id: "deploy", name: "Deploy", needs: ["test"], steps: [] },
		{
			id: "pr-only",
			name: "PR only",
			needs: [],
			steps: [],
			if: "github.event_name == 'pull_request'",
		},
	],
};

describe("core plan", () => {
	it("expands selected jobs with transitive needs", () => {
		expect(expandJobIdsWithNeeds(workflow, ["deploy"])).toEqual(["build", "test", "deploy"]);
	});

	it("sorts selected jobs topologically by needs", () => {
		expect(sortJobsByNeeds(workflow, ["deploy", "build", "test"])).toEqual([
			"build",
			"test",
			"deploy",
		]);
	});

	it("keeps deterministic fallback order when cycle exists", () => {
		const cyclical: Workflow = {
			...workflow,
			jobs: [
				{ id: "a", name: "A", needs: ["b"], steps: [] },
				{ id: "b", name: "B", needs: ["a"], steps: [] },
				{ id: "c", name: "C", needs: [], steps: [] },
			],
		};

		expect(sortJobsByNeeds(cyclical, ["a", "b", "c"])).toEqual(["c", "a", "b"]);
	});

	it("filters pull_request-only jobs outside pull_request events", () => {
		const pushJobs = filterJobsForEvent(workflow.jobs, "push").map((job) => job.id);
		expect(pushJobs).toEqual(["build", "test", "deploy"]);

		const prJobs = filterJobsForEvent(workflow.jobs, "pull_request").map((job) => job.id);
		expect(prJobs).toEqual(["build", "test", "deploy", "pr-only"]);
	});
});
