import { createRoot } from "react-dom/client";
import { AdminAiReviewJudgedPanel } from "@/components/admin/AdminAiReviewJudgedPanel";
import type { AiReviewJudgedRunCatalog } from "@/lib/aiReviewJudgedReportTypes";

const catalog: AiReviewJudgedRunCatalog = await fetch("/catalog.json").then(
  (response) => response.json(),
);
createRoot(document.getElementById("root")!).render(
  <main
    data-admin-theme="light"
    className="min-h-screen bg-zinc-950 p-4 sm:p-8"
  >
    <div className="mx-auto max-w-6xl">
      <AdminAiReviewJudgedPanel catalog={catalog} locale="ko" />
    </div>
  </main>,
);
