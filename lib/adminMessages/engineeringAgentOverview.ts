import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the engineering agent's page head and Overview tab. */
export const adminEngineeringAgentOverviewMessages = defineAdminMessages({
  en: {
    name: "Engineering team",
    description: "Takes AMUX cards and opens pull requests that fix them. A person always does the merge.",
    statusFrozen: "Frozen",
    metaBranch: "develop branch",
    metaLastRun: (time: string) => `Last run ended ${time}`,
    metaNoRun: "No run has ended yet",
    readFailed: "This part could not be read. Nothing is shown rather than a guess; reload to try again.",
    kpi: {
      openPrs: "Open pull requests",
      openPrsDetail: (ready: number) =>
        ready === 0 ? "None is waiting for you to check." : `${ready} only wait for a person to check and merge.`,
      activeRuns: "Runs in progress",
      activeRunsDetail: (since: string) => `Earliest started ${since}`,
      activeRunsNone: "No run is in progress.",
      decisions: "Decisions waiting",
      decisionsDetail: (t2: number, decision: number, mismatch: number) =>
        `${t2} draft, ${decision} notice, ${mismatch} state mismatch`,
      rejected: "Drafts a person sent back",
      rejectedDetail: "Last 30 days",
    },
    prs: {
      title: "Pull requests in progress",
      description: "The ones that only wait for a person come first. The agent never merges.",
      all: "Open the full record",
      run: (id: string) => `Run ${id}`,
      opened: (time: string) => `Opened ${time}`,
      empty: "The agent has not opened a pull request that is still current.",
      kind: {
        ready: "Check before merging",
        waiting: "Waiting for approval",
        merged: "Merged",
        closed: "Closed",
      },
      readyHint: "Required checks passed and it was approved. Merging is a person's step.",
      waitingHint: "Not approved yet.",
      mergedHint: "A person merged it.",
      closedHint: "Closed without a merge.",
      check: "Check it",
    },
    times: {
      title: "Time from a run's start to its pull request",
      description: (n: number) => `The newest ${n} runs that opened one, oldest first. Minutes.`,
      latest: (minutes: number) => `Latest: ${minutes} min`,
      unit: "min",
    },
  },
  ko: {
    name: "엔지니어링 팀",
    description: "AMUX 카드를 맡아 고치는 PR을 만들어요. 병합은 늘 사람이 해요.",
    statusFrozen: "동결됨",
    metaBranch: "develop 브랜치",
    metaLastRun: (time: string) => `마지막 실행 ${time}에 끝났어요`,
    metaNoRun: "끝난 실행이 아직 없어요",
    readFailed: "이 부분을 읽지 못했어요. 추측으로 채우지 않고 비워 둬요. 새로고침해서 다시 시도해 주세요.",
    kpi: {
      openPrs: "열린 PR",
      openPrsDetail: (ready: number) =>
        ready === 0 ? "확인만 남은 PR은 없어요." : `${ready}건은 사람이 확인하고 병합하는 일만 남았어요.`,
      activeRuns: "진행 중인 실행",
      activeRunsDetail: (since: string) => `가장 이른 실행이 ${since}에 시작했어요`,
      activeRunsNone: "진행 중인 실행이 없어요.",
      decisions: "결정 대기",
      decisionsDetail: (t2: number, decision: number, mismatch: number) =>
        `초안 ${t2}건, 알림 ${decision}건, 상태 불일치 ${mismatch}건`,
      rejected: "사람이 반려한 초안",
      rejectedDetail: "최근 30일",
    },
    prs: {
      title: "진행 중인 PR",
      description: "사람만 기다리는 것이 먼저 나와요. 에이전트는 병합하지 않아요.",
      all: "전체 기록 열기",
      run: (id: string) => `실행 ${id}`,
      opened: (time: string) => `${time}에 열었어요`,
      empty: "지금 유효한 PR이 없어요.",
      kind: {
        ready: "병합 전에 확인하세요",
        waiting: "승인을 기다려요",
        merged: "병합됨",
        closed: "닫힘",
      },
      readyHint: "필수 검사를 통과했고 승인됐어요. 병합은 사람이 해요.",
      waitingHint: "아직 승인되지 않았어요.",
      mergedHint: "사람이 병합했어요.",
      closedHint: "병합 없이 닫혔어요.",
      check: "확인하기",
    },
    times: {
      title: "실행 시작에서 PR까지 걸린 시간",
      description: (n: number) => `PR을 연 최근 실행 ${n}번, 오래된 것부터예요. 단위는 분이에요.`,
      latest: (minutes: number) => `가장 최근 ${minutes}분`,
      unit: "분",
    },
  },
});
