"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  LoaderCircle,
  Lock,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { useGuestVerification } from "@/components/chat/GuestVerificationProvider";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { SourceGroundingBadge } from "@/components/chat/SourceGroundingBadge";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import {
  toSourceGrounding,
  type SourceGroundingLevel,
} from "@/lib/sourceGrounding";

type ReviewMode = "balanced" | "evidence" | "action";

type ReviewSetup = {
  available: boolean;
  reason?: string;
  promptMessageId?: string;
  assistantMessageIds?: string[];
  responses?: Array<{
    messageId: string;
    modelId: string;
    modelName: string;
  }>;
  estimatedCredits?: number;
  dualReview?: boolean;
  reviewerClass?: string;
  freeMonthlyReviews?: number | null;
  disclaimer?: string;
  /** Guest-only fields, all server-computed. Never sent back on the run. */
  guest?: boolean;
  guestTrial?: { limit: number; used: number; remaining: number };
  creditsAvailable?: number;
  webVerificationAvailable?: boolean;
  persisted?: boolean;
};

/**
 * The locally-held turn a guest reviews.
 *
 * A guest has no server-side conversation, so the answers travel with the
 * request exactly as the guest quick summary's already do. This is the shape
 * the shell hands over -- the same `localComparison*` refs the quick summary
 * reads -- and it is the only thing about this dialog that differs between an
 * account and a guest.
 */
export type GuestReviewSource = {
  question: string;
  responses: Array<{ messageId: string; modelId: string; content: string }>;
  language: string;
};

type Citation = { responseId: "A" | "B" | "C"; quote: string; verified: boolean };
type GroundedClaim = { text: string; citations: Citation[]; verified: boolean };

type SingleReviewResult = {
  consensus: GroundedClaim[];
  differences: Array<{
    issue: string;
    positions: Array<{
      responseId: "A" | "B" | "C";
      position: string;
      quote: string;
      verified: boolean;
    }>;
  }>;
  contradictions: GroundedClaim[];
  missingPoints: string[];
  verificationNeeded: string[];
  modelAssessments: Array<{
    responseId: "A" | "B" | "C";
    strengths: string[];
    cautions: string[];
  }>;
  synthesis: string;
  confidence: "low" | "medium" | "high";
  limitations: string[];
  groundingStats: { totalCitations: number; verifiedCitations: number };
};

type ReviewAgreement = {
  confidenceMatches: boolean;
  primaryConfidence: "low" | "medium" | "high";
  secondaryConfidence: "low" | "medium" | "high";
  sharedVerifiedQuoteCount: number;
};

type ComparisonReview = {
  id: string;
  result: {
    primary: { reviewerModelId: string; result: SingleReviewResult };
    secondary: { reviewerModelId: string; result: SingleReviewResult } | null;
    agreement: ReviewAgreement | null;
  };
  responseMap: Array<{
    responseId: "A" | "B" | "C";
    messageId: string;
    modelId: string;
    modelName: string;
  }>;
  reviewerModelId: string;
  usageCredits: number;
  originalUsageCredits?: number;
  cached: boolean;
  disclaimer: string;
  /**
   * Per-claim identifiers for the feedback control, derived on the server
   * (lib/comparisonReviewItemFeedback.ts) and never recomputed here: the
   * derivation hashes, and a second implementation in the browser would be a
   * second place for the two to stop agreeing. Absent on a guest review,
   * which is not stored and therefore has nothing to attach a verdict to.
   */
  reviewItems?: Array<{
    id: string;
    reviewer: "primary" | "secondary";
    section: string;
    ordinal: number;
  }>;
  guest?: boolean;
  persisted?: boolean;
  webVerificationAvailable?: boolean;
};

const modeKeys: Array<{
  id: ReviewMode;
  label: string;
  description: string;
}> = [
  {
    id: "balanced",
    label: "chat.aiReviewModeBalanced",
    description: "chat.aiReviewModeBalancedDescription",
  },
  {
    id: "evidence",
    label: "chat.aiReviewModeEvidence",
    description: "chat.aiReviewModeEvidenceDescription",
  },
  {
    id: "action",
    label: "chat.aiReviewModeAction",
    description: "chat.aiReviewModeActionDescription",
  },
];

