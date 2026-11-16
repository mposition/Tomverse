import { z } from "zod";

export const CONNECTED_JOURNEY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const connectedJourneyFields = {
  journey_key: z.string().uuid(),
  journey_kind: z.enum(["review_chat", "import_continuation"]),
  journey_entry: z.enum(["review_studio", "review_classic", "review_quick_summary", "import_complete", "import_viewer"]),
  continuation_kind: z.enum(["new", "existing"]).optional(),
  journey_stage: z.enum(["started", "preview_ready", "ready", "send_dispatched", "reply_observed", "cancelled", "invalidated", "issue"]),
  journey_reason: z.enum(["user_cancelled", "superseded", "draft_cleared", "draft_replaced", "scope_changed", "source_changed", "expired", "source_unavailable", "navigation_blocked", "create_failed", "draft_conflict", "response_error", "response_cancelled", "response_incomplete", "empty_response", "response_timeout"]).optional(),
};
export const CONNECTED_JOURNEY_FIELDS = Object.keys(connectedJourneyFields);
export const connectedJourneyPropertiesSchema = z.object(connectedJourneyFields).strict().superRefine((p, ctx) => {
  const review = p.journey_kind === "review_chat";
  const diagnostic = ["cancelled", "invalidated", "issue"].includes(p.journey_stage);
  const invalidReasons = ["superseded", "draft_cleared", "draft_replaced", "scope_changed", "source_changed", "expired"];
  if (review !== p.journey_entry.startsWith("review_") ||
    (review ? p.continuation_kind !== undefined : p.continuation_kind === undefined) ||
    (!review && p.journey_stage === "preview_ready") ||
    (p.journey_entry === "import_viewer" && p.continuation_kind !== "new") ||
    diagnostic !== (p.journey_reason !== undefined) ||
    (p.journey_stage === "cancelled" && p.journey_reason !== "user_cancelled") ||
    (p.journey_stage === "invalidated" && !invalidReasons.includes(p.journey_reason!)) ||
    (p.journey_stage === "issue" && (p.journey_reason === "user_cancelled" || invalidReasons.includes(p.journey_reason!)))) {
    ctx.addIssue({ code: "custom", message: "Invalid connected journey combination." });
  }
});
export type ConnectedJourneyProperties = z.infer<typeof connectedJourneyPropertiesSchema>;
export type JourneyEntry = ConnectedJourneyProperties["journey_entry"];
export type JourneyStage = ConnectedJourneyProperties["journey_stage"];
export type JourneyReason = NonNullable<ConnectedJourneyProperties["journey_reason"]>;

/** Pseudonymous event identity, never an authorization credential. */
export const connectedJourneyDedupeKey = (actor: string, p: ConnectedJourneyProperties) =>
  JSON.stringify(["connected_journey", actor, p.journey_kind, p.journey_key, p.journey_stage]);
