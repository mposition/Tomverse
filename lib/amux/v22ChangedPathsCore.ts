/**
 * The pure half of a v22 run's named changed-path list
 * (docs/policy/amux-v22-result-transfer.md 1.6 5): the request fields that
 * name a committed list, and what a settlement or review record body says
 * about its list before anything is read. No database or key store, so the
 * routes and the tests that replace the store read the one copy.
 */
import { z } from "zod";

import { AMUX_V22_EMPTY_SHA256 } from "./v22TransferCore.ts";

/** The settlement and v52 review record fields that name a committed list,
 * spread into their strict request schemas. */
export const amuxV22NamedChangedPathsSchema = {
  changed_paths_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  changed_paths_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
};

export type AmuxV22NamedChangedPathsBody = {
  changed_paths?: string[];
  changed_paths_digest?: string;
  changed_paths_count?: number;
};

/**
 * Nothing named (`absent`: the old body's `changed_paths` array, or none), a
 * list named by digest and count (`named`), or a body that names it wrongly
 * (`invalid`, a 400): both fields or neither, never beside the array, and the
 * empty digest only with no paths.
 */
export function classifyAmuxV22NamedChangedPaths(body: AmuxV22NamedChangedPathsBody):
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "named"; sha256: string; count: number } {
  const digest = body.changed_paths_digest;
  const count = body.changed_paths_count;
  if (digest === undefined && count === undefined) return { kind: "absent" };
  if (digest === undefined || count === undefined || body.changed_paths !== undefined ||
      (digest === AMUX_V22_EMPTY_SHA256) !== (count === 0)) return { kind: "invalid" };
  return { kind: "named", sha256: digest, count };
}
