import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for AMUX › Execution › Halts (orchestration policy version 20,
 * section 7). Reason codes, call kinds, receipt kinds, resolutions and ids are
 * identifiers and render as stored.
 */
export const adminAmuxOrchestratorHaltsMessages = defineAdminMessages({
  en: {
    title: "Orchestrator halts",
    description:
      "While a halt is open the AMUX Orchestrator claims, recovers and promotes nothing. Only a person clears a halt. Clearing it does not run the original claim, recovery or promotion again: read the receipts below and confirm what happened before you clear.",
    openShown: (shown: number, total: number, limit: number) =>
      `Open halts: ${total}. Showing ${shown}, at most the ${limit} most recently opened.`,
    clearedShown: (shown: number, total: number, limit: number) =>
      `Cleared halts: ${total}. Showing ${shown}, at most the ${limit} most recently cleared.`,
    humanShown: (shown: number, total: number, limit: number) =>
      `Writes a person has to confirm: ${total}. Showing ${shown}, at most ${limit}. Each committed a change and never got an acknowledged answer.`,
    openTitle: "Open halts",
    clearedTitle: "Recently cleared",
    humanTitle: "Writes to confirm",
    noOpen: "No open halt.",
    noCleared: "No cleared halt.",
    noHuman: "No write is waiting for a person.",
    haltId: "Halt",
    haltKey: "Halt key",
    reason: "Reason",
    request: "Request",
    openedAt: "Opened",
    clearedAt: "Cleared",
    none: "-",
    write: (callKind: string, receiptCount: number) =>
      `${callKind} · ${receiptCount} receipt(s)`,
    writeTimes: (admittedAt: string, deadlineAt: string) =>
      `Admitted ${admittedAt}, deadline ${deadlineAt}`,
    writeClosed: (resolution: string, resolvedAt: string) =>
      `Resolved ${resolution} at ${resolvedAt}`,
    writeAcked: (ackedAt: string) => `Acknowledged at ${ackedAt}`,
    writeUnsettled: "Neither acknowledged nor resolved.",
    writeMissing:
      "No admission row for this request: it never reached the server, or the server could not record it.",
    receiptsTitle: "Receipts",
    receiptsShown: (shown: number, total: number) =>
      `Showing ${shown} of ${total} receipt(s).`,
    receipt: (kind: string, rowCount: number) => `${kind} · ${rowCount} row(s)`,
    receiptLink: "Open section",
    clearLabel: "First 8 characters of the halt key",
    clear: "Clear halt",
    clearing: "Clearing…",
    cleared: "Halt cleared.",
    clearOwnerOnly: "Only the owner can clear a halt.",
    clearFailed: "The halt was not cleared.",
    clearRefusals: {
      not_found: "That halt no longer exists.",
      already_cleared: "That halt was already cleared.",
      halt_key_mismatch: "The characters do not match the start of the halt key.",
    },
  },
  ko: {
    title: "Orchestrator 정지",
    description:
      "정지가 열려 있는 동안 AMUX Orchestrator는 claim, recover, 자동 승격을 하지 않습니다. 정지는 사람만 해제합니다. 해제는 원래의 claim, 회수, 승격을 다시 실행하지 않습니다. 해제하기 전에 아래 영수증을 읽고 무엇이 일어났는지 확인하세요.",
    openShown: (shown: number, total: number, limit: number) =>
      `열린 정지 ${total}건. 최근에 열린 ${limit}건 한도에서 ${shown}건을 보여 줍니다.`,
    clearedShown: (shown: number, total: number, limit: number) =>
      `해제된 정지 ${total}건. 최근에 해제된 ${limit}건 한도에서 ${shown}건을 보여 줍니다.`,
    humanShown: (shown: number, total: number, limit: number) =>
      `사람 확인이 필요한 쓰기 ${total}건. ${limit}건 한도에서 ${shown}건을 보여 줍니다. 모두 변경을 커밋했고 ack된 답을 받지 못했습니다.`,
    openTitle: "열린 정지",
    clearedTitle: "최근 해제",
    humanTitle: "확인할 쓰기",
    noOpen: "열린 정지가 없습니다.",
    noCleared: "해제된 정지가 없습니다.",
    noHuman: "사람을 기다리는 쓰기가 없습니다.",
    haltId: "정지",
    haltKey: "정지 키",
    reason: "사유",
    request: "요청",
    openedAt: "열린 시각",
    clearedAt: "해제 시각",
    none: "-",
    write: (callKind: string, receiptCount: number) =>
      `${callKind} · 영수증 ${receiptCount}건`,
    writeTimes: (admittedAt: string, deadlineAt: string) =>
      `접수 ${admittedAt}, 기한 ${deadlineAt}`,
    writeClosed: (resolution: string, resolvedAt: string) =>
      `${resolvedAt}에 ${resolution}으로 해결`,
    writeAcked: (ackedAt: string) => `${ackedAt}에 ack`,
    writeUnsettled: "ack도 해결도 되지 않았습니다.",
    writeMissing:
      "이 요청의 접수 행이 없습니다. 요청이 서버에 닿지 않았거나 서버가 기록하지 못했습니다.",
    receiptsTitle: "영수증",
    receiptsShown: (shown: number, total: number) =>
      `영수증 ${total}건 가운데 ${shown}건을 보여 줍니다.`,
    receipt: (kind: string, rowCount: number) => `${kind} · ${rowCount}행`,
    receiptLink: "해당 화면 열기",
    clearLabel: "정지 키의 앞 8자",
    clear: "정지 해제",
    clearing: "해제 중…",
    cleared: "정지를 해제했습니다.",
    clearOwnerOnly: "정지는 owner만 해제할 수 있습니다.",
    clearFailed: "정지를 해제하지 못했습니다.",
    clearRefusals: {
      not_found: "그 정지는 더 이상 없습니다.",
      already_cleared: "그 정지는 이미 해제됐습니다.",
      halt_key_mismatch: "입력한 문자가 정지 키의 앞부분과 다릅니다.",
    },
  },
});
