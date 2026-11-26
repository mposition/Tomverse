import { useState } from "react";
import { Flag } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { FEEDBACK_MESSAGE_MAX_LENGTH, feedbackMessageState, type FeedbackSubmitFailure } from "../../../../lib/feedbackPolicy";
import { webLocales } from "./answer-locales";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);

/** Desktop has no guest security check, so a refused session reads as a plain failure. */
export function failureText(text: typeof webLocales.en.feedback, failure: FeedbackSubmitFailure) {
  switch (failure) {
    case "invalid": return text.errorInvalid;
    case "tooLarge": return text.errorTooLarge;
    case "rateLimited": return text.errorRateLimited;
    case "server": return text.errorServer;
    case "network": return text.errorNetwork;
    default: return text.failed;
  }
}

/** "Report a problem with this answer": the same report the web sends, tied to the saved answer. */
export function AnswerFeedback({ product, messageId, modelId, language }: {
  product: "chat" | "review"; messageId: string; modelId?: string | null; language: Language;
}) {
  const copy = webLocales[language];
  const text = copy.feedback;
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [emailUpdates, setEmailUpdates] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [result, setResult] = useState("");
  const draft = feedbackMessageState(message);
  const hint = draft.kind === "tooLong" ? fill(text.messageTooLong, { max: FEEDBACK_MESSAGE_MAX_LENGTH })
    : draft.kind === "ready" ? text.messageReady
      : draft.kind === "tooShort" ? fill(text.messageRemaining, { count: draft.remaining })
        : fill(text.messageHelp, { min: 5 });

  async function send() {
    if (!draft.isValid || state === "sending") return;
    setState("sending");
    try {
      const outcome = await window.desktop.chatExtras<"feedback">({
        action: "feedback", product, messageId, message: message.trim(),
        ...(modelId ? { modelId } : {}), ...(emailUpdates ? { emailUpdates: true } : {}),
      });
      if (outcome.ok) {
        const sent = outcome.reference ? fill(text.sentWithReference, { reference: outcome.reference }) : text.sent;
        setResult(outcome.emailUpdatesEnabled ? `${sent} ${text.emailUpdatesScheduled}` : sent);
        setState("sent");
        setMessage("");
        setOpen(false);
        return;
      }
      setResult(failureText(text, outcome.failure));
    } catch {
      setResult(text.failed);
    }
    setState("failed");
  }

  return <div className="answer-feedback" data-testid="desktop-answer-feedback">
    {state === "sent" && <small role="status" data-testid="desktop-answer-feedback-sent">{result}</small>}
    {!open && state !== "sent" && <button type="button" className="answer-feedback-open" onClick={() => setOpen(true)}>
      <Flag size={12} aria-hidden="true" /> {copy.memoryReview.reportAnswer}
    </button>}
    {open && <form onSubmit={(event) => { event.preventDefault(); void send(); }} aria-label={text.title}>
      <textarea aria-label={text.messageLabel} placeholder={text.placeholder} value={message} rows={3} maxLength={FEEDBACK_MESSAGE_MAX_LENGTH + 200}
        disabled={state === "sending"} onChange={(event) => setMessage(event.currentTarget.value)} />
      <small className="answer-feedback-hint">{hint}</small>
      <label className="answer-feedback-email"><input type="checkbox" checked={emailUpdates} disabled={state === "sending"}
        onChange={(event) => setEmailUpdates(event.currentTarget.checked)} /> {text.emailUpdatesLabel}</label>
      {emailUpdates && <small>{text.emailUpdatesAccountHint}</small>}
      {state === "failed" && <small role="alert" className="answer-feedback-error">{result}</small>}
      <div className="answer-feedback-actions">
        <button type="submit" className="soft" disabled={!draft.isValid || state === "sending"}>{state === "sending" ? text.sending : text.send}</button>
        <button type="button" className="soft" disabled={state === "sending"} onClick={() => { setOpen(false); setState("idle"); }}>{text.close}</button>
      </div>
    </form>}
  </div>;
}
