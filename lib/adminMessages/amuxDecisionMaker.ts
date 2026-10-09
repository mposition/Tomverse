import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for AMUX › Execution › Decision Maker
 * (docs/policy/amux-decision-maker.md §6, §8). Scope ids and switch values
 * are identifiers and render as stored beside their sentence.
 */
export const adminAmuxDecisionMakerMessages = defineAdminMessages({
  en: {
    title: "Decision Maker switches",
    description:
      "Policy version 1 is proposal-only: a Decision Maker drafts an answer, and nothing reaches a worker until a person confirms it here in Admin. These switches decide only whether a question may be routed to a Decision Maker. Until the bridge path exists (stage S2), no question is routed, whatever they show.",
    killSwitch: "Kill switch",
    killSwitchHelp:
      "On stops the whole Decision Maker path: no routing, no process start, no confirmation. Reading records, rejecting a proposal and answering a worker yourself stay open.",
    instance: "Instance",
    instanceHelp:
      "Each instance answers the other vendor's workers. Off takes no new question; proposal may receive one and draft an answer for a person to confirm.",
    value: {
      on: "On",
      off: "Off",
      proposal: "Proposal",
    },
    unreadable: "Unreadable. Every question goes to the operator until it can be read.",
    stateUnavailable:
      "The switch state could not be read. While it cannot be read, every question goes to the operator.",
    setKillSwitch: { on: "Turn the kill switch on", off: "Turn the kill switch off" },
    setInstance: { proposal: "Set to proposal", off: "Set to off" },
    saving: "Saving…",
    saved: "Saved. The state below was read again.",
    savedUnread:
      "Saved, but the state could not be read again, so none is shown. Read it again before you change anything.",
    reread: "Read the state again",
    reading: "Reading…",
    rereadFailed:
      "The state could not be read again after the last change, so none is shown. Read it again before you change anything.",
    readOnly:
      "Changing a switch needs the owner or ops role and a recent sign-in. You can read the state.",
    outcomeUnknown:
      "The change may or may not have been recorded. The state below was read again: check it before you change anything.",
    outcomeUnknownUnread:
      "The change may or may not have been recorded, and the state could not be read again. Read it again before you change anything.",
    invalidChange: "That value is not allowed for this switch.",
    changeFailed: "The switch was not changed.",
  },
  ko: {
    title: "Decision Maker 스위치",
    description:
      "정책 1판은 제안 전용입니다. Decision Maker가 답을 제안해도 사람이 이 Admin에서 확정하기 전에는 worker에게 아무것도 가지 않습니다. 이 스위치는 질문을 Decision Maker에게 보낼 수 있는지만 정합니다. bridge 경로(S2 단계)가 생기기 전에는 여기 표시와 상관없이 어떤 질문도 Decision Maker에게 가지 않습니다.",
    killSwitch: "Kill switch",
    killSwitchHelp:
      "켜면 Decision Maker 경로 전체가 멈춥니다. 라우팅, 프로세스 시작, 확정이 모두 거부됩니다. 기록 열람, 제안 거절, worker에게 직접 답하기는 그대로 됩니다.",
    instance: "인스턴스",
    instanceHelp:
      "각 인스턴스는 다른 공급사의 worker 질문에 답합니다. off는 새 질문을 받지 않고, proposal은 질문을 받아 사람이 확정할 답을 제안할 수 있습니다.",
    value: {
      on: "켜짐",
      off: "꺼짐",
      proposal: "제안",
    },
    unreadable: "읽을 수 없음. 읽을 수 있을 때까지 모든 질문은 운영자에게 갑니다.",
    stateUnavailable:
      "스위치 상태를 읽지 못했습니다. 읽지 못하는 동안 모든 질문은 운영자에게 갑니다.",
    setKillSwitch: { on: "Kill switch 켜기", off: "Kill switch 끄기" },
    setInstance: { proposal: "proposal로 바꾸기", off: "off로 바꾸기" },
    saving: "저장 중…",
    saved: "저장했습니다. 아래 상태를 다시 읽었습니다.",
    savedUnread:
      "저장했지만 상태를 다시 읽지 못해 표시하지 않습니다. 다른 것을 바꾸기 전에 다시 읽으세요.",
    reread: "상태 다시 읽기",
    reading: "읽는 중…",
    rereadFailed:
      "마지막 변경 뒤 상태를 다시 읽지 못해 표시하지 않습니다. 다른 것을 바꾸기 전에 다시 읽으세요.",
    readOnly: "스위치를 바꾸려면 owner나 ops 역할과 최근 로그인이 필요합니다. 상태는 볼 수 있습니다.",
    outcomeUnknown:
      "변경이 기록됐는지 알 수 없습니다. 아래 상태를 다시 읽었으니, 다른 것을 바꾸기 전에 확인하세요.",
    outcomeUnknownUnread:
      "변경이 기록됐는지 알 수 없고, 상태도 다시 읽지 못했습니다. 다른 것을 바꾸기 전에 다시 읽으세요.",
    invalidChange: "이 스위치에 허용되지 않는 값입니다.",
    changeFailed: "스위치를 바꾸지 못했습니다.",
  },
});
