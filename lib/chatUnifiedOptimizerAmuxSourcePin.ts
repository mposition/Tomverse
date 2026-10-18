import { z } from "zod";

export const CHAT_UNIFIED_OPTIMIZER_AMUX_SOURCE_PIN_ENV =
  "TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_PUBLIC_PIN" as const;

const pinSchema = z.object({
  repositoryId: z.number().int().positive().safe(),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  blobSha: z.string().regex(/^[0-9a-f]{40}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

/** Operator-pinned, public-only fixture source. A missing or malformed pin
 * closes candidate intake; neither a worker nor a model chooses its commit. */
export function readChatUnifiedOptimizerAmuxSourcePin(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const raw = env[CHAT_UNIFIED_OPTIMIZER_AMUX_SOURCE_PIN_ENV];
  if (!raw || Buffer.byteLength(raw, "utf8") > 2_048)
    throw new Error("optimizer_amux_source_pin_unavailable");
  try { return Object.freeze(pinSchema.parse(JSON.parse(raw))); }
  catch { throw new Error("optimizer_amux_source_pin_unavailable"); }
}
