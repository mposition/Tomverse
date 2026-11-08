import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the Development screens redesigned on 2026-11-07: Ideas (the
 * five-step bar, the card list), the Execution board, Release › QA, and the
 * legacy-tools intro. The worker cards and the halt card keep their copy in
 * their own catalogues (`amuxWorkers`, `amuxOrchestratorHalts`), because their
 * views take that catalogue as a prop.
 *
 * Worker names, card numbers, channel names (Claude, Codex, Copilot, Cursor),
 * kinds, priorities and statuses an unknown value falls back to are
 * identifiers and render as stored.
 */
export const adminAmuxScreensMessages = defineAdminMessages({
  en: {
    ideas: {
      cardHint: "One sentence is enough. AMUX sorts out the scope and the expected cost.",
      listLede: "Ideas that wait for you come first. Open one to decide.",
      flow: {
        label: "Idea progress",
        steps: {
          idea: "Idea",
          execution_approval: "Execution approval",
          plan_approval: "Plan approval",
          execution: "Run",
          pr: "PR",
        },
        states: { done: "done", current: "now", attention: "stopped here", todo: "not yet" },
      },
      budget: {
        label: "This month's analysis budget",
        loading: "Reading the analysis budget…",
        reauthenticate: "Sign in again to see this month's analysis budget.",
        signIn: "Sign in again",
        unavailable: "The analysis budget could not be read. Nothing was changed.",
        amounts: (used: string, limit: string) => `US$ ${used} / ${limit}`,
      },
    },
    cards: {
      counts: { all: "All cards", waiting: "Waiting", running: "Running", review: "In review", done: "Done" },
      columns: { kind: "Kind", priority: "Priority", status: "State" },
      status: { waiting: "Waiting", running: "Running", review: "In review", done: "Done", blocked: "Blocked", cancelled: "Cancelled" },
      notInNewest: "-",
      notInNewestHint: "This card is older than the newest cards read for the counts, so its state is not shown here.",
      bounded: (shown: number, total: number) =>
        `The state counts and each card's kind, priority and state come from the ${shown} most recently changed of ${total} cards.`,
    },
    board: {
      channels: "Channels",
      sinceChange: "Time since this card last changed",
      openSafety: "Open Safety & recovery",
      columns: {
        waiting: "Waiting",
        approval: "Waiting on you",
        running: "Running",
        review: "In review",
        done: "Done",
      },
      doneHint: "Recently merged by the idea lane. Older finished cards are in the history below.",
      diagnostics: {
        title: "Diagnostics are coming",
        detail: "Until this screen is built, the worker report and the assignment evidence are in the review queue.",
        link: "Open the review queue",
      },
    },
    release: {
      avatar: "QA and release agent",
      next: "Next train",
      noSchedule: "No departure times",
      scheduleUnread: "The train schedule could not be read.",
      scheduleDefault: "The train service has not reported its schedule yet, so these are the default departure hours.",
      remaining: (hours: number, minutes: number) => `${hours} h ${minutes} min left (AEST)`,
      remainingMinutes: (minutes: number) => `${minutes} min left (AEST)`,
      mergeTrainNote:
        "A train gathers the picked pull requests and opens one release/train pull request into main. An operator merges it with merge-train.",
      routeTitle: "Today's trains",
      admissionsUnread: "Which trains left could not be read, so none is shown as departed.",
      stops: { departed: "Left", missed: "No train", next: "Next", upcoming: "Later" },
      gap: {
        label: "Production vs main",
        same: "Same as main",
        behind: "Behind main",
        unknown: "Not known",
      },
      riding: {
        label: "Riding the next train",
        detail: "Picked develop pull requests",
        emergency: (count: number) => `An emergency train waits with ${count}`,
      },
      openMain: { label: "Open pull requests into main", detail: "Waiting for a person to merge" },
      cargo: {
        title: "Pull requests on the next train",
        titleAt: (time: string) => `Pull requests on the ${time} train`,
        lede: "Merged develop pull requests picked for the next departure.",
        pick: "Pick pull requests",
        unread: "The picked pull requests could not be read.",
        empty: "No pull request is picked yet",
        emptyDetail: "Pick the develop pull requests that are ready in the train view; the next train carries them.",
        untitled: "Open on GitHub",
      },
    },
    safety: {
      legacyTitle: "Old tools",
    },
  },
  ko: {
    ideas: {
      cardHint: "한두 문장이면 충분해요. AMUX가 범위와 예상 비용을 정리해서 보여 드려요.",
      listLede: "정할 일이 있는 아이디어부터 보여 드려요. 열어서 정해 주세요.",
      flow: {
        label: "아이디어 진행",
        steps: {
          idea: "아이디어",
          execution_approval: "실행 승인",
          plan_approval: "계획 승인",
          execution: "실행",
          pr: "PR",
        },
        states: { done: "끝남", current: "지금", attention: "여기서 멈춤", todo: "아직" },
      },
      budget: {
        label: "이번 달 분석 예산",
        loading: "분석 예산을 읽는 중…",
        reauthenticate: "이번 달 분석 예산을 보려면 다시 로그인해 주세요.",
        signIn: "다시 로그인",
        unavailable: "분석 예산을 읽지 못했어요. 바뀐 것은 없어요.",
        amounts: (used: string, limit: string) => `US$ ${used} / ${limit}`,
      },
    },
    cards: {
      counts: { all: "전체", waiting: "대기", running: "실행 중", review: "검토 중", done: "완료" },
      columns: { kind: "종류", priority: "우선순위", status: "상태" },
      status: { waiting: "대기", running: "실행 중", review: "검토 중", done: "완료", blocked: "막힘", cancelled: "취소" },
      notInNewest: "-",
      notInNewestHint: "숫자를 읽은 최근 카드보다 오래된 카드라서 상태를 여기서 보여 드리지 않아요.",
      bounded: (shown: number, total: number) =>
        `상태별 숫자와 카드별 종류·우선순위·상태는 전체 ${total}장 중 최근에 바뀐 ${shown}장을 읽은 값이에요.`,
    },
    board: {
      channels: "채널",
      sinceChange: "이 카드가 마지막으로 바뀐 뒤 지난 시간",
      openSafety: "안전·복구에서 보기",
      columns: {
        waiting: "대기",
        approval: "내 확인 대기",
        running: "실행 중",
        review: "검토 중",
        done: "완료",
      },
      doneHint: "아이디어 레인이 최근 병합한 카드예요. 더 오래된 완료 카드는 아래 이력에 있어요.",
      diagnostics: {
        title: "진단은 준비 중이에요",
        detail: "이 화면이 만들어지기 전까지 워커 보고와 배정 근거는 검토 큐에 있어요.",
        link: "검토 큐 열기",
      },
    },
    release: {
      avatar: "QA·릴리스 에이전트",
      next: "다음 열차",
      noSchedule: "출발 시각이 없어요",
      scheduleUnread: "열차 시각표를 읽지 못했어요.",
      scheduleDefault: "열차 서비스가 아직 시각표를 알려 주지 않아서 기본 출발 시각을 보여 드려요.",
      remaining: (hours: number, minutes: number) => `${hours}시간 ${minutes}분 남았어요 (AEST)`,
      remainingMinutes: (minutes: number) => `${minutes}분 남았어요 (AEST)`,
      mergeTrainNote:
        "열차는 고른 PR을 모아 release/train main PR 하나를 열어요. 병합은 운영자가 merge-train으로 해요.",
      routeTitle: "오늘의 열차",
      admissionsUnread: "어느 열차가 떠났는지 읽지 못해서 떠난 열차로 표시하지 않았어요.",
      stops: { departed: "출발", missed: "열차 없음", next: "다음", upcoming: "예정" },
      gap: {
        label: "운영과 main 차이",
        same: "main과 같아요",
        behind: "main보다 뒤예요",
        unknown: "알 수 없어요",
      },
      riding: {
        label: "다음 열차에 탈 PR",
        detail: "고른 develop PR",
        emergency: (count: number) => `긴급 열차가 ${count}건으로 기다려요`,
      },
      openMain: { label: "main으로 열린 PR", detail: "사람이 병합하기를 기다려요" },
      cargo: {
        title: "다음 열차에 탈 PR",
        titleAt: (time: string) => `${time} 열차에 탈 PR`,
        lede: "다음 출발에 싣기로 고른, 병합된 develop PR이에요.",
        pick: "PR 고르기",
        unread: "고른 PR을 읽지 못했어요.",
        empty: "아직 고른 PR이 없어요",
        emptyDetail: "열차 보기에서 준비된 develop PR을 고르면 다음 열차가 실어 가요.",
        untitled: "GitHub에서 열기",
      },
    },
    safety: {
      legacyTitle: "예전 도구",
    },
  },
});
