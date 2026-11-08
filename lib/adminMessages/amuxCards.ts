import { defineAdminMessages } from "@/lib/adminLocale";
import type { AmuxV22QuestionDm } from "@/lib/amux/v22OwnerQuestionDmCore";

export const adminAmuxCardsMessages = defineAdminMessages({
  en: {
    title: "AMUX cards",
    description:
      "Read-only list of the AMUX cards stored in Tomverse, which is where their status lives. The local AMUX board does not show these cards. The only change this screen makes is answering a worker's question, which sends its Task back to that worker.",
    shown: (shown: number, total: number, limit: number) =>
      `Showing ${shown} of ${total} cards, the ${limit} most recently updated, ordered by status.`,
    columnCard: "Card",
    sourceKey: "Source key",
    columnStatus: "Status",
    columnOwner: "Owner",
    columnPriority: "Priority",
    columnKind: "Kind",
    columnBrief: "Brief",
    columnReview: "Review",
    columnAttempts: "Attempts",
    columnUpdated: "Updated",
    resultButton: "View result",
    resultLoading: "Loading result…",
    resultMissing: "No retained result for this Task.",
    resultPurged: "Result text has expired.",
    resultUnavailable: "Result is temporarily unavailable.",
    questionTitle: (sequence: number) => `Worker question ${sequence}`,
    questionUnblocks: "Unblocks",
    questionOptions: "Options",
    questionState: (state: string) => ({ open: "Waiting for an answer",
      answered: "Answered, waiting for the worker",
      resumed: "Answered, the worker resumed",
      cancelled: "Closed without an answer (question limit, a lost run, or an answer that could not resume the Task)" }[state] ?? state),
    answerLabel: "Answer",
    answerSubmit: "Send answer and resume",
    answerSending: "Sending…",
    answerSent: "Answered. The Task is back in todo for the same worker.",
    answerFailed: (code: string) => `Answer not recorded (${code}).`,
    questionOwnerOnly: "A worker question is waiting for an answer. Only the owner can read and answer it.",
    dmTitle: "Decision Maker",
    dmProposal: "Proposed answer",
    dmRationale: "Why",
    dmIrreversible: "The Decision Maker marked this irreversible. Read it before you confirm.",
    dmConfirm: "Confirm as proposed",
    dmConfirming: "Confirming…",
    dmConfirmed: "Confirmed. The relay applies this answer on its next sync (about 30 seconds) and sends the Task back to the same worker.",
    dmOpenDetail: "Edit or reject it in the request",
    dmDirect: "Or answer yourself",
    dmReasons: {
      kill_switch_on: "the kill switch is on",
      settings_unreadable: "the switches could not be read",
      instance_off: "the Decision Maker instance is off",
      ask_type_not_allowed: "the ask type is not one the Decision Maker takes",
      irreversible_term: "the text names an irreversible action",
      resolution_not_decision_only: "it needs more than a decision",
      provider_unverified: "the asking provider is not verified",
      throughput_exceeded: "the request limit was reached",
      input_limit_exceeded: "the question is too long",
      card_secret_detected: "the text looks like it holds a secret",
    } as Record<string, string>,
    dmState: (dm: AmuxV22QuestionDm, reason: (code: string) => string) => {
      switch (dm.state) {
        case "not_sent": return {
          routing_off: "Not sent to the Decision Maker: DM routing is off (TOMVERSE_AMUX_DM_ROUTING).",
          kill_switch: "Not sent to the Decision Maker: the kill switch is on.",
          switches_unreadable: "Not sent to the Decision Maker: its switches could not be read.",
          no_provider: "Not sent to the Decision Maker: the asking run has no provider, so the relay passes this question over.",
          waiting_relay: "Not with the Decision Maker yet. The relay sends it on its next sync.",
        }[dm.reason];
        case "filed": return "Filed as a card on the AMUX host. The Decision Maker has no request for it yet.";
        case "with_operator": return `Sent to you instead of the Decision Maker: ${dm.reasons.map(reason).join(", ") || "routing rule"}.`;
        case "working": return "The Decision Maker is working on an answer.";
        case "proposal": return "The Decision Maker proposes an answer. Confirm it, or answer yourself.";
        case "cannot_answer": return `The Decision Maker said it cannot answer${dm.reason ? `: ${dm.reason}` : "."} Answer it yourself.`;
        case "failed": return `The Decision Maker gave no usable answer (${dm.status}). Answer it yourself.`;
        case "confirmed": return "You confirmed the Decision Maker's answer. The relay applies it on its next sync.";
        case "rejected": return "You rejected the Decision Maker's answer. Answer it yourself.";
        case "closed": return `The Decision Maker request was closed (${dm.status}). Answer it yourself.`;
        case "restricted": return "The Decision Maker's answer needs the ops:write permission to read.";
        case "unavailable": return "The Decision Maker state could not be read right now.";
      }
    },
    none: "-",
    briefPresent: "approved",
    briefAbsent: "none",
    reviewRequired: "required",
    pr: (value: number) => `PR ${value}`,
    lastAttempt: (outcome: string, status: string) => `${outcome} to ${status}`,
    empty: "No cards.",
  },
  ko: {
    title: "AMUX 카드",
    description:
      "Tomverse에 저장된 AMUX 카드의 읽기 전용 목록입니다. 카드 상태의 정본은 여기입니다. 로컬 AMUX Board에는 이 카드가 보이지 않습니다. 이 화면이 바꾸는 것은 워커 질문에 답하는 것 하나이고, 답하면 그 Task가 같은 워커에게 돌아갑니다.",
    shown: (shown: number, total: number, limit: number) =>
      `카드 ${total}장 가운데 최근 갱신된 ${limit}장 한도에서 ${shown}장을 상태 순으로 보여 줍니다.`,
    columnCard: "카드",
    sourceKey: "원본 키",
    columnStatus: "상태",
    columnOwner: "owner",
    columnPriority: "우선순위",
    columnKind: "종류",
    columnBrief: "brief",
    columnReview: "Review",
    columnAttempts: "실행",
    columnUpdated: "갱신",
    resultButton: "결과 보기",
    resultLoading: "결과 불러오는 중…",
    resultMissing: "보존된 Task 결과가 없습니다.",
    resultPurged: "결과 본문 보존 기간이 끝났습니다.",
    resultUnavailable: "결과를 일시적으로 불러올 수 없습니다.",
    questionTitle: (sequence: number) => `워커 질문 ${sequence}`,
    questionUnblocks: "답하면 풀리는 것",
    questionOptions: "선택지",
    questionState: (state: string) => ({ open: "답변 대기",
      answered: "답변함, 워커 재개 대기",
      resumed: "답변함, 워커가 이어서 진행",
      cancelled: "답 없이 닫힘 (질문 한도 초과, 실행 유실, 또는 Task를 재개할 수 없는 답)" }[state] ?? state),
    answerLabel: "답변",
    answerSubmit: "답변 보내고 이어서 진행",
    answerSending: "보내는 중…",
    answerSent: "답변했습니다. Task가 같은 워커의 todo로 돌아갔습니다.",
    answerFailed: (code: string) => `답변을 기록하지 못했습니다 (${code}).`,
    questionOwnerOnly: "답변을 기다리는 워커 질문이 있습니다. 질문을 읽고 답하는 것은 owner만 할 수 있습니다.",
    dmTitle: "Decision Maker 의견",
    dmProposal: "DM 제안 답",
    dmRationale: "근거",
    dmIrreversible: "DM이 되돌릴 수 없는 일로 표시했습니다. 확인하기 전에 내용을 읽어 보세요.",
    dmConfirm: "이대로 확인",
    dmConfirming: "확인하는 중…",
    dmConfirmed: "확인했어요. 릴레이가 다음 동기화(30초 안팎)에 이 답을 적용하고 Task를 같은 워커에게 돌려보냅니다.",
    dmOpenDetail: "요청에서 고쳐 확인하거나 거절하기",
    dmDirect: "또는 직접 답하기",
    dmReasons: {
      kill_switch_on: "kill switch가 켜져 있음",
      settings_unreadable: "스위치를 읽지 못함",
      instance_off: "DM 인스턴스가 꺼져 있음",
      ask_type_not_allowed: "DM이 받지 않는 질문 종류",
      irreversible_term: "되돌릴 수 없는 일을 뜻하는 단어가 있음",
      resolution_not_decision_only: "결정만으로 풀리지 않는 질문",
      provider_unverified: "검증되지 않은 provider",
      throughput_exceeded: "처리량 한도에 걸림",
      input_limit_exceeded: "질문이 너무 김",
      card_secret_detected: "비밀값으로 보이는 내용이 있음",
    } as Record<string, string>,
    dmState: (dm: AmuxV22QuestionDm, reason: (code: string) => string) => {
      switch (dm.state) {
        case "not_sent": return {
          routing_off: "DM에 전달되지 않았어요: DM 라우팅이 꺼져 있어요(TOMVERSE_AMUX_DM_ROUTING).",
          kill_switch: "DM에 전달되지 않았어요: Decision Maker kill switch가 켜져 있어요.",
          switches_unreadable: "DM에 전달되지 않았어요: Decision Maker 스위치를 읽지 못했어요.",
          no_provider: "DM에 전달되지 않았어요: 질문한 실행에 provider 기록이 없어 릴레이가 이 질문을 건너뜁니다.",
          waiting_relay: "DM에 아직 전달되지 않았어요. 릴레이가 다음 동기화에 보냅니다.",
        }[dm.reason];
        case "filed": return "AMUX 박스에 카드로 보냈어요. DM 요청은 아직 만들어지지 않았어요.";
        case "with_operator": return `DM을 거치지 않고 운영자에게 왔어요: ${dm.reasons.map(reason).join(", ") || "라우팅 규칙"}.`;
        case "working": return "DM이 답을 만들고 있어요.";
        case "proposal": return "DM이 답을 제안했어요. 이대로 확인하거나 직접 답하세요.";
        case "cannot_answer": return `DM이 답할 수 없다고 했어요${dm.reason ? `: ${dm.reason}` : "."} 직접 답해 주세요.`;
        case "failed": return `DM이 쓸 수 있는 답을 내지 못했어요(${dm.status}). 직접 답해 주세요.`;
        case "confirmed": return "DM 제안을 확인했어요. 릴레이가 다음 동기화에 답을 적용합니다.";
        case "rejected": return "DM 제안을 거절했어요. 직접 답해 주세요.";
        case "closed": return `DM 요청이 닫혔어요(${dm.status}). 직접 답해 주세요.`;
        case "restricted": return "DM 의견은 ops:write 권한이 있어야 볼 수 있어요.";
        case "unavailable": return "지금은 DM 상태를 읽지 못했어요.";
      }
    },
    none: "-",
    briefPresent: "승인됨",
    briefAbsent: "없음",
    reviewRequired: "필요",
    pr: (value: number) => `PR ${value}`,
    lastAttempt: (outcome: string, status: string) => `${outcome} → ${status}`,
    empty: "카드가 없습니다.",
  },
});
