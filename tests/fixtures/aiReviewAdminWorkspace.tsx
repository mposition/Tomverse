import { createRoot } from "react-dom/client";
import { AdminAiReviewJudgedPanel } from "@/components/admin/AdminAiReviewJudgedPanel";
import type { AiReviewJudgedRunCatalog } from "@/lib/aiReviewJudgedReportTypes";
import { AdminAiReviewPreparationPanel } from "@/components/admin/AdminAiReviewPreparationPanel";
import { AdminAiReviewThresholdDraft } from "@/components/admin/AdminAiReviewThresholdDraft";
import { AdminAiReviewM5Progress } from "@/components/admin/AdminAiReviewM5Progress";

const catalog: AiReviewJudgedRunCatalog = await fetch("/catalog.json").then(
  (response) => response.json(),
);
const preparation =
  location.pathname === "/prepare"
    ? await fetch("/preparation.json").then((response) => response.json())
    : null;
createRoot(document.getElementById("root")!).render(
  <main
    data-admin-theme="light"
    className="min-h-screen bg-zinc-950 p-4 sm:p-8"
  >
    <div className="mx-auto max-w-6xl">
      {preparation ? (
        <div className="space-y-5">
          <AdminAiReviewPreparationPanel
            catalog={preparation.catalog}
            locale="ko"
          />
          <AdminAiReviewThresholdDraft locale="ko" />
          <AdminAiReviewM5Progress
            progress={preparation.progress}
            locale="ko"
          />
        </div>
      ) : (
        <AdminAiReviewJudgedPanel catalog={catalog} locale="ko" />
      )}
    </div>
  </main>,
);
