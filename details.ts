/**
 * details.ts — reads the payloads grove writes into tool results, including the names
 * earlier versions used, so old transcripts still replay their nested steps.
 */

/** The detail keys grove writes today. */
export type GroveDetailKey = "piGroveNested" | "piGroveShell";

/** What each key was called before the extension was renamed. */
const LEGACY_KEYS: Record<GroveDetailKey, string> = {
  piGroveNested: "piLiuovoNested",
  piGroveShell: "piLiuovoShell",
};

/** Read one detail payload, preferring the current key and falling back to the old one. */
export function readDetail<T>(details: unknown, key: GroveDetailKey): T | undefined {
  const record = details as Record<string, unknown> | undefined;
  if (!record || typeof record !== "object") return undefined;
  const value = record[key] ?? record[LEGACY_KEYS[key]];
  return value === undefined || value === null ? undefined : (value as T);
}
