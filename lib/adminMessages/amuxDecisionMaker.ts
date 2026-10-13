import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for AMUX › Operations settings › Decision Maker
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

/**
 * Copy for the §4 declaration accuracy report on the same tab
 * (docs/policy/amux-decision-maker.md §4). Instance ids render as stored.
 * Nothing here names a graduation threshold: the report is a reading.
 */
export const adminAmuxDecisionMakerReportMessages = defineAdminMessages({
  en: {
    title: "Declaration accuracy report",
    description:
      "For each instance: the proposals a person decided, the days since its first proposal, the share confirmed without an edit, the share of judged declarations that matched, and how many were left not judged. Each figure is shown over its own denominator.",
    noEffect:
      "This report is only a reading. It changes no switch or mode, records no graduation and permits no answer without a person.",
    computedAt: (at: string) => `Computed at ${at} by the database clock.`,
    measure: "Measure",
    decidedProposals: "Proposals a person decided, of all proposals",
    daysSinceFirstProposal: "Days since the first proposal",
    confirmedWithoutEdit: "Confirmed without an edit, of the proposals a person decided",
    matchedOverJudged: "Declarations judged matched, of those judged matched or mismatched",
    notJudged: "Declarations left not judged, of the proposals a person decided",
    insufficientEvidence: "Insufficient evidence: the denominator is empty.",
    days: (days: number, firstAt: string) => `${days} days (first proposal ${firstAt})`,
    noProposal: "Insufficient evidence: no proposal yet.",
    unavailable:
      "The report could not be read. No figure is shown, because an unread figure is not a zero.",
  },
  ko: {
    title: "선언 정확도 보고",
    description:
      "인스턴스마다 사람이 결정한 제안 수, 첫 제안 뒤 일수, 수정 없이 확정한 비율, 판정된 선언 중 일치한 비율, 판정하지 않은 수를 보입니다. 각 수치는 자기 분모와 함께 보입니다.",
    noEffect:
      "이 보고는 읽기일 뿐입니다. 스위치나 모드를 바꾸지 않고, 졸업을 기록하지 않으며, 사람 없이 가는 답을 허락하지 않습니다.",
    computedAt: (at: string) => `DB 시계 기준 ${at}에 계산했습니다.`,
    measure: "항목",
    decidedProposals: "전체 제안 중 사람이 결정한 제안",
    daysSinceFirstProposal: "첫 제안 뒤 일수",
    confirmedWithoutEdit: "사람이 결정한 제안 중 수정 없이 확정",
    matchedOverJudged: "일치·불일치로 판정한 선언 중 일치",
    notJudged: "사람이 결정한 제안 중 선언을 판정하지 않음",
    insufficientEvidence: "근거 부족: 분모가 비어 있습니다.",
    days: (days: number, firstAt: string) => `${days}일 (첫 제안 ${firstAt})`,
    noProposal: "근거 부족: 아직 제안이 없습니다.",
    unavailable: "보고를 읽지 못했습니다. 읽지 못한 수치는 0이 아니므로 어떤 수치도 표시하지 않습니다.",
  },
});

