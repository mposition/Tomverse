"use client";
import { useAdminLocale } from "@/components/admin/AdminLocaleProvider";
import type { DailyTaskImplementation } from "@/lib/dailyProductImplementationCore";

export function DailyImplementationEvidence({ implementation, unavailable = false }: {
  implementation?: DailyTaskImplementation; unavailable?: boolean;
}) {
  const { locale } = useAdminLocale();
  if (!implementation && !unavailable) return null;
  const labels = locale === "ko" ? {
    open: "연결된 구현 PR 열림", merged: "develop 병합 · 운영 반영 확인 필요", closed: "PR 닫힘 · 병합되지 않음",
    unavailable: "구현 PR 상태를 확인하지 못했습니다.",
  } : {
    open: "Linked implementation PR open", merged: "Merged into develop · production deployment unconfirmed", closed: "PR closed without merge",
    unavailable: "Implementation PR status could not be checked.",
  };
  return <p className="mt-1 text-xs text-zinc-400" data-testid="daily-implementation-evidence">
    {implementation ? <a className="text-blue-300 hover:text-blue-200" href={implementation.prUrl} target="_blank" rel="noreferrer">{labels[implementation.state]}</a> : labels.unavailable}
  </p>;
}
