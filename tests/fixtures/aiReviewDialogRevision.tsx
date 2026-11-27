import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ComparisonReviewDialog } from "@/components/chat/ComparisonReviewDialog";

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
 */
function Fixture() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    window.__tomverseAnswerFinished = () => setRevision((value) => value + 1);
    return () => {
      delete window.__tomverseAnswerFinished;
    };
  }, []);
  return (
    <LanguageProvider initialLang="ko" forceInitialLang>
      <ComparisonReviewDialog
        key={JSON.stringify(["account-a", "qa-conversation"])}
        conversationId="qa-conversation"
        sourceRevision={revision}
        open
        onClose={() => {}}
      />
    </LanguageProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
