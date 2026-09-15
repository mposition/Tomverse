import { TOKEN_VERIFICATION_STATUS } from "@/lib/errorReportContract";
import { FEEDBACK_LIFECYCLE_STAGE } from "@/lib/feedbackLifecycleCore";

/**
 * Which reports go straight to "reviewing" when they arrive.
 *
 * Only a report whose error-report token verified: the server generated that
 * trace itself and classified the failure, so there is a recorded server error
 * to look at (docs/policy/trace-feedback-automation.md §2, §3.2). A trace ID
 * the reporter typed, a forged or expired token, or a client-classified
 * EMPTY_RESPONSE never qualifies -- a trace string is not an authentication
 * factor, and treating one as proof would let any client move its own report
 * up the queue.
 *
 * Deliberately independent of the report type and of the Phase 2 shadow flag:
 * the question is "is there a server-verified failure behind this report",
 * which a feature request carrying a verified token also answers yes to.
 *
 * Pure and client-safe, so the inbox and the operator email can say why a
 * report arrived already in review using the same rule the route applied.
 */
export const qualifiesForTraceAutoReview = (input: {
  verification: string | null | undefined;
  traceId: string | null | undefined;
}) =>
  input.verification === TOKEN_VERIFICATION_STATUS.verified &&
  typeof input.traceId === "string" &&
  input.traceId.length > 0;

/** The status a new report is stored with. */
export const initialFeedbackStatus = (input: {
  verification: string | null | undefined;
  traceId: string | null | undefined;
}) => (qualifiesForTraceAutoReview(input) ? "reviewing" : "open");

/**
 * The lifecycle events a new report is stored with, in order.
 *
 * An auto-reviewed report records both stages, so the admin's later "move to
 * reviewing" is recognised as already announced instead of creating a second
 * reviewing event. The reviewing event carries no actor: no person made that
 * transition, and the audit trail must not suggest one did.
 */
export const initialFeedbackLifecycleEvents = (input: {
  verification: string | null | undefined;
  traceId: string | null | undefined;
}) => {
  const autoReview = qualifiesForTraceAutoReview(input);
  return autoReview
    ? [
        {
          stage: FEEDBACK_LIFECYCLE_STAGE.received,
          previousStatus: null,
          newStatus: "open",
        },
        {
          stage: FEEDBACK_LIFECYCLE_STAGE.reviewing,
          previousStatus: "open",
          newStatus: "reviewing",
        },
      ]
    : [
        {
          stage: FEEDBACK_LIFECYCLE_STAGE.received,
          previousStatus: null,
          newStatus: "open",
        },
      ];
};
