import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "typebox";

const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL = "google/gemini-2.5-flash-image";
const EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};
type ImagesResult = Awaited<ReturnType<ExtensionContext["modelRegistry"]["generateImages"]>>;
type SavedImage = { path: string; mimeType: string };
type ImageOutput = {
  provider: string;
  model: string;
  images: SavedImage[];
  error?: { code: string; message: string };
};
const parameters = Type.Object({
  prompt: Type.String({ description: "Describe the image to generate. Sizing hints in the prompt are not guaranteed dimensions." }),
  provider: Type.Optional(Type.String({ description: "Pi image model provider, e.g. openrouter" })),
  model: Type.Optional(Type.String({ description: "Image model ID within that provider" })),
});
export interface GenerateImageDeps {
  providerId?: string;
  modelId?: string;
  outputRoot?: string;
}

function outputRoot(cwd: string, override?: string): string {
  if (override) return resolve(cwd, override);
  return resolve(process.env.PI_GROVE_FLEET_DIR ?? cwd, ".fleet", "images", process.env.PI_GROVE_BOTS_NAME ?? "pi");
}
function imageBytes(data: string, mimeType: string): Buffer {
  if (!EXTENSIONS[mimeType]) throw new Error(`Unsupported generated image MIME type: ${mimeType}`);
  if (!data || data.length > 90_000_000 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error("The image model returned invalid or oversized base64 image data");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new Error("The image model returned invalid base64 image data");
  return bytes;
}

/** Thin file-output adapter. Catalog, authentication and generation belong to Pi. */
export function buildGenerateImageTool(deps: GenerateImageDeps = {}) {
  return {
    name: "generate_image",
    label: "generate_image",
    description: "Generate images using Pi's image models and session credentials, then save them under .fleet/images/. Returns local paths, never base64. Defaults to OpenRouter google/gemini-2.5-flash-image; override provider/model or PI_GROVE_IMAGE_PROVIDER / PI_GROVE_IMAGE_MODEL. Discover models via codemode models.getAvailableOfType(\"image\"). For image references/editing use native models.generateImages().",
    promptSnippet: "generate_image creates image files from a prompt using Pi's image models and returns their paths.",
    parameters,
    outputSchema: Type.Object({
      provider: Type.String(), model: Type.String(),
      images: Type.Array(Type.Object({ path: Type.String(), mimeType: Type.String() })),
      error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const provider = params.provider ?? deps.providerId ?? process.env.PI_GROVE_IMAGE_PROVIDER ?? DEFAULT_PROVIDER;
      const modelId = params.model ?? deps.modelId ?? process.env.PI_GROVE_IMAGE_MODEL ?? DEFAULT_MODEL;
      let usage: ImagesResult["usage"];
      const written: SavedImage[] = [];
      const result = (error?: ImageOutput["error"]) => {
        const output: ImageOutput = { provider, model: modelId, images: [...written], ...(error ? { error } : {}) };
        return {
          content: [{ type: "text" as const, text: error ? `${error.message} [reason: ${error.code}]` : written.map(file => file.path).join("\n") }],
          details: output, structuredContent: output,
          ...(error ? { isError: true } : {}), ...(usage ? { usage } : {}),
        };
      };
      if (!params.prompt.trim()) return result({ code: "invalid_prompt", message: "Provide a non-empty image prompt." });
      if (signal?.aborted) return result({ code: "aborted", message: "Image generation cancelled." });
      try {
        const model = ctx.modelRegistry.getModelOfType("image", provider, modelId);
        if (!model) return result({ code: "unknown_model", message: `Unknown image model ${provider}/${modelId}. List models with models.getAvailableOfType("image") in codemode and pass provider/model separately.` });
        const generated = await ctx.modelRegistry.generateImages(model, {
          input: [{ type: "text", text: params.prompt }],
        }, { signal });
        usage = generated.usage;
        if (generated.stopReason !== "stop") return result({
          code: generated.stopReason === "aborted" ? "aborted" : "provider_failure",
          message: generated.errorMessage || (generated.stopReason === "aborted" ? "Image generation cancelled." : "Image generation failed. Check this provider's /login credentials."),
        });
        signal?.throwIfAborted();
        const images = generated.output.filter(block => block.type === "image");
        if (!images.length) return result({ code: "no_images", message: "The model returned no images. Try a different image model or prompt." });
        // Validate every block before creating any files; never persist base64 in
        // tool details or structured output. Usage survives provider/disk errors.
        const files = images.map(image => ({ bytes: imageBytes(image.data, image.mimeType), mimeType: image.mimeType }));
        const root = outputRoot(ctx.cwd, deps.outputRoot);
        await mkdir(root, { recursive: true });
        for (const file of files) {
          signal?.throwIfAborted();
          const path = join(root, `${randomUUID()}.${EXTENSIONS[file.mimeType]}`);
          const handle = await open(path, "wx", 0o600);
          // Own the file before tracking it: even a name collision must never
          // let error cleanup delete a pre-existing user's image.
          written.push({ path, mimeType: file.mimeType });
          try { await handle.writeFile(file.bytes, { signal }); }
          finally { await handle.close(); }
        }
        signal?.throwIfAborted();
        return result();
      } catch (error) {
        const cleanup = await Promise.allSettled(written.map(file => unlink(file.path)));
        const leftovers = written.filter((_file, index) => cleanup[index].status === "rejected");
        written.splice(0, written.length, ...leftovers);
        return result({ code: signal?.aborted ? "aborted" : "generation_failed",
          message: signal?.aborted ? "Image generation cancelled." : error instanceof Error ? error.message : "Image generation failed." });
      }
    },
  } satisfies ToolDefinition<typeof parameters, ImageOutput>;
}