export const adminAmuxDecisionMakerRequestsMessages = defineAdminMessages({
  en: {
    title: "Recent requests",
    description:
      "Each question a worker asked, newest first: where it was routed, how far the Decision Maker got, what it returned, what a person decided and whether the answer reached the worker.",
    noEffect: "This list only reads. Nothing on it changes a request, a switch or a card.",
    shown: (count: number, limit: number) =>
      `Showing ${count} ${count === 1 ? "request" : "requests"}: the newest, at most ${limit}. These are not totals.`,
    computedAt: (at: string) => `Read at ${at} by the database clock.`,
    empty: "No request has been recorded.",
    unavailable: "The requests could not be read. None is shown.",
    createdAt: "Asked",
    card: "Card",
    asker: "Asking worker",
    route: "Routed to",
    status: "Status",
    delivery: "Delivery",
    operator: "Operator",
    revision: (revision: number) => `revision ${revision}`,
    irreversible: "Irreversible",
    keptBecause: (codes: string) => `Kept with the operator: ${codes}`,
    statuses: {
      routed_to_operator: "With the operator",
      awaiting_assignment: "Waiting for the Decision Maker",
      assignment_expired: "Not taken in time",
      assigned: "Taken, input not sent",
      running: "Input sent, waiting for the result",
      transmit_unknown: "Input sent, outcome unknown",
      result_unknown: "Result unknown",
      proposal: "Proposal waiting for a person",
      escalate: "Handed to the operator by the Decision Maker",
      validation_failure: "Output failed validation",
      timeout: "Timed out",
      unavailable: "Decision Maker unavailable",
      confirm: "Confirmed",
      edit_confirm: "Confirmed with an edit",
      reject: "Rejected",
      assign_discarded: "Assignment discarded",
      stale_close: "Closed as stale",
    },
    deliveries: {
      not_applicable: "Nothing to deliver",
      pending: "Not yet delivered",
      in_flight: "Being delivered",
      delivered: "Delivered",
      unknown: "Delivery unknown",
      resolved_delivered: "Confirmed delivered by a person",
      resolved_not_delivered: "Confirmed not delivered by a person",
    },
  },
  ko: {
    title: "최근 요청",
    description:
      "worker가 물은 질문을 최근 것부터 보입니다. 어디로 라우팅됐는지, Decision Maker가 어디까지 처리했는지, 무엇을 돌려줬는지, 사람이 무엇을 결정했는지, 답이 worker에게 전달됐는지를 봅니다.",
    noEffect: "이 목록은 읽기만 합니다. 여기의 어떤 것도 요청·스위치·카드를 바꾸지 않습니다.",
    shown: (count: number, limit: number) => `요청 ${count}건을 보입니다. 최근 것부터 최대 ${limit}건이며 전체 수가 아닙니다.`,
    computedAt: (at: string) => `DB 시계 기준 ${at}에 읽었습니다.`,
    empty: "기록된 요청이 없습니다.",
    unavailable: "요청을 읽지 못했습니다. 아무것도 표시하지 않습니다.",
    createdAt: "질문 시각",
    card: "카드",
    asker: "묻는 worker",
    route: "라우팅",
    status: "상태",
    delivery: "전달",
    operator: "운영자",
    revision: (revision: number) => `revision ${revision}`,
    irreversible: "되돌릴 수 없음",
    keptBecause: (codes: string) => `운영자에게 둔 이유: ${codes}`,
    statuses: {
      routed_to_operator: "운영자 대기",
      awaiting_assignment: "Decision Maker 배정 대기",
      assignment_expired: "배정 마감 경과",
      assigned: "배정됨, 입력 전송 전",
      running: "입력 전송됨, 결과 대기",
      transmit_unknown: "입력 전송됨, 결과 불명",
      result_unknown: "결과 불명",
      proposal: "제안, 사람의 판정 대기",
      escalate: "Decision Maker가 운영자에게 넘김",
      validation_failure: "출력 검증 실패",
      timeout: "시간 초과",
      unavailable: "Decision Maker 사용 불가",
      confirm: "확정",
      edit_confirm: "고쳐서 확정",
      reject: "거절",
      assign_discarded: "배정 버림",
      stale_close: "기한 경과로 닫힘",
    },
    deliveries: {
      not_applicable: "전달할 것 없음",
      pending: "전달 전",
      in_flight: "전달 중",
      delivered: "전달됨",
      unknown: "전달 불명",
      resolved_delivered: "사람이 전달됨으로 확인",
      resolved_not_delivered: "사람이 전달 안 됨으로 확인",
    },
  },
});

