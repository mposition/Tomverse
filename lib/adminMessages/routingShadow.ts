import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the shadow routing report on /admin/routing. */
export const adminRoutingShadowMessages = defineAdminMessages({
  en: {
    loadFailed: "Could not load the shadow routing report.",
    eyebrow: "Shadow routing",
    title: "What Auto would have chosen",
    description:
      "The Router's rules run on real turns and the decision is recorded; the model the user selected is what executed.",
    refresh: "Refresh",
    emptyBefore: (days: number) =>
      `No shadow runs in the last ${days} days. Shadow routing is off unless`,
    emptyAfter: "is set, so this is expected until it is turned on.",
    mixedVersions:
      "This window spans more than one rule version, so the rates below describe no single Router. Narrow the window before drawing a conclusion.",
    truncated: "The row cap was reached, so this window is only partly covered.",
    stats: {
      runs: "Runs",
      lastDays: (days: number) => `Last ${days} days`,
      agreement: "Agreement",
      agreedOfDecided: (agreed: string, decided: string) => `${agreed} of ${decided} decided`,
      noCandidate: "No candidate",
      noCandidateDetail: "Nothing survived the filters",
      decisionLatency: "Decision p50 / p95",
      decisionLatencyDetail: "ROUTE-02 bounds p95 at 300ms",
    },
    switches: {
      title: "Where Auto would move traffic",
      none: "No disagreements in this window.",
    },
    groups: {
      byTaskKind: "Agreement by task kind",
      byPlan: "Agreement by plan",
      selectionReasons: "Selection reasons",
      rejections: "Models refused, by filter",
      noneInWindow: "None in this window.",
      nothingDecided: "Nothing decided yet.",
    },
    caveat:
      "Agreement is not a score. ROUTE-01 grades the Router on a win-rate against the fixed-model baseline, measured on an evaluation set. A Router that echoed the user would agree every time and be worth nothing; one that is right where the user was wrong appears here as disagreement. This measures how much would change if Auto were switched on, not whether the change would be an improvement.",
  },
  ko: {
    loadFailed: "shadow 라우팅 보고서를 불러오지 못했습니다.",
    eyebrow: "Shadow 라우팅",
    title: "Auto였다면 선택했을 모델",
    description:
      "Router 규칙은 실제 turn에서 실행되고 그 결정이 기록됩니다. 실제로 실행된 것은 사용자가 선택한 모델입니다.",
    refresh: "새로고침",
    emptyBefore: (days: number) =>
      `최근 ${days}일 동안 shadow 실행이 없습니다. Shadow 라우팅은`,
    emptyAfter: "환경변수를 설정해야 켜지므로, 켜기 전까지는 예상된 상태입니다.",
    mixedVersions:
      "이 기간에는 규칙 버전이 둘 이상 섞여 있어, 아래 비율은 어느 한 Router도 설명하지 않습니다. 결론을 내리기 전에 기간을 좁히세요.",
    truncated: "행 상한에 도달해 이 기간의 일부만 반영되었습니다.",
    stats: {
      runs: "실행",
      lastDays: (days: number) => `최근 ${days}일`,
      agreement: "일치율",
      agreedOfDecided: (agreed: string, decided: string) => `결정된 ${decided}건 중 ${agreed}건`,
      noCandidate: "후보 없음",
      noCandidateDetail: "필터를 통과한 모델이 없음",
      decisionLatency: "결정 시간 p50 / p95",
      decisionLatencyDetail: "ROUTE-02의 p95 상한은 300ms",
    },
    switches: {
      title: "Auto가 트래픽을 옮길 곳",
      none: "이 기간에 불일치가 없습니다.",
    },
    groups: {
      byTaskKind: "작업 유형별 일치율",
      byPlan: "플랜별 일치율",
      selectionReasons: "선택 사유",
      rejections: "필터별 거부된 모델",
      noneInWindow: "이 기간에 없습니다.",
      nothingDecided: "아직 결정된 것이 없습니다.",
    },
    caveat:
      "일치율은 점수가 아닙니다. ROUTE-01은 평가 세트에서 측정한 고정 모델 baseline 대비 승률로 Router를 평가합니다. 사용자를 그대로 따라 하는 Router는 매번 일치하지만 아무 가치가 없고, 사용자가 틀린 곳에서 옳은 Router는 여기서 불일치로 나타납니다. 이 수치는 Auto를 켰을 때 얼마나 바뀌는지를 측정할 뿐, 그 변화가 개선인지는 측정하지 않습니다.",
  },
});
