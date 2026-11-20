import { createHash } from "node:crypto";
import { z } from "zod";

import { encodeV22PatchEvidence, v22PublishFilesSha256 } from
  "@/lib/amux/v22PatchEvidence";
import { AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES } from "@/lib/amux/v22PatchLimit";

const patchSchema = z.object({
  // No size bound of ours on the text (owner decision 2026-11-18,
  // docs/policy/amux-v22-result-transfer.md); the request carrying it is.
  text: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  filesDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  // A sidecar before 2026-11-15 sends file bytes beside the text; the
  // candidate rebuilds from the text alone. That JSON evidence keeps the old
  // inline bound, which the evidence encoder checks with the text.
  files: z.array(z.object({
    path: z.string().min(1).max(4096),
    mode: z.literal("100644"),
    bytesBase64: z.string().min(4).max(
      Math.ceil(AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES / 3) * 4),
  }).strict()).min(1).optional(),
}).strict();

export type V22OptionalPatch = z.infer<typeof patchSchema>;

/** Optional publication evidence may be dropped, never the private Task result. */
export function normalizeV22OptionalPatch(value: unknown): {
  patch: V22OptionalPatch | undefined; patchRejected: boolean;
} {
  if (value === undefined) return { patch: undefined, patchRejected: false };
  const candidate = patchSchema.safeParse(value);
  if (candidate.success) {
    try {
      if (createHash("sha256").update(candidate.data.text).digest("hex") ===
            candidate.data.sha256 &&
          candidate.data.filesDigest === (candidate.data.files ?
            v22PublishFilesSha256(candidate.data.files) : undefined)) {
        const evidence = encodeV22PatchEvidence(candidate.data.text,
          candidate.data.files);
        evidence.fill(0);
        return { patch: candidate.data, patchRejected: false };
      }
    } catch { /* Unsafe publication evidence leaves the result private. */ }
  }
  return { patch: undefined, patchRejected: true };
}