function ReviewList({
  title,
  items,
  emptyLabel,
  tone = "default",
  renderExtra,
}: {
  title: string;
  items: string[];
  emptyLabel: string;
  tone?: "default" | "warning";
  renderExtra?: (item: string, index: number) => ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/70">
      <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{title}</h3>
      {items.length ? (
        <ul className="mt-3 space-y-2">
          {items.map((item, index) => (
            <li
              key={`${index}:${item.slice(0, 32)}`}
              className="flex gap-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300"
            >
              <span
                className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${
                  tone === "warning" ? "bg-amber-500" : "bg-blue-500"
                }`}
              />
              <div className="min-w-0 flex-1">
                <span className="break-words">{item}</span>
                {renderExtra?.(item, index)}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">{emptyLabel}</p>
      )}
    </section>
  );
}

export function QuoteBadge({
  quote,
  verified,
  sourceLabel,
  verifiedLabel,
  unverifiedLabel,
}: {
  quote: string;
  verified: boolean;
  sourceLabel: string;
  verifiedLabel: string;
  unverifiedLabel: string;
}) {
  return (
    <div
      className={`mt-1.5 flex items-start gap-1.5 rounded-lg border px-2 py-1.5 text-xs leading-5 ${
        verified
          ? "border-status-success-200 bg-status-success-50/60 text-status-success-900 dark:border-status-success-900/50 dark:bg-status-success-950/20 dark:text-status-success-200"
          : "border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200"
      }`}
      title={verified ? verifiedLabel : unverifiedLabel}
    >
      {verified ? (
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 break-words">
        <span className="font-bold">{sourceLabel}: </span>
        &ldquo;{quote}&rdquo;
      </span>
    </div>
  );
}

function GroundedReviewList({
  title,
  items,
  emptyLabel,
  modelNames,
  responseLabel,
  verifiedLabel,
  unverifiedLabel,
  tone = "default",
  renderFeedback,
}: {
  title: string;
  items: GroundedClaim[];
  emptyLabel: string;
  modelNames: Map<string, string>;
  responseLabel: string;
  verifiedLabel: string;
  unverifiedLabel: string;
  tone?: "default" | "warning";
  renderFeedback?: (ordinal: number) => ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/70">
      <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{title}</h3>
      {items.length ? (
        <ul className="mt-3 space-y-3">
          {items.map((item, index) => (
            <li
              key={`${index}:${item.text.slice(0, 32)}`}
              className="flex gap-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300"
            >
              <span
                className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${
                  tone === "warning" ? "bg-amber-500" : "bg-blue-500"
                }`}
              />
              <div className="min-w-0 flex-1">
                <span className="break-words">{item.text}</span>
                {item.citations.map((citation, citationIndex) => (
                  <QuoteBadge
                    key={`${citationIndex}:${citation.responseId}`}
                    quote={citation.quote}
                    verified={citation.verified}
                    sourceLabel={
                      modelNames.get(citation.responseId) ||
                      `${responseLabel} ${citation.responseId}`
                    }
                    verifiedLabel={verifiedLabel}
                    unverifiedLabel={unverifiedLabel}
                  />
                ))}
                {renderFeedback?.(index)}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">{emptyLabel}</p>
      )}
    </section>
  );
}

const ITEM_FEEDBACK_VERDICTS = [
  { id: "helpful", label: "chat.aiReviewItemFeedbackHelpful" },
  { id: "incorrect", label: "chat.aiReviewItemFeedbackIncorrect" },
  { id: "unclear", label: "chat.aiReviewItemFeedbackUnclear" },
  { id: "missing_point", label: "chat.aiReviewItemFeedbackMissingPoint" },
] as const;

type ItemFeedbackVerdict = (typeof ITEM_FEEDBACK_VERDICTS)[number]["id"];

const ITEM_FEEDBACK_SECTIONS = [
  "consensus",
  "contradictions",
  "differences",
  "missingPoints",
  "verificationNeeded",
] as const;

/**
 * The section an item id names, narrowed to the closed enum the analytics
 * property accepts. An id whose section is not one of these sends nothing
 * rather than widening the property to a free string -- the enum is what keeps
 * the event content-free.
 */
const sectionOf = (itemId: string) => {
  const section = itemId.split(":")[1];
  return ITEM_FEEDBACK_SECTIONS.find((value) => value === section);
};

/**
 * The user's verdict on one claim.
 *
 * A row of four small toggles, not a thumbs pair: "incorrect", "unclear" and
 * "missing an important point" are three different reports, and collapsing
 * them into one thumbs-down would throw away the only part that says where to
 * look.
 *
 * Selecting the current verdict again withdraws it. A feedback control the
 * user cannot undo is one people stop using, and the endpoint's DELETE is
 * idempotent so a withdrawal that races a stale click still ends where the
 * user asked.
 *
 * Guests see the row disabled with the reason stated up front rather than
 * hidden -- the requirement is a real one (a guest review is never stored, so
 * there is no review for a verdict to point at) and hiding it would read as
 * the feature being missing.
 */
function ReviewItemFeedback({
  conversationId,
  reviewId,
  itemId,
  guest,
}: {
  conversationId?: string | null;
  reviewId?: string;
  itemId?: string;
  guest: boolean;
}) {
  const { t } = useLanguage();
  const [verdict, setVerdict] = useState<ItemFeedbackVerdict | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const submit = useCallback(
    async (next: ItemFeedbackVerdict) => {
      if (guest || !conversationId || !reviewId || !itemId) return;
      const withdrawing = verdict === next;
      const previous = verdict;
      setVerdict(withdrawing ? null : next);
      setStatus("saving");
      try {
        const response = await fetch(
          `/api/conversations/${conversationId}/comparison-reviews/item-feedback`,
          {
            method: withdrawing ? "DELETE" : "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              withdrawing
                ? { reviewId, reviewItemId: itemId }
                : { reviewId, reviewItemId: itemId, verdict: next }
            ),
          }
        );
        // Consumed on every path, not just the one whose value is parsed:
        // an unconsumed body under `private, no-store` did not reach
        // `requestfinished` (lib/discardResponseBody.ts). Nothing here reads
        // the answer -- the verdict is already on screen.
        await discardResponseBody(response);
        if (!response.ok) throw new Error("failed");
        setStatus("saved");
        // The verdict travels; the claim's text, its quotes and the question
        // do not. The item id is per-review and deliberately not sent either.
        trackProductEvent("comparison_review_item_feedback", 0, {
          review_item_feedback: withdrawing ? "withdrawn" : next,
          review_item_section: sectionOf(itemId),
        });
      } catch {
        setVerdict(previous);
        setStatus("failed");
      }
    },
    [conversationId, guest, itemId, reviewId, verdict]
  );

  if (!itemId && !guest) return null;

  return (
    <div className="mt-2" data-testid="ai-review-item-feedback">
      <div
        role="group"
        aria-label={t("chat.aiReviewItemFeedbackLabel")}
        className="flex flex-wrap items-center gap-1.5"
      >
        {ITEM_FEEDBACK_VERDICTS.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={guest || status === "saving"}
            aria-pressed={verdict === option.id}
            onClick={() => void submit(option.id)}
            data-testid={`ai-review-item-feedback-${option.id}`}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-60 ${
              verdict === option.id
                ? "border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-950/50 dark:text-blue-200"
                : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            {t(option.label)}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {guest
          ? t("chat.aiReviewItemFeedbackGuest")
          : status === "failed"
            ? t("chat.aiReviewItemFeedbackFailed")
            : status === "saved"
              ? t("chat.aiReviewItemFeedbackSaved")
              : t("chat.aiReviewItemFeedbackScope")}
      </p>
    </div>
  );
}

type VerifyItemResult = {
  status: "supported" | "unsupported" | "inconclusive";
  summary: string;
  usageCredits: number;
};

// Opt-in, per-item web verification for a single "needs external
// verification" claim -- a separate paid action (Perplexity web search),
// never run automatically, so the base review cost stays unchanged unless
// the user explicitly asks to check a specific item.
export function VerifyItemButton({
  conversationId,
  item,
  checkLabel,
  checkingLabel,
  failedLabel,
  statusLabels,
}: {
  conversationId: string;
  item: string;
  checkLabel: string;
  checkingLabel: string;
  failedLabel: string;
  statusLabels: Record<VerifyItemResult["status"], string>;
}) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "done"; result: VerifyItemResult }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  const run = async () => {
    setState({ phase: "loading" });
    try {
      const response = await fetch(
        `/api/conversations/${conversationId}/comparison-reviews/verify-item`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item }),
        }
      );
      const data = (await response.json().catch(() => ({}))) as
        | VerifyItemResult
        | { error?: string };
      if (!response.ok || !("status" in data)) {
        throw new Error("error" in data && data.error ? data.error : failedLabel);
      }
      setState({ phase: "done", result: data });
      // The step past the review itself: the user asked the live web about one
      // claim. Without this event the scorecard cannot tell an AI Review that
      // was read from one that was acted on. The check's own closed status
      // travels; its summary sentence does not -- that is model prose about
      // the user's question.
      trackProductEvent("comparison_review_item_verified", 0, {
        review_item_verification: data.status,
      });
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : failedLabel,
      });
    }
  };

  if (state.phase === "done") {
    const toneClass =
      state.result.status === "supported"
        ? "border-status-success-200 bg-status-success-50 text-status-success-900 dark:border-status-success-900/50 dark:bg-status-success-950/20 dark:text-status-success-200"
        : state.result.status === "unsupported"
          ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-200"
          : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300";
    return (
      <div className={`mt-1.5 rounded-lg border px-2 py-1.5 text-xs leading-5 ${toneClass}`}>
        <span className="font-bold">{statusLabels[state.result.status]}: </span>
        {state.result.summary}
      </div>
    );
  }

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={run}
        disabled={state.phase === "loading"}
        className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-2 py-1 text-[11px] font-bold text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-wait disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {state.phase === "loading" ? (
          <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
        ) : (
          <Search className="h-3 w-3" aria-hidden="true" />
        )}
        {state.phase === "loading" ? checkingLabel : checkLabel}
      </button>
      {state.phase === "error" && (
        <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{state.message}</p>
      )}
    </div>
  );
}