export const adminAmuxDecisionMakerRequestDetailMessages = defineAdminMessages({
  en: {
    title: (cardId: string, revision: number) => `Request for ${cardId}, revision ${revision}`,
    back: "Back to the request list",
    notFound: "No request has this id.",
    unavailable: "The request could not be read. Nothing about it is shown.",
    bodiesRestricted:
      "The question and the Decision Maker's answer are shown only to administrators who may judge it (ops:write).",
    irreversible:
      "The Decision Maker marked this proposal irreversible. Read it with that in mind before deciding.",
    routing: "Routing",
    asker: "Asking worker",
    instance: "Decision Maker",
    status: "Status",
    delivery: "Delivery",
    question: "Question",
    askType: "Ask type",
    resolution: "Resolution",
    options: "Options",
    noOptions: "The question has no options.",
    unblocks: "Unblocks",
    context: "Context the worker wrote",
    contextPaths: "Context paths",
    noCard: "No card text is stored: the question was kept with the operator, or its text was purged or erased. Read it in AMUX.",
    proposal: "Decision Maker proposal",
    chosenOption: (id: string, label: string) => `Option ${id}: ${label}`,
    unknownOption: (id: string) => `Option ${id} (not on the card)`,
    answer: "Answer",
    rationale: "Rationale",
    escalation: "Handed to the operator, because",
    noProposal: "There is no proposal to show.",
    operatorAnswer: "The answer a person confirmed instead",
    snapshot: "Repository snapshot",
    cardOnly: "Card only: no repository snapshot was sent.",
    snapshotAt: (state: string, sha: string) => `${state} at ${sha}`,
    judgeable: "This proposal is waiting for a person's judgment.",
    notJudgeable: "There is nothing to judge on this request now.",
  },
  ko: {
    title: (cardId: string, revision: number) => `${cardId}의 요청, revision ${revision}`,
    back: "요청 목록으로 돌아가기",
    notFound: "이 id의 요청이 없습니다.",
    unavailable: "요청을 읽지 못했습니다. 이 요청에 대해 아무것도 표시하지 않습니다.",
    bodiesRestricted: "질문과 Decision Maker의 답은 판정할 수 있는 관리자(ops:write)에게만 보입니다.",
    irreversible: "Decision Maker가 이 제안을 되돌릴 수 없다고 표시했습니다. 판정 전에 이 점을 염두에 두고 읽으세요.",
    routing: "라우팅",
    asker: "묻는 worker",
    instance: "Decision Maker",
    status: "상태",
    delivery: "전달",
    question: "질문",
    askType: "질문 유형",
    resolution: "resolution",
    options: "선택지",
    noOptions: "선택지가 없는 질문입니다.",
    unblocks: "해제 조건",
    context: "worker가 적은 맥락",
    contextPaths: "맥락 경로",
    noCard: "저장된 카드 본문이 없습니다. 운영자에게 둔 질문이거나 본문이 기한 삭제·삭제 요청으로 지워졌습니다. AMUX에서 읽으세요.",
    proposal: "Decision Maker 제안",
    chosenOption: (id: string, label: string) => `선택지 ${id}: ${label}`,
    unknownOption: (id: string) => `선택지 ${id} (카드에 없음)`,
    answer: "답",
    rationale: "근거",
    escalation: "운영자에게 넘긴 이유",
    noProposal: "보일 제안이 없습니다.",
    operatorAnswer: "사람이 대신 확정한 답",
    snapshot: "저장소 스냅샷",
    cardOnly: "카드만: 저장소 스냅샷을 보내지 않았습니다.",
    snapshotAt: (state: string, sha: string) => `${state}, ${sha}`,
    judgeable: "이 제안은 사람의 판정을 기다립니다.",
    notJudgeable: "이 요청에는 지금 판정할 것이 없습니다.",
  },
});

