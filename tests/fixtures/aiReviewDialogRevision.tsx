import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ComparisonReviewDialog, type GuestReviewSource } from "@/components/chat/ComparisonReviewDialog";

declare global {
  interface Window {
    /** Stands in for ChatPageClient's handleResponseComplete: another panel finished. */
    __tomverseAnswerFinished?: () => void;
  }
}

/**
 * The Classic AI Review dialog as ChatPageClient mounts it: keyed by identity
 * and conversation only, with every finished answer bumping `sourceRevision`.
 * The modal overlay covers the page, so the "answer finished" signal is a
 * window hook rather than a button the test would have to click through it.
 *
 * `?mode=guest` mounts the guest dialog the same way: `guestSource` is the
 * turn captured when it opened, `readGuestSource` the page's latest local
 * turn, and a finished answer adds one more answer to that turn.
 */
const guestMode = new URLSearchParams(window.location.search).get("mode") === "guest";
const guestAnswers = [
  { modelId: "gpt-5-4-mini", content: "단계적으로 접근해야 합니다. 먼저 배포부터 진행합니다." },
  { modelId: "claude-haiku-4-5", content: "사용자 검증을 먼저 합니다." },
  { modelId: "gemini-2-5-flash", content: "비용과 속도를 분석합니다." },
];
let finishedGuestAnswers = 2;
const guestTurn = (): GuestReviewSource => ({
  question: "Compare these approaches",
  language: "ko",
  responses: guestAnswers.slice(0, finishedGuestAnswers).map((answer) => ({
    messageId: `guest-prompt:${answer.modelId}`,
    ...answer,
  })),
});

function Fixture() {
  const [revision, setRevision] = useState(0);
  const [capturedGuestSource] = useState(() => (guestMode ? guestTurn() : null));
  useEffect(() => {
    window.__tomverseAnswerFinished = () => {
      finishedGuestAnswers = Math.min(guestAnswers.length, finishedGuestAnswers + 1);
      setRevision((value) => value + 1);
    };
    return () => {
      delete window.__tomverseAnswerFinished;
    };
  }, []);
  return (
    <LanguageProvider initialLang="ko" forceInitialLang>
      <ComparisonReviewDialog
        key={JSON.stringify(["account-a", "qa-conversation"])}
        conversationId={guestMode ? null : "qa-conversation"}
        guestSource={capturedGuestSource}
        readGuestSource={guestMode ? guestTurn : undefined}
        sourceRevision={revision}
        open
        onClose={() => {}}
      />
    </LanguageProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
