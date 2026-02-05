import type { EngineAdapter } from "../core/engine.js";
import { ActAdapter } from "./act/act-adapter.js";

type EngineAdapterConstructor = new () => EngineAdapter;

const ENGINE_REGISTRY: Record<string, EngineAdapterConstructor> = {
	act: ActAdapter,
};

export function createEngineAdapter(engineId: string): EngineAdapter {
	const normalized = engineId.trim().toLowerCase();
	const ctor = ENGINE_REGISTRY[normalized];
	if (!ctor) {
		throw new Error(
			`Unsupported engine "${engineId}". Available engines: ${Object.keys(ENGINE_REGISTRY).join(", ")}`,
		);
	}
	return new ctor();
}

export function listRegisteredEngines(): string[] {
	return Object.keys(ENGINE_REGISTRY);
}
