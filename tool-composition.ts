import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	generateDiffString,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { LiuovoMode } from "./config.js";

/** Heterogeneous native/FFF schemas share Pi's actual tool contract. */
export type SourceToolDefinition = ToolDefinition<any, any>;

export interface SourceToolCompositionOptions {
	mode: LiuovoMode;
	reasoningGuideline: string;
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

/** Remove only liuovo's injected field, retaining all other argument identities. */
export function stripReasoning(params: Record<string, unknown>): { reasoning?: string; rest: Record<string, unknown> } {
	const { reasoning, ...rest } = params;
	if (!Object.hasOwn(params, "reasoning")) return { rest: params };
	return { reasoning: typeof reasoning === "string" ? reasoning : undefined, rest };
}

/** Preserve source behavior and metadata; presentation is registered separately. */
export function composeSourceTool<T extends SourceToolDefinition>(
	source: T,
	options: SourceToolCompositionOptions,
): ComposedSourceTool<T> {
	const injectReasoning = options.mode !== "result";
	if (injectReasoning && Object.hasOwn(source.parameters.properties ?? {}, "reasoning")) {
		throw new Error(`${source.name} source schema reserves liuovo-owned reasoning`);
	}
	const composed: ComposedSourceTool<T> = {
		...source,
		parameters: injectReasoning ? withReasoning(source.parameters) : source.parameters,
		execute(id, params, signal, onUpdate, context) {
			const sourceParams = injectReasoning ? stripReasoning(params as Record<string, unknown>).rest : params;
			return source.execute.call(source, id, sourceParams, signal, onUpdate, context);
		},
	};
	if (injectReasoning) composed.promptGuidelines = [...(source.promptGuidelines ?? []), options.reasoningGuideline];
	return composed;
}

const nativeFactories = {
	read: createReadToolDefinition,
	write: createWriteToolDefinition,
	edit: createEditToolDefinition,
	bash: createBashToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};
export type NativeToolName = keyof typeof nativeFactories;

export function createNativeSource(name: NativeToolName, cwd: string): SourceToolDefinition {
	return nativeFactories[name](cwd);
}

/** Native write's mutation queue encloses the before/after capture as well as the write. */
export function createDiffingWriteTool(cwd: string): SourceToolDefinition {
	const source = createWriteToolDefinition(cwd);
	const composed = {
		...source,
		async execute(...[id, params, signal, onUpdate, context]: Parameters<typeof source.execute>) {
			let diff = "";
			const tool = createWriteToolDefinition(cwd, {
				operations: {
					mkdir: async (directory) => { await mkdir(directory, { recursive: true }); },
					writeFile: async (path, content) => {
						let previous = "";
						try {
							previous = await readFile(path, "utf8");
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
						if (signal?.aborted) throw new Error("Operation aborted");
						await writeFile(path, content, "utf8");
						diff = generateDiffString(previous, content).diff;
					},
				},
			});
			const result = await tool.execute(id, params, signal, onUpdate, context);
			return { ...result, details: { diff } };
		},
	};
	return composed as SourceToolDefinition;
}
