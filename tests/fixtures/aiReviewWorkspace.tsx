import { createRoot } from "react-dom/client";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ComparisonReviewDialog } from "@/components/chat/ComparisonReviewDialog";

createRoot(document.getElementById("root")!).render(
  <LanguageProvider initialLang="ko" forceInitialLang>
    <ComparisonReviewDialog
      conversationId="qa-conversation"
      open
      onClose={() => {}}
    />
  </LanguageProvider>,
);
