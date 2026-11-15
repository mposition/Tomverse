import { createHash } from "node:crypto";
import { z } from "zod";

import { encodeV22PatchEvidence, v22PublishFilesSha256 } from
  "@/lib/amux/v22PatchEvidence";
import { AMUX_V22_PATCH_MAX_BYTES } from "@/lib/amux/v22PatchLimit";

const patchSchema = z.object({
  // UTF-16 length bounds UTF-8 bytes from below; the evidence encoder checks
  // the bytes against the same bound.
  text: z.string().min(1).max(AMUX_V22_PATCH_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  filesDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  // A sidecar before 2026-11-15 sends file bytes beside the text; the
  // candidate rebuilds from the text alone, and the evidence encoder bounds
  // them with the text.
  files: z.array(z.object({
    path: z.string().min(1).max(4096),
    mode: z.literal("100644"),
    bytesBase64: z.string().min(4).max(Math.ceil(AMUX_V22_PATCH_MAX_BYTES / 3) * 4),
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