export const adminAmuxDecisionMakerJudgmentMessages = defineAdminMessages({
  en: {
    title: "Judgment",
    description:
      "Confirm the proposal as it is, confirm an answer you write instead, or reject it and answer the worker yourself in AMUX. Nothing reaches the worker before a confirmed answer is delivered.",
    notApproval:
      "A confirmed answer answers the worker's question. It is not an approval under the agent approval contract; a gate that needs a person is asked for separately.",
    irreversible: "This proposal is marked irreversible.",
    accuracyLegend: "Were the worker's declarations accurate?",
    accuracies: {
      not_judged: "Not judged",
      matched: "Matched",
      mismatched: "Mismatched",
    },
    itemsLegend: "What was wrong",
    items: {
      effect_class: "Effect class",
      resolution: "Resolution",
      paths: "Paths",
    },
    itemsRequired: "Choose at least one item that was wrong.",
    answerLabel: "Your answer",
    answerBytes: (bytes: number) => `${bytes.toLocaleString("en")} of 8,192 bytes`,
    answerTooLong: "The answer is longer than 8,192 bytes.",
    answerRequired: "Write the answer to confirm instead.",
    confirm: "Confirm as proposed",
    editConfirm: "Confirm my answer instead",
    reject: "Reject",
    sending: "Sending the judgment…",
    recorded: {
      confirm: "Confirmed. The request is closed; the answer is delivered by the delivery path.",
      edit_confirm: "Your answer is confirmed. The request is closed; the answer is delivered by the delivery path.",
      reject: "Rejected. The request is closed; answer the worker in AMUX.",
    },
    refused: {
      not_routed_to_dm: "This question was not routed to the Decision Maker.",
      closed: "This request is already closed.",
      no_proposal: "This request has no proposal to judge.",
      settings_unreadable: "The switches could not be read, so nothing was recorded.",
      kill_switch_on: "The kill switch is on: a proposal cannot be confirmed now. Rejecting it is still possible.",
      proposal_detail_missing: "The proposal's detail is missing, so nothing was recorded.",
      operator_answer_present: "This request already holds a person's answer.",
      shown_mismatch: "The proposal is not what this page showed. Reload it before judging.",
      digest_key_unavailable: "The key for this request's period is not available, so an edited answer cannot be stored.",
      operator_answer_refused: "Your answer was refused before anything was stored.",
      unknown_request: "No request has this id.",
    },
    bodyRefusals: {
      unknown_field: "It is not a field that can be stored.",
      empty: "It is empty.",
      not_well_formed: "It is not well-formed text.",
      too_long: "It is longer than 8,192 bytes.",
      secret_detected: "It looks like it holds a secret.",
      request_too_long: "The request's stored texts would exceed 40 KiB.",
    },
    unknown:
      "The outcome is not known. Do not send it again: reload this request to see whether it was recorded.",
    failed: "The judgment was not recorded.",
    reload: "Reload this request",
  },
  ko: {
    title: "판정",
    description:
      "제안을 그대로 확정하거나, 직접 쓴 답으로 고쳐서 확정하거나, 거절하고 AMUX에서 worker에게 직접 답합니다. 확정된 답이 전달되기 전에는 아무것도 worker에게 가지 않습니다.",
    notApproval:
      "확정한 답은 worker의 질문에 대한 답입니다. 승인 계약의 승인이 아니며, 사람의 승인이 필요한 게이트는 따로 요청합니다.",
    irreversible: "이 제안은 되돌릴 수 없다고 표시돼 있습니다.",
    accuracyLegend: "worker의 선언이 정확했습니까?",
    accuracies: {
      not_judged: "판정하지 않음",
      matched: "일치",
      mismatched: "불일치",
    },
    itemsLegend: "틀린 항목",
    items: {
      effect_class: "효과 등급",
      resolution: "resolution",
      paths: "경로",
    },
    itemsRequired: "틀린 항목을 하나 이상 고르세요.",
    answerLabel: "직접 쓴 답",
    answerBytes: (bytes: number) => `${bytes.toLocaleString("ko")} / 8,192바이트`,
    answerTooLong: "답이 8,192바이트보다 깁니다.",
    answerRequired: "고쳐서 확정할 답을 쓰세요.",
    confirm: "그대로 확정",
    editConfirm: "내 답으로 고쳐서 확정",
    reject: "거절",
    sending: "판정을 보내는 중…",
    recorded: {
      confirm: "확정했습니다. 요청이 닫혔고, 답은 전달 경로가 worker에게 전합니다.",
      edit_confirm: "직접 쓴 답으로 확정했습니다. 요청이 닫혔고, 답은 전달 경로가 worker에게 전합니다.",
      reject: "거절했습니다. 요청이 닫혔습니다. AMUX에서 worker에게 답하세요.",
    },
    refused: {
      not_routed_to_dm: "이 질문은 Decision Maker로 라우팅되지 않았습니다.",
      closed: "이미 닫힌 요청입니다.",
      no_proposal: "판정할 제안이 없는 요청입니다.",
      settings_unreadable: "스위치를 읽지 못해 아무것도 기록하지 않았습니다.",
      kill_switch_on: "kill switch가 켜져 있어 지금은 확정할 수 없습니다. 거절은 할 수 있습니다.",
      proposal_detail_missing: "제안의 상세가 없어 아무것도 기록하지 않았습니다.",
      operator_answer_present: "이 요청에는 이미 사람의 답이 있습니다.",
      shown_mismatch: "제안이 이 화면이 보인 것과 다릅니다. 다시 읽은 뒤 판정하세요.",
      digest_key_unavailable: "이 요청 기간의 키가 없어 고친 답을 저장할 수 없습니다.",
      operator_answer_refused: "직접 쓴 답이 저장 전에 거절됐습니다.",
      unknown_request: "이 id의 요청이 없습니다.",
    },
    bodyRefusals: {
      unknown_field: "저장할 수 있는 항목이 아닙니다.",
      empty: "비어 있습니다.",
      not_well_formed: "올바른 텍스트가 아닙니다.",
      too_long: "8,192바이트보다 깁니다.",
      secret_detected: "비밀값이 들어 있는 것으로 보입니다.",
      request_too_long: "요청의 저장 텍스트 합계가 40 KiB를 넘습니다.",
    },
    unknown: "결과를 모릅니다. 다시 보내지 마세요. 이 요청을 다시 읽어 기록됐는지 확인하세요.",
    failed: "판정을 기록하지 못했습니다.",
    reload: "이 요청 다시 읽기",
  },
});
