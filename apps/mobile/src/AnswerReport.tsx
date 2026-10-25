import { useRef, useState } from "react";
import { mobileWorkspaceCopy } from "../../../locales/mobileWorkspace";
import type { MobileLanguage } from "../../../locales/mobile";
import type { ChatTransport } from "./chatTransport";

/**
 * Reporting a problem with one answer, from the app. The same report the web
 * sends: the server links it to the answer only when the caller owns it.
 */
export function AnswerReport({ transport, language, messageId, modelId }: {
  transport: ChatTransport; language: MobileLanguage; messageId: string; modelId?: string;
}) {
  const copy = mobileWorkspaceCopy[language];
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed" | "short">("idle");
  const [reference, setReference] = useState<string | null>(null);
  // A ref, not state: a second tap before the next render must not send twice.
  const sending = useRef(false);
  const send = async () => {
    if (sending.current) return;
    if (text.trim().length < 5) { setState("short"); return; }
    sending.current = true;
    setState("sending");
    try {
      const result = await transport.reportAnswer?.({ messageId, modelId, message: text.trim(), language });
      setReference(result?.reference ?? null);
      setState("sent");
    } catch {
      setState("failed");
    } finally {
      sending.current = false;
    }
  };
  if (state === "sent") {
    return <div className="answer-report-form"><p role="status">{copy.reportSent}{reference && <> {copy.reportReference.replace("{reference}", reference)}</>}</p></div>;
  }
  return <div className="answer-report-form">
    <textarea aria-label={copy.report} placeholder={copy.reportPlaceholder} value={text} maxLength={2000}
      onChange={(event) => { setText(event.target.value); if (state === "short" || state === "failed") setState("idle"); }} />
    {state === "short" && <p role="alert">{copy.reportTooShort}</p>}
    {state === "failed" && <p role="alert">{copy.reportFailed}</p>}
    <button className="primary" disabled={state === "sending"} onClick={() => void send()}>{copy.reportSend}</button>
  </div>;
}
