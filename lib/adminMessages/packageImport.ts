import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the assistant package import metrics (`AdminPackageImportPanel`). */
export const adminPackageImportMessages = defineAdminMessages({
  en: {
    title: "Assistant package imports",
    window: (days: number) => `last ${days} days`,
    empty:
      "No import has been started in this window. The feature is behind a flag that is off, so zero here is the expected reading rather than a measurement of interest.",
    steps: "Steps",
    columns: {
      step: "Step",
      entered: "Entered",
      leftDeliberately: "Left deliberately",
    },
    stepsNote:
      "A browser closing is not observable, so “left deliberately” is a floor. Real drop-off is the difference between consecutive rows’ entered counts.",
    warnings: "Warnings",
    completed: "Completed",
    total: "total",
    completedNote:
      "What the parser read the package as, never what the package claimed to be.",
  },
  ko: {
    title: "Assistant package 가져오기",
    window: (days: number) => `최근 ${days}일`,
    empty:
      "이 기간에 시작된 가져오기가 없습니다. 이 기능은 꺼져 있는 flag 뒤에 있으므로, 여기서 0은 관심도를 측정한 값이 아니라 예상된 값입니다.",
    steps: "단계",
    columns: {
      step: "단계",
      entered: "진입",
      leftDeliberately: "의도적 이탈",
    },
    stepsNote:
      "브라우저를 닫는 것은 관측할 수 없으므로 “의도적 이탈”은 하한값입니다. 실제 이탈은 연속된 두 행의 진입 수 차이입니다.",
    warnings: "경고",
    completed: "완료",
    total: "합계",
    completedNote:
      "package가 스스로 주장한 형식이 아니라 parser가 실제로 읽어 낸 형식입니다.",
  },
});
