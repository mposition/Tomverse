import { z } from "zod";

import type { QaReleaseCiAdviceRecord, QaReleaseCiAdviceSuggestion } from "@/lib/qaReleaseCiAdviceCore";

export const CI_ADVICE_ITEM_PREFIX = "qa_release.ci_advice.item.";
export const CI_ADVICE_ID = /^[0-9a-f]{64}$/;
export const ciAdviceItemSchema = z.object({
  id: z.string().regex(CI_ADVICE_ID),
  title: z.string().min(1).max(160), why: z.string().max(700), change: z.string().max(700),
  savesMinutes: z.number().min(0).max(1000).nullable(),
  createdAt: z.string().datetime(),
  status: z.enum(["open", "completed", "dismissed", "sending_to_amux", "sent"]),
  at: z.string().datetime().nullable(),
  amuxIdeaId: z.string().min(1).max(200).nullable(),
}).strict();
export type CiAdviceItem = z.infer<typeof ciAdviceItemSchema>;
export type CiAdviceConsole = Omit<QaReleaseCiAdviceRecord, "suggestions"> & { suggestions: CiAdviceItem[] };
export const ciAdviceIdentity = (suggestion: QaReleaseCiAdviceSuggestion) =>
  JSON.stringify([suggestion.title.trim(), suggestion.why.trim(), suggestion.change.trim()]);

export function parseCiAdviceItem(value: string): CiAdviceItem | null {
  try { return ciAdviceItemSchema.parse(JSON.parse(value)); } catch { return null; }
}

/** Copied locally and sent through AMUX intake without changing its contents. */
export const ciAdviceWorkBrief = (item: CiAdviceItem) => [
  "# CI improvement", "", item.title, "", "## Evidence", item.why, "", "## Requested change", item.change, "",
  `Tomverse Admin source: /admin/release?tab=qa#ci-advice-${item.id}`,
  "", "Done when: verify the current develop code, implement the smallest useful change, preserve security, billing and audit coverage, run relevant checks, and open an independent develop draft PR with ci:hold. Do not merge, deploy, release CI or mark this suggestion completed automatically.",
].join("\n");
