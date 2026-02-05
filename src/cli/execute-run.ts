import fs from "node:fs";
import React from "react";
import { outro } from "@clack/prompts";
import { render } from "ink";
import type { EngineAdapter, EngineContext, EngineRunResult } from "../core/engine.js";
import type { RunPlan, Workflow } from "../core/types.js";
import { RunView } from "../tui/run-view.js";

export type ExecuteRunInput = {
	adapter: EngineAdapter;
	plan: RunPlan;
	context: EngineContext;
	workflow: Workflow;
	runStoreBase: string;
	isTty: boolean;
	json: boolean;
};

export async function executeRun({
	adapter,
	plan,
	context,
	workflow,
	runStoreBase,
	isTty,
	json,
}: ExecuteRunInput): Promise<EngineRunResult> {
	let result: EngineRunResult;
	if (isTty && !json) {
		result = await runWithInk(adapter, plan, context, workflow, runStoreBase);
		if (result.logsPath && fs.existsSync(result.logsPath)) {
			outro(`Logs: ${result.logsPath}`);
		} else {
			outro("Run files were cleaned up.");
		}
		return result;
	}

	if (!json) {
		process.stdout.write(`Running ${plan.jobs.length} job(s) with ${adapter.id}...\\n`);
	}
	result = await adapter.run(plan, context);
	if (!json) {
		process.stdout.write(`Finished with exit code ${result.exitCode}\\n`);
		process.stdout.write(`Logs: ${result.logsPath}\\n`);
	}
	return result;
}

async function runWithInk(
	adapter: EngineAdapter,
	plan: RunPlan,
	context: EngineContext,
	workflow: Workflow,
	runStoreBase: string,
): Promise<EngineRunResult> {
	return new Promise((resolve) => {
		let resolved = false;
		let finalResult: EngineRunResult | null = null;
		const handleComplete = (result: EngineRunResult): void => {
			if (resolved) {
				return;
			}
			finalResult = result;
		};

		const { waitUntilExit, unmount } = render(
			React.createElement(RunView, {
				adapter,
				context,
				plan,
				workflow,
				runStoreBase,
				onComplete: handleComplete,
			}),
		);

		waitUntilExit().then(() => {
			unmount();
			if (resolved) {
				return;
			}
			resolved = true;
			resolve(finalResult ?? { exitCode: 1, logsPath: "" });
		});
	});
}
