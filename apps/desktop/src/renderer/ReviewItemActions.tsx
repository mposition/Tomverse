import { useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { COMPARISON_REVIEW_ITEM_VERDICTS } from "../../../../lib/comparisonReviewItemFeedback";
import type { Language } from "../../../../lib/language";
import type { ItemFeedbackOutcome, VerifyItemOutcome } from "../chat-extras-contract";
import { webLocales } from "./answer-locales";

type Verdict = (typeof COMPARISON_REVIEW_ITEM_VERDICTS)[number];
type SendFeedback = (input: { conversationId: string; reviewId: string; reviewItemId: string; verdict: Verdict | null }) => Promise<ItemFeedbackOutcome>;
type SendVerify = (input: { conversationId: string; item: string }) => Promise<VerifyItemOutcome>;
const verdictLabels = {
  helpful: "aiReviewItemFeedbackHelpful", incorrect: "aiReviewItemFeedbackIncorrect",
  unclear: "aiReviewItemFeedbackUnclear", missing_point: "aiReviewItemFeedbackMissingPoint",
} as const satisfies Record<Verdict, string>;

/**
 * The user's verdict on one AI Review point. Choosing the saved verdict again withdraws it, as on the web.
 */
export function ReviewItemFeedback({ conversationId, reviewId, itemId, language, send = sendFeedback }: {
  conversationId: string; reviewId: string; itemId?: string; language: Language;
  send?: SendFeedback;
}) {
  const chat = webLocales[language].chat;
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  if (!itemId) return null;
  async function choose(next: Verdict) {
    const previous = verdict;
    const withdrawing = previous === next;
    setVerdict(withdrawing ? null : next);
    setStatus("saving");
    try {
      const outcome = await send({ conversationId, reviewId, reviewItemId: itemId!, verdict: withdrawing ? null : next });
      if (!outcome.ok) throw new Error("refused");
      setStatus("saved");
    } catch {
      setVerdict(previous);
      setStatus("failed");
    }
  }
  return <div className="review-item-feedback" data-testid="desktop-ai-review-item-feedback">
    <div role="group" aria-label={chat.aiReviewItemFeedbackLabel}>
      {COMPARISON_REVIEW_ITEM_VERDICTS.map((option) => <button key={option} type="button" aria-pressed={verdict === option}
        disabled={status === "saving"} data-testid={`desktop-ai-review-item-feedback-${option}`}
        onClick={() => void choose(option)}>{chat[verdictLabels[option]]}</button>)}
    </div>
    <small role="status">{status === "failed" ? chat.aiReviewItemFeedbackFailed : status === "saved" ? chat.aiReviewItemFeedbackSaved
      : chat.aiReviewItemFeedbackScope}</small>
  </div>;
}

const sendFeedback: SendFeedback = (input) =>
  window.desktop.chatExtras<"itemFeedback">({ action: "itemFeedback", ...input });

/** An opt-in web check of one "needs verification" point. It is a separate model call, so it never runs by itself. */
export function VerifyReviewItem({ conversationId, item, language, send = sendVerify }: {
  conversationId: string; item: string; language: Language;
  send?: SendVerify;
}) {
  const chat = webLocales[language].chat;
  const [state, setState] = useState<{ phase: "idle" | "loading" | "error" } | { phase: "done"; result: Extract<VerifyItemOutcome, { ok: true }> }>({ phase: "idle" });
  if (state.phase === "done") {
    const labels = { supported: chat.aiReviewVerifySupported, unsupported: chat.aiReviewVerifyUnsupported, inconclusive: chat.aiReviewVerifyInconclusive };
    return <div className="review-item-verified" data-status={state.result.status} data-testid="desktop-ai-review-item-verified">
      <strong>{labels[state.result.status]}: </strong>{state.result.summary}
    </div>;
  }
  return <div className="review-item-verify">
    <button type="button" disabled={state.phase === "loading"} data-testid="desktop-ai-review-item-verify" onClick={async () => {
      setState({ phase: "loading" });
      try {
        const result = await send({ conversationId, item });
        setState(result.ok ? { phase: "done", result } : { phase: "error" });
      } catch {
        setState({ phase: "error" });
      }
    }}>{state.phase === "loading" ? <LoaderCircle size={13} aria-hidden="true" /> : <Search size={13} aria-hidden="true" />}
      {state.phase === "loading" ? chat.aiReviewVerifying : chat.aiReviewVerifyWithWeb}</button>
    {state.phase === "error" && <small role="alert">{chat.aiReviewVerifyFailed}</small>}
  </div>;
}

const sendVerify: SendVerify = (input) =>
  window.desktop.chatExtras<"verifyItem">({ action: "verifyItem", ...input });
