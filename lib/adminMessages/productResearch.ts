import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the product-research observation section
 * (docs/policy/product-research-agent.md §4).
 *
 * Nothing here may read as advice. The agent copies a judgement the existing
 * backlog report already made, one row per open issue, so the section says
 * what was observed and never what to do next -- the policy's forbidden words
 * ("추천", "우선", "다음 작업", "착수", "미완료", "완료 확정") are kept out of
 * both locales, and `tests/productResearchConsoleCopy.test.mjs` fails the build
 * on them.
 *
 * The screen has no buttons: there is nothing to approve, because the agent
 * proposes nothing.
 */
export const adminProductResearchMessages = defineAdminMessages({
  en: {
    disabled:
      "The product-research agent is switched off here. Nothing is being recorded, and this is a state an operator chose.",
    anchorMissing:
      "The switch is on and this run is recording when it was first seen on. The next run judges against it.",
    noObservationYet:
      "The switch is on and no slot has been recorded yet. An empty table is not a working one.",
    silent:
      "No slot has been recorded for {hours} hours. A run that hangs stops every run after it, and the table simply stops growing.",
    recent: "Last recorded slot: {slot}.",
    showingSlots: "Showing the newest {count} scheduled slots, including the ones with no row.",
    retention: "Rows are kept for {days} days and then removed.",
    slotColumn: "Slot",
    stateColumn: "State",
    issuesColumn: "Rows",
    commitsColumn: "Commits read",
    digestColumn: "Payload digest",
    submittedColumn: "Submitted",
    latestHeading: "The newest recorded slot",
    latestEmpty: "No slot has been recorded, so there is nothing to show.",
    latestNotCurrent:
      "The slot that just passed has no recorded observation, so there is nothing to show here. An earlier slot's rows would not answer what the backlog looks like now; the table above says which slots were recorded.",
    issueColumn: "Issue",
    titleColumn: "Title",
    verdictColumn: "Source verdict",
    branchesColumn: "Branches",
    blockedOn: "The source records a blockedOn entry",
    summaryHeading: "This slot's verdict distribution",
    summaryNote:
      "Counted from the {count} rows above, for this slot alone. It is not a running total, and nothing here is a judgement about the backlog -- the verdicts carry their own meaning.",
    summaryBlindSpots:
      "Rows with no signal on either branch: {noSignal}. Rows resolved on one branch only: {oneBranch}.",
    summaryMismatch:
      "The counts stored with this slot do not match the rows stored beside them. The figures shown are recounted from the rows.",
    windowsHeading: "Phase windows, as arithmetic",
    windowsNote:
      "These are computed from the slots above and reported only. A phase transition is signed by an operator; nothing on this screen moves one.",
    p1Heading: "Staging window",
    p1Reached: "{count} of {total} consecutive clean slots.",
    p1Broken: "The count restarted at {slot} ({state}).",
    p1Met: "The window is complete.",
    p2Heading: "Production window",
    p2Counted: "{successes} recorded of the last {observed} slots; the window asks for {required} of {total}.",
    p2Insufficient: "Fewer than {total} slots exist, so this window has no answer either way.",
    p2Met: "The window is satisfied.",
    p2NotMet: "The window is not satisfied.",
    p2Duplicates: "{count} slot(s) hold more than one row, which the window does not accept at any success rate.",
  },
  ko: {
    disabled:
      "제품·리서치 Agent가 이곳에서 꺼져 있습니다. 아무것도 기록되지 않으며, 이는 운영자가 선택한 상태입니다.",
    anchorMissing:
      "스위치는 켜져 있고 이번 실행이 처음 켜진 시각을 기록하는 중입니다. 다음 실행부터 그 시각을 기준으로 판정합니다.",
    noObservationYet:
      "스위치는 켜져 있고 아직 기록된 회차가 없습니다. 빈 표는 정상 동작의 증거가 아닙니다.",
    silent:
      "{hours}시간 동안 기록된 회차가 없습니다. 멈춘 실행 하나가 이후 모든 실행을 막으며, 그때 표는 그냥 더 늘지 않습니다.",
    recent: "마지막 기록 회차: {slot}.",
    showingSlots: "예정 회차 최신 {count}건을 행이 없는 회차까지 함께 보여 줍니다.",
    retention: "행은 {days}일 보관한 뒤 삭제됩니다.",
    slotColumn: "예정 회차",
    stateColumn: "상태",
    issuesColumn: "행 수",
    commitsColumn: "읽은 commit",
    digestColumn: "payload digest",
    submittedColumn: "제출 시각",
    latestHeading: "가장 최근 기록 회차",
    latestEmpty: "기록된 회차가 없어 보여 줄 내용이 없습니다.",
    latestNotCurrent:
      "직전 예정 회차에 기록된 관측이 없어 여기에 보여 줄 내용이 없습니다. 이전 회차의 행은 지금의 backlog 상태에 대한 답이 아니며, 어떤 회차가 기록됐는지는 위 표에 있습니다.",
    issueColumn: "이슈",
    titleColumn: "제목",
    verdictColumn: "원천 판정",
    branchesColumn: "branch",
    blockedOn: "원천에 blockedOn 기록 있음",
    summaryHeading: "이 회차의 판정 분포",
    summaryNote:
      "위 {count}개 행에서 센 값이며, 이 회차만의 것입니다. 누적 합계가 아니고, 어떤 판단도 아닙니다 -- 각 판정의 뜻은 그 판정 문구가 말합니다.",
    summaryBlindSpots:
      "양쪽 branch 모두에서 신호가 없는 행: {noSignal}. 한쪽 branch에서만 충족된 행: {oneBranch}.",
    summaryMismatch:
      "이 회차에 저장된 수가 함께 저장된 행과 맞지 않습니다. 표시된 값은 행에서 다시 센 것입니다.",
    windowsHeading: "단계 창 계산값",
    windowsNote:
      "위 회차들에서 계산한 값이며 보고 전용입니다. 단계 전환은 운영자가 서명하고, 이 화면은 어떤 단계도 옮기지 않습니다.",
    p1Heading: "staging 창",
    p1Reached: "연속 정상 회차 {count}/{total}.",
    p1Broken: "{slot}에서 셈이 처음부터 다시 시작됐습니다({state}).",
    p1Met: "창 조건이 채워졌습니다.",
    p2Heading: "production 창",
    p2Counted: "최근 {observed}회차 중 기록 {successes}건이며, 창은 {total}회차 중 {required}건을 요구합니다.",
    p2Insufficient: "{total}회차가 아직 없어 이 창은 어느 쪽으로도 답이 없습니다.",
    p2Met: "창 조건이 충족됐습니다.",
    p2NotMet: "창 조건이 충족되지 않았습니다.",
    p2Duplicates: "{count}개 회차에 행이 둘 이상입니다. 기록률이 얼마든 창은 이를 받아들이지 않습니다.",
  },
});