export function ComparisonReviewDialog({
  conversationId,
  guestSource = null,
  open,
  onClose,
  onCompleted,
  onSignIn,
}: {
  conversationId: string | null;
  /**
   * Present only for guests. When set, setup and run go to the guest
   * endpoints and the answers travel with the request instead of being looked
   * up by conversation id -- everything else on this screen, including the
   * dual-reviewer tabs and the source-grounding badge, is the same component
   * rendering the same DTO.
   */
  guestSource?: GuestReviewSource | null;
  open: boolean;
  onClose: () => void;
  onCompleted?: () => void;
  onSignIn?: () => void;
}) {
  const { t } = useLanguage();
  const { requestToken: requestGuestVerificationToken } = useGuestVerification();
  // One key per opened dialog, regenerated after a failure so a genuine retry
  // is a new run while a double-submitted click is not. The server refuses the
  // second request carrying a key it has already claimed, before any credit is
  // reserved.
  const idempotencyKeyRef = useRef<string>("");
  const { models: catalogModels } = useModelCatalog();
  const [setup, setSetup] = useState<ReviewSetup | null>(null);
  const [review, setReview] = useState<ComparisonReview | null>(null);
  const [mode, setMode] = useState<ReviewMode>("balanced");
  const [includeSynthesis, setIncludeSynthesis] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [activeReviewer, setActiveReviewer] = useState<"primary" | "secondary">("primary");

  /**
   * `reviewer:section:ordinal` -> the server-derived item id.
   *
   * A map rather than a search so a list with a hundred claims does not scan
   * the array once per row, and keyed by the reviewer slot because the two
   * reviewers' claims are separate things to have an opinion about even where
   * they wrote the same sentence.
   */
  const reviewItemIds = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const item of review?.reviewItems ?? []) {
      lookup.set(`${item.reviewer}:${item.section}:${item.ordinal}`, item.id);
    }
    return lookup;
  }, [review]);

  const isGuestReview = Boolean(guestSource);

  useEffect(() => {
    if (!open) return;
    if (!conversationId && !guestSource) return;
    const controller = new AbortController();
    // The guest preview is a POST because the thing being previewed is the
    // payload: there is no saved conversation to name in a URL. It spends
    // nothing and reserves nothing -- it exists so the price, the reviewer
    // class and the remaining trial on this screen all come from the server.
    const request = guestSource
      ? fetch("/api/chat/comparison-review/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({
            question: guestSource.question,
            responses: guestSource.responses,
            language: guestSource.language,
          }),
        })
      : fetch(`/api/conversations/${conversationId}/comparison-reviews`, {
          cache: "no-store",
          signal: controller.signal,
        });

    void request
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as ReviewSetup & {
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || t("chat.aiReviewPrepareFailed"));
        setSetup(data);
        trackProductEvent(
          "comparison_review_viewed",
          data.responses?.length || 0
        );
      })
      .catch((fetchError) => {
        if (controller.signal.aborted) return;
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : t("chat.aiReviewPrepareFailed")
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [conversationId, guestSource, open, t]);

  useEffect(() => {
    if (open && !idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
  }, [open]);

  const reviewDialogRef = useRef<HTMLDivElement | null>(null);
  const reviewPanelRef = useRef<HTMLDivElement | null>(null);
  // UX-010. Scroll lock and Escape were here already; initial focus, the Tab
  // cycle and focus return were not, so a keyboard user opening AI Review
  // landed nowhere and tabbed through the workspace behind it.
  //
  // Escape stays inert while a review is running, matching the disabled close
  // button: the request is billed and cancelling it is UX-019's separate change,
  // so dismissing here would hide a charge the user cannot see the result of.
  const requestClose = useCallback(() => {
    if (!running) onClose();
  }, [onClose, running]);
  useModalDialog({
    open,
    onClose: requestClose,
    dialogRef: reviewDialogRef,
    panelRef: reviewPanelRef,
  });

  const modelNames = useMemo(
    () =>
      new Map(
        (review?.responseMap || []).map((response) => [
          response.responseId,
          response.modelName,
        ])
      ),
    [review]
  );

  const modelName = (modelId: string) =>
    catalogModels.find((model) => model.id === modelId)?.name || modelId;

  // How many answers this run covers -- read from the run itself once there is
  // one, and from the setup payload before that. It is the same number the
  // rail states in its accessible descriptions, so the user can check the
  // scope both before spending credits and on the finished analysis.
  const comparedAnswerCount =
    review?.responseMap?.length ??
    setup?.responses?.length ??
    setup?.assistantMessageIds?.length ??
    0;

  // The API still returns the bucket under its legacy `confidence` name; it is
  // relabelled here so the agreement line reads as a grounding comparison
  // rather than as two models reporting how sure they feel.
  const groundingLevelLabel = (level: SourceGroundingLevel) =>
    t(
      `chat.aiReviewSourceGroundingLevel${level.charAt(0).toUpperCase()}${level.slice(1)}`
    );

  if (!open || (!conversationId && !guestSource)) return null;

  const runReview = async () => {
    if (!setup?.available) return;
    if (
      !guestSource &&
      (!setup.promptMessageId || !setup.assistantMessageIds)
    ) {
      return;
    }
    setRunning(true);
    setError("");
    trackProductEvent(
      "comparison_review_started",
      setup.responses?.length || 0,
      { review_mode: mode }
    );
    try {
      const sendGuestRun = (turnstileToken?: string) =>
        fetch("/api/chat/comparison-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            question: guestSource!.question,
            responses: guestSource!.responses,
            language: guestSource!.language,
            reviewMode: mode,
            includeSynthesis,
            idempotencyKey: idempotencyKeyRef.current,
            ...(turnstileToken ? { turnstileToken } : {}),
          }),
        });

      let response = guestSource
        ? await sendGuestRun()
        : await fetch(
            `/api/conversations/${conversationId}/comparison-reviews`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                promptMessageId: setup.promptMessageId,
                assistantMessageIds: setup.assistantMessageIds,
                reviewMode: mode,
                includeSynthesis,
              }),
            }
          );
      if (guestSource && !response.ok) {
        const preflight = (await response.clone().json().catch(() => null)) as
          | { code?: string }
          | null;
        if (preflight?.code === "TURNSTILE_REQUIRED") {
          // User-initiated, so the shared verification sheet may be shown.
          const token = await requestGuestVerificationToken("guest_ai_review");
          response = await sendGuestRun(token);
        }
      }
      const data = (await response.json().catch(() => ({}))) as
        | ComparisonReview
        | { error?: string; traceId?: string; code?: string };
      if (!response.ok || !("result" in data)) {
        const code = "code" in data ? data.code : undefined;
        // The two guest-specific refusals have their own sentences: one is
        // "come back next month or sign in", the other is "you have run out
        // of credits". Collapsing them into the generic failure would leave
        // the user guessing which.
        if (code === "GUEST_COMPARISON_REVIEW_MONTHLY_LIMIT") {
          throw new Error(t("chat.guestAiReviewTrialUsedLong"));
        }
        if (code === "CHAT_QUOTA_EXCEEDED") {
          throw new Error(t("chat.guestAiReviewNotEnoughCredits"));
        }
        if (code === "DUPLICATE_REQUEST") {
          throw new Error(t("chat.aiReviewDuplicateRequest"));
        }
        const trace = "traceId" in data && data.traceId ? ` (${data.traceId})` : "";
        throw new Error(
          `${"error" in data && data.error ? data.error : t("chat.aiReviewFailed")}${trace}`
        );
      }
      setReview(data);
      setActiveReviewer("primary");
      const primaryGrounding = toSourceGrounding(data.result.primary.result);
      trackProductEvent(
        "comparison_review_completed",
        setup.responses?.length || 0,
        {
          review_mode: mode,
          cached: data.cached,
          usage_credits: data.usageCredits,
          // Deliberately not named after the stored `confidence` field: this
          // is the exact-quote-match bucket, and analysis must not read it as
          // a model self-certainty score.
          source_grounding_level: primaryGrounding.level ?? "not_available",
        }
      );
      onCompleted?.();
    } catch (runError) {
      trackProductEvent(
        "comparison_review_failed",
        setup.responses?.length || 0,
        { review_mode: mode }
      );
      setError(
        runError instanceof Error ? runError.message : t("chat.aiReviewFailed")
      );
      // The failed run released its idempotency claim server-side, so a real
      // retry needs a real new key rather than re-presenting one the server
      // may still be holding.
      idempotencyKeyRef.current = crypto.randomUUID();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      ref={reviewDialogRef}
      className="fixed inset-0 z-[85] flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="comparison-review-title"
    >
      <div ref={reviewPanelRef} className="flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full flex-col overflow-hidden rounded-t-3xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 sm:max-h-[90dvh] sm:max-w-5xl sm:rounded-3xl">
        <div
          aria-hidden="true"
          className="h-[3px] shrink-0 bg-gradient-to-r from-tomverse-accent-start via-tomverse-accent-mid to-tomverse-accent-end"
        />
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800 sm:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-accent-ai-review-start-700 via-accent-ai-review-mid-600 to-accent-ai-review-end-600"
              >
                <Sparkles className="h-3.5 w-3.5 text-white" />
              </span>
              <span className="text-xs font-bold uppercase tracking-[0.18em] text-tomverse-review-selected-text">
                {t("chat.aiReviewEyebrow")}
              </span>
            </div>
            <h2
              id="comparison-review-title"
              className="mt-1 text-lg font-black text-zinc-900 dark:text-zinc-100 sm:text-xl"
            >
              {t("chat.aiReviewTitle")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-zinc-200 text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
            aria-label={t("chat.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
          {loading ? (
            <div
              data-testid="comparison-review-loading"
              className="flex min-h-64 flex-col items-center justify-center text-zinc-500"
            >
              <LoaderCircle className="h-7 w-7 animate-spin text-blue-500" />
              <p className="mt-3 text-sm font-semibold">{t("chat.aiReviewPreparing")}</p>
            </div>
          ) : review ? (
            (() => {
              const activeEntry =
                activeReviewer === "secondary" && review.result.secondary
                  ? review.result.secondary
                  : review.result.primary;
              const activeResult = activeEntry.result;
              return (
                <div className="space-y-4">
                  <div
                    data-testid="ai-review-result"
                    className="space-y-5 rounded-2xl border border-tomverse-review-border bg-tomverse-review-surface p-4 sm:p-5"
                  >
                  {review.result.secondary && (
                    <div className="space-y-2">
                      <div className="flex gap-2" role="tablist" aria-label={t("chat.aiReviewedBy")}>
                        {(["primary", "secondary"] as const).map((key) => {
                          const entry =
                            key === "primary" ? review.result.primary : review.result.secondary;
                          if (!entry) return null;
                          const isActive = activeReviewer === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              role="tab"
                              aria-selected={isActive}
                              onClick={() => setActiveReviewer(key)}
                              className={`rounded-xl border px-3 py-2 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 ${
                                isActive
                                  ? "border-transparent bg-gradient-to-r from-accent-ai-review-start-600 via-accent-ai-review-mid-600 to-accent-ai-review-end-600 text-white"
                                  : "border-transparent bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                              }`}
                            >
                              {key === "primary"
                                ? t("chat.aiReviewPrimaryReviewer")
                                : t("chat.aiReviewSecondaryReviewer")}
                              {": "}
                              {modelName(entry.reviewerModelId)}
                            </button>
                          );
                        })}
                      </div>
                      {review.result.agreement && (
                        <p className="rounded-xl bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-600 dark:bg-zinc-950/60 dark:text-zinc-300">
                          {review.result.agreement.confidenceMatches
                            ? t("chat.aiReviewAgreementSourceGroundingMatch")
                            : t("chat.aiReviewAgreementSourceGroundingMismatch")
                                .replace(
                                  "{primary}",
                                  groundingLevelLabel(review.result.agreement.primaryConfidence)
                                )
                                .replace(
                                  "{secondary}",
                                  groundingLevelLabel(review.result.agreement.secondaryConfidence)
                                )}
                          {" · "}
                          {t("chat.aiReviewAgreementSharedQuotes").replace(
                            "{count}",
                            String(review.result.agreement.sharedVerifiedQuoteCount)
                          )}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {review.cached ? (
                      <span className="rounded-full bg-status-success-500/10 px-3 py-1 text-xs font-bold text-status-success-600 dark:text-status-success-300">
                        {t("chat.aiReviewCached")}
                      </span>
                    ) : (
                      <CreditCostBadge
                        credits={review.usageCredits}
                        size="md"
                        label={`${review.usageCredits} ${t("chat.aiReviewCreditsUsed")}`}
                        testId="ai-review-used-credits"
                      />
                    )}
                    <SourceGroundingBadge
                      grounding={toSourceGrounding(activeResult)}
                      labels={{
                        label: t("chat.aiReviewSourceGroundingOverall"),
                        unavailable: t("chat.aiReviewSourceGroundingUnavailable"),
                        quotesMatched: t("chat.aiReviewSourceGroundingQuotesMatched"),
                        description: `${t("chat.aiReviewSourceGroundingDescription")}\n\n${t("chat.aiReviewSourceGroundingScopeReview")}`,
                        infoLabel: t("chat.aiReviewSourceGroundingInfoLabel"),
                      }}
                      testId="ai-review-source-grounding"
                    />
                    <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {t("chat.aiReviewedBy")}: {modelName(activeEntry.reviewerModelId)}
                    </span>
                    {/* A guest result is not stored anywhere, so it must not
                        be presented as if it were: it is gone on refresh, and
                        saying so here is the difference between an honest
                        trial and a broken feature. */}
                    {review.persisted === false && (
                      <span
                        data-testid="ai-review-guest-not-saved"
                        className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                      >
                        {t("chat.guestAiReviewNotSaved")}
                      </span>
                    )}
                    {/* What the analysis actually covered, kept with the run
                        rather than only on the screen that started it. */}
                    {comparedAnswerCount > 0 && (
                      <span
                        data-testid="ai-review-compared-count"
                        className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      >
                        {t("chat.comparisonRailStatusHiddenHint").replaceAll(
                          "{ready}",
                          String(comparedAnswerCount)
                        )}
                      </span>
                    )}
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <GroundedReviewList
                      title={t("chat.aiReviewConsensus")}
                      items={activeResult.consensus}
                      emptyLabel={t("chat.aiReviewNoneFound")}
                      modelNames={modelNames}
                      responseLabel={t("chat.aiReviewResponse")}
                      verifiedLabel={t("chat.aiReviewQuoteVerified")}
                      unverifiedLabel={t("chat.aiReviewQuoteUnverified")}
                      renderFeedback={(ordinal) => (
                        <ReviewItemFeedback
                          conversationId={conversationId}
                          reviewId={review.id}
                          itemId={reviewItemIds.get(
                            `${activeReviewer}:consensus:${ordinal}`
                          )}
                          guest={isGuestReview}
                        />
                      )}
                    />
                    <GroundedReviewList
                      title={t("chat.aiReviewContradictions")}
                      items={activeResult.contradictions}
                      emptyLabel={t("chat.aiReviewNoneFound")}
                      modelNames={modelNames}
                      responseLabel={t("chat.aiReviewResponse")}
                      verifiedLabel={t("chat.aiReviewQuoteVerified")}
                      unverifiedLabel={t("chat.aiReviewQuoteUnverified")}
                      tone="warning"
                      renderFeedback={(ordinal) => (
                        <ReviewItemFeedback
                          conversationId={conversationId}
                          reviewId={review.id}
                          itemId={reviewItemIds.get(
                            `${activeReviewer}:contradictions:${ordinal}`
                          )}
                          guest={isGuestReview}
                        />
                      )}
                    />
                  </div>

                  <section className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                      {t("chat.aiReviewDifferences")}
                    </h3>
                    {activeResult.differences.length ? (
                      <div className="mt-3 space-y-3">
                        {activeResult.differences.map((difference, index) => (
                          <article
                            key={`${index}:${difference.issue.slice(0, 32)}`}
                            className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800"
                          >
                            <h4 className="bg-zinc-50 px-3 py-2 text-sm font-bold dark:bg-zinc-950">
                              {difference.issue}
                            </h4>
                            <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                              {difference.positions.map((position) => (
                                <div
                                  key={position.responseId}
                                  className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[10rem_1fr] sm:gap-3"
                                >
                                  <span className="font-bold text-blue-600 dark:text-blue-300">
                                    {modelNames.get(position.responseId) ||
                                      `${t("chat.aiReviewResponse")} ${position.responseId}`}
                                  </span>
                                  <div className="min-w-0">
                                    <span className="break-words leading-6 text-zinc-700 dark:text-zinc-300">
                                      {position.position}
                                    </span>
                                    <QuoteBadge
                                      quote={position.quote}
                                      verified={position.verified}
                                      sourceLabel={
                                        modelNames.get(position.responseId) ||
                                        `${t("chat.aiReviewResponse")} ${position.responseId}`
                                      }
                                      verifiedLabel={t("chat.aiReviewQuoteVerified")}
                                      unverifiedLabel={t("chat.aiReviewQuoteUnverified")}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div className="px-3 pb-3">
                              <ReviewItemFeedback
                                conversationId={conversationId}
                                reviewId={review.id}
                                itemId={reviewItemIds.get(
                                  `${activeReviewer}:differences:${index}`
                                )}
                                guest={isGuestReview}
                              />
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-zinc-500">{t("chat.aiReviewNoneFound")}</p>
                    )}
                  </section>

                  <div className="grid gap-4 md:grid-cols-2">
                    <ReviewList
                      title={t("chat.aiReviewMissingPoints")}
                      items={activeResult.missingPoints}
                      emptyLabel={t("chat.aiReviewNoneFound")}
                      renderExtra={(_item, index) => (
                        <ReviewItemFeedback
                          conversationId={conversationId}
                          reviewId={review.id}
                          itemId={reviewItemIds.get(
                            `${activeReviewer}:missingPoints:${index}`
                          )}
                          guest={isGuestReview}
                        />
                      )}
                    />
                    <ReviewList
                      title={t("chat.aiReviewVerificationNeeded")}
                      items={activeResult.verificationNeeded}
                      emptyLabel={t("chat.aiReviewNoneFound")}
                      tone="warning"
                      renderExtra={(item, index) =>
                        // Per-item web verification runs a paid external
                        // search against a saved conversation, which a guest
                        // does not have. Rather than showing a control that
                        // would 401, the reason and the way to get it are
                        // stated once, under the first item.
                        isGuestReview ? (
                          index === 0 ? (
                            <p
                              data-testid="ai-review-verify-guest-locked"
                              className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-zinc-200 px-2 py-1.5 text-[11px] leading-5 text-zinc-600 dark:border-zinc-800 dark:text-zinc-300"
                            >
                              <Lock
                                className="mt-0.5 h-3 w-3 shrink-0"
                                aria-hidden="true"
                              />
                              <span className="min-w-0">
                                {t("chat.guestAiReviewVerifySignIn")}
                                {onSignIn && (
                                  <button
                                    type="button"
                                    onClick={onSignIn}
                                    className="ml-1 font-bold underline underline-offset-2"
                                  >
                                    {t("chat.guestAiReviewSignInCta")}
                                  </button>
                                )}
                              </span>
                            </p>
                          ) : null
                        ) : (
                          <VerifyItemButton
                            conversationId={conversationId as string}
                            item={item}
                            checkLabel={t("chat.aiReviewVerifyWithWeb")}
                            checkingLabel={t("chat.aiReviewVerifying")}
                            failedLabel={t("chat.aiReviewVerifyFailed")}
                            statusLabels={{
                              supported: t("chat.aiReviewVerifySupported"),
                              unsupported: t("chat.aiReviewVerifyUnsupported"),
                              inconclusive: t("chat.aiReviewVerifyInconclusive"),
                            }}
                          />
                        )
                      }
                    />
                  </div>

                  <section className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                      {t("chat.aiReviewModelAssessments")}
                    </h3>
                    <div className="mt-3 grid gap-3 lg:grid-cols-3">
                      {activeResult.modelAssessments.map((assessment) => (
                        <article
                          key={assessment.responseId}
                          className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-950"
                        >
                          <h4 className="font-bold text-blue-600 dark:text-blue-300">
                            {modelNames.get(assessment.responseId) || assessment.responseId}
                          </h4>
                          <p className="mt-2 text-xs font-bold uppercase tracking-wide text-status-success-600 dark:text-status-success-300">
                            {t("chat.aiReviewStrengths")}
                          </p>
                          <ul className="mt-1 space-y-1 text-sm leading-5 text-zinc-700 dark:text-zinc-300">
                            {assessment.strengths.map((item) => (
                              <li key={item}>• {item}</li>
                            ))}
                          </ul>
                          <p className="mt-3 text-xs font-bold uppercase tracking-wide text-amber-600 dark:text-amber-300">
                            {t("chat.aiReviewCautions")}
                          </p>
                          <ul className="mt-1 space-y-1 text-sm leading-5 text-zinc-700 dark:text-zinc-300">
                            {assessment.cautions.map((item) => (
                              <li key={item}>• {item}</li>
                            ))}
                          </ul>
                        </article>
                      ))}
                    </div>
                  </section>

                  {activeResult.synthesis && (
                    <section
                      data-testid="ai-review-synthesis"
                      className="rounded-2xl border border-tomverse-review-border bg-gradient-to-br from-accent-ai-review-start-50 via-accent-ai-review-mid-50 to-accent-ai-review-end-50 p-4 dark:from-accent-ai-review-start-950/25 dark:via-accent-ai-review-mid-950/25 dark:to-accent-ai-review-end-950/25"
                    >
                      <h3 className="flex items-center gap-1.5 text-sm font-bold text-zinc-900 dark:text-zinc-100">
                        <Sparkles
                          className="h-3.5 w-3.5 shrink-0 text-tomverse-review-selected-text"
                          aria-hidden="true"
                        />
                        {t("chat.aiReviewSynthesis")}
                      </h3>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                        {activeResult.synthesis}
                      </p>
                    </section>
                  )}

                  <ReviewList
                    title={t("chat.aiReviewLimitations")}
                    items={activeResult.limitations}
                    emptyLabel={review.disclaimer}
                    tone="warning"
                  />
                  </div>
                  <button
                    type="button"
                    onClick={() => setReview(null)}
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 px-4 py-2 text-sm font-bold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    <RefreshCw className="h-4 w-4" />
                    {t("chat.aiReviewChangeCriteria")}
                  </button>
                </div>
              );
            })()
          ) : (
            <div data-testid="comparison-review-setup" className="space-y-5">
              <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                {t("chat.aiReviewDescription")}
              </p>

              {/*
                The rail no longer keeps "Comparing N completed answers" on
                screen in the steady state (see
                docs/ui-contracts/comparison-action-rail.md), so the scope is
                named here instead -- before anything is spent, on the screen
                where the user confirms the run.
              */}
              {setup?.available && comparedAnswerCount > 0 && (
                <p
                  data-testid="comparison-review-scope"
                  className="text-xs font-bold leading-5 text-zinc-500 dark:text-zinc-400"
                >
                  {t("chat.comparisonRailStatusHiddenHint").replaceAll(
                    "{ready}",
                    String(comparedAnswerCount)
                  )}
                </p>
              )}

              {setup?.available ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {modeKeys.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={mode === item.id}
                        onClick={() => setMode(item.id)}
                        className={`rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 ${
                          mode === item.id
                            ? "border-tomverse-review-selected-border bg-tomverse-review-selected ring-2 ring-tomverse-review-selected-border/20"
                            : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-950"
                        }`}
                      >
                        <span className="flex items-center gap-2 text-sm font-bold">
                          {mode === item.id && (
                            <span
                              aria-hidden="true"
                              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-ai-review-start-600 via-accent-ai-review-mid-600 to-accent-ai-review-end-600"
                            >
                              <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
                            </span>
                          )}
                          {t(item.label)}
                        </span>
                        <span className="mt-2 block text-xs leading-5 text-zinc-500">
                          {t(item.description)}
                        </span>
                      </button>
                    ))}
                  </div>

                  <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                    <input
                      type="checkbox"
                      checked={includeSynthesis}
                      onChange={(event) => setIncludeSynthesis(event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-zinc-300"
                    />
                    <span>
                      <span className="block text-sm font-bold">{t("chat.aiReviewIncludeSynthesis")}</span>
                      <span className="mt-1 block text-xs leading-5 text-zinc-500">
                        {t("chat.aiReviewIncludeSynthesisDescription")}
                      </span>
                    </span>
                  </label>

                  <div className="rounded-2xl bg-zinc-50 p-4 dark:bg-zinc-950">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">
                          {t("chat.aiReviewEstimatedCost")}
                        </p>
                        <CreditCostBadge
                          credits={setup.estimatedCredits || 0}
                          size="md"
                          className="mt-1"
                          label={`${setup.estimatedCredits || 0} ${t("chat.aiReviewCredits")}`}
                          testId="ai-review-estimated-credits"
                        />
                        {setup.dualReview && (
                          <p className="mt-1 text-xs leading-5 text-zinc-500">
                            {t("chat.aiReviewDualReviewerNote")}
                          </p>
                        )}
                      </div>
                      <div className="text-right text-xs leading-5 text-zinc-500">
                        <p>{setup.reviewerClass} reviewer</p>
                        {setup.freeMonthlyReviews ? (
                          <p>
                            Free: {setup.freeMonthlyReviews} {t("chat.aiReviewPerMonth")}
                          </p>
                        ) : null}
                        {setup.guestTrial ? (
                          <p data-testid="ai-review-guest-trial-scope">
                            {t("chat.guestAiReviewTrialAvailable")
                              .replaceAll(
                                "{remaining}",
                                String(setup.guestTrial.remaining)
                              )
                              .replaceAll(
                                "{limit}",
                                String(setup.guestTrial.limit)
                              )}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                  <p className="text-sm leading-6">
                    {setup?.reason || t("chat.aiReviewResponsesRequired")}
                  </p>
                </div>
              )}
            </div>
          )}

          {error && (
            // UI-004: a review that fails after the user has committed the
            // click is an error they must notice, not a paragraph that
            // silently appears below the fold -- so it announces like every
            // other failure surface in the product does.
            <div
              role="alert"
              data-testid="comparison-review-error"
              className="mt-5 flex gap-3 rounded-2xl border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
            >
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <p className="min-w-0 break-words text-sm leading-6">{error}</p>
            </div>
          )}
        </div>

        {!loading && !review && setup?.available && (
          <footer className="shrink-0 border-t border-zinc-200 bg-white px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 dark:border-zinc-800 dark:bg-zinc-900 sm:px-6 sm:pb-4">
            <p className="mb-3 text-xs leading-5 text-zinc-500">
              {setup.disclaimer || t("chat.aiReviewDisclaimer")}
            </p>
            <button
              type="button"
              onClick={runReview}
              disabled={running}
              className="flex h-11 w-full items-center justify-between gap-3 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-500 disabled:cursor-wait disabled:opacity-60 sm:ml-auto sm:w-auto sm:min-w-48"
            >
              <span className="flex min-w-0 items-center gap-2">
                {running ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : <Sparkles className="h-4 w-4 shrink-0" />}
                <span className="truncate">{running ? t("chat.aiReviewRunning") : t("chat.aiReviewRun")}</span>
              </span>
              <CreditCostBadge
                credits={setup.estimatedCredits || 0}
                size="xs"
                tone="onColor"
                label={`${setup.estimatedCredits || 0} ${t("chat.aiReviewCredits")}`}
                testId="ai-review-run-credit-cost"
                className="border-0 bg-white/20"
              />
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
