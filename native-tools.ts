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
import type { SourceToolDefinition } from "./tool-composition.js";

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
          mkdir: async directory => { await mkdir(directory, { recursive: true }); },
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
