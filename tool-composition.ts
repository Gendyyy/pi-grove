import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripReasoning, stripTaskIntent, stripTaskProgress } from "./render.js";
import type { GroveMode } from "./settings.js";

/** Heterogeneous native/FFF schemas share Pi's actual tool contract. */
export type SourceToolDefinition = ToolDefinition<any, any>;

export interface SourceToolCompositionOptions {
	mode: GroveMode;
	reasoningGuideline: string;
	taskIntent?: boolean;
	taskIntentGuideline?: string;
	taskProgress?: boolean;
	taskProgressGuideline?: string;
}

export type ComposedSourceTool<T extends SourceToolDefinition> = Omit<T, "execute" | "parameters"> &
	Pick<SourceToolDefinition, "execute" | "parameters" | "promptGuidelines">;

/** Clone a JSON-schema params object and inject a required, first reasoning prop. */
export function withReasoning(parameters: SourceToolDefinition["parameters"]): SourceToolDefinition["parameters"] {
	const reasoning = {
		type: "string",
		description:
			"Short phrase (≤12 English words) stating the GOAL behind this call — the why-in-context, not the what. Do NOT restate the file, path, or command (those are already shown next to it); instead give the intent or what you expect to find/confirm. Present-tense, no period. E.g. \"confirm executionStarted is boolean\", \"fix the map leak from review\", \"retry match after previous miss\". Write the reasoning in English.",
	};
	const properties = { reasoning, ...(parameters?.properties ?? {}) };
	const required = Array.from(new Set(["reasoning", ...(parameters?.required ?? [])]));
	return { ...parameters, properties, required };
}

/** Clone a JSON-schema params object and inject a required task-cluster title. */
export function withTaskIntent(parameters: SourceToolDefinition["parameters"]): SourceToolDefinition["parameters"] {
	const taskIntent = {
		type: "string",
		maxLength: 120,
		description:
			"Concise high-level objective (≤10 English words) for this atomic task cluster. Keep it unchanged across calls advancing the same task; change it only when starting a distinct task. Describe the task, not a tool, action, output, phase, or per-call reasoning. This becomes Grove’s border title.",
	};
	const properties = { taskIntent, ...(parameters?.properties ?? {}) };
	const required = Array.from(new Set(["taskIntent", ...(parameters?.required ?? [])]));
	return { ...parameters, properties, required };
}

/** Clone a JSON-schema params object and inject a required task completion estimate. */
export function withTaskProgress(parameters: SourceToolDefinition["parameters"]): SourceToolDefinition["parameters"] {
	const taskProgress = {
		type: "integer",
		minimum: 0,
		maximum: 100,
		description:
			"Your best-judgment estimate of how much of the requested task is complete and how much remains (0–100); do not base it on tool-call count or invent a fixed denominator. Repeat the value on ordinary top-level calls and update it at meaningful milestones; it may decrease if scope grows. The final tool call intended to complete and verify the task must pass 100; Grove shows 100 only after that call succeeds.",
	};
	const properties = { taskProgress, ...(parameters?.properties ?? {}) };
	const required = Array.from(new Set(["taskProgress", ...(parameters?.required ?? [])]));
	return { ...parameters, properties, required };
}

/** Preserve source behavior and metadata; presentation is registered separately. */
export function composeSourceTool<T extends SourceToolDefinition>(
	source: T,
	options: SourceToolCompositionOptions,
): ComposedSourceTool<T> {
	const injectReasoning = options.mode !== "result";
	const injectTaskIntent = options.taskIntent === true;
	const injectTaskProgress = options.taskProgress === true;
	const properties = source.parameters.properties ?? {};
	if (injectReasoning && Object.hasOwn(properties, "reasoning")) {
		throw new Error(`${source.name} source schema reserves grove-owned reasoning`);
	}
	if (injectTaskIntent && Object.hasOwn(properties, "taskIntent")) {
		throw new Error(`${source.name} source schema reserves grove-owned taskIntent`);
	}
	if (injectTaskProgress && Object.hasOwn(properties, "taskProgress")) {
		throw new Error(`${source.name} source schema reserves grove-owned taskProgress`);
	}
	let parameters = source.parameters;
	if (injectReasoning) parameters = withReasoning(parameters);
	if (injectTaskIntent) parameters = withTaskIntent(parameters);
	if (injectTaskProgress) parameters = withTaskProgress(parameters);
	const composed: ComposedSourceTool<T> = {
		...source,
		parameters,
		execute(id, params, signal, onUpdate, context) {
			let sourceParams = params;
			if (injectTaskProgress) sourceParams = stripTaskProgress(sourceParams as Record<string, unknown>).rest;
			if (injectTaskIntent) sourceParams = stripTaskIntent(sourceParams as Record<string, unknown>).rest;
			if (injectReasoning) sourceParams = stripReasoning(sourceParams as Record<string, unknown>).rest;
			return source.execute.call(source, id, sourceParams, signal, onUpdate, context);
		},
	};
	const guidelines = [...(source.promptGuidelines ?? [])];
	if (injectReasoning) guidelines.push(options.reasoningGuideline);
	if (injectTaskIntent && options.taskIntentGuideline) guidelines.push(options.taskIntentGuideline);
	if (injectTaskProgress && options.taskProgressGuideline) guidelines.push(options.taskProgressGuideline);
	if (guidelines.length > 0) composed.promptGuidelines = guidelines;
	return composed;
}
