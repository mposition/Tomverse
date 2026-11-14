import { z } from "zod";
import { DAILY_HALT_REASONS } from "../tools/auto-rec-agent/lib/contract.mjs";

export const DAILY_PRODUCT_AGENT_ALERT_SWITCH = "DAILY_PRODUCT_AGENT_ALERTS_ENABLED";
export const DAILY_PRODUCT_AGENT_NOTICE_TARGET = "DailyProductAgentRun";
export const dailyProductHaltSchema = z.object({
  runId: z.string().uuid(),
  reason: z.string().refine((value) => DAILY_HALT_REASONS.includes(value)),
  attempted: z.number().int().min(0).max(24),
  prOpened: z.number().int().min(0).max(24),
  lastPrUrl: z.string().regex(/^https:\/\/github\.com\/mposition\/Tomverse\/pull\/[1-9][0-9]{0,8}$/).nullable(),
}).strict().refine((value) => value.prOpened <= value.attempted);
export type DailyProductHalt = z.infer<typeof dailyProductHaltSchema>;

export const dailyProductHaltNotice = (input: DailyProductHalt) => ({
  title: "Daily product agent stopped",
  detail: [
    `Reason: ${input.reason}. Attempts: ${input.attempted}; PRs opened: ${input.prOpened}.`,
    input.lastPrUrl ? `Last confirmed PR: ${input.lastPrUrl}` : "No PR was confirmed in this run.",
    ["publish_unknown", "result_unknown", "review_unknown"].includes(input.reason)
      ? "Look up the existing PR or review before restarting; do not resubmit an unknown outcome."
      : "Inspect the service failure before restarting. The daily task cap still applies.",
    "Open /admin/product-research?tab=suggestions and /admin/routing?tab=optimizer for task state.",
  ].join("\n"),
});
