import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the emergency revocation control (`AdminMemoryRevocationPanel`):
 * docs/policy/external-conversation-import-and-memory.md §12.1, with enabling
 * left to that document's §12.4 human procedure.
 */
export const adminMemoryRevocationMessages = defineAdminMessages({
  en: {
    state: {
      none: "Nothing is revoked. Every approved pair may run.",
      stoppedByOperator: "All extraction is stopped by an operator. No pair may run.",
      malformed:
        "The stored revocation list is unreadable, so every pair is treated as revoked. No pair may run until it is rewritten.",
      revoked: (count: number) =>
        `${count} pair(s) revoked. They cannot run; other approved pairs can.`,
    },
    badge: "Emergency revocation",
    title: "Stop an extraction pair without a deploy",
    description:
      "Revocation takes effect on the next extraction and on the next injected memory — there is no cache to wait out. It only ever restricts: enabling memory is the §12.4 human procedure and is deliberately not on this screen.",
    refresh: "Refresh",
    registeredPairs: "Registered pairs",
    registerEmpty: "The register lists no pairs.",
    otherPairs: "Other pairs, one per line",
    otherPairsHelp:
      "For a pair the register no longer lists. A label that is not registered is saved and reported back, not refused.",
    reason: "Reason (recorded in the audit log)",
    readOnly:
      "Your admin role can read this but not change it. Revocation needs the ops write permission.",
    clearAll: "Clear all revocations",
    revokePairs: (count: number) => `Revoke ${count} pair(s)`,
    stopAll: "Stop all extraction",
    reasonRequired: "A reason is required before either action is available.",
    error: {
      loadFailed: "Failed to load extraction revocations.",
      saveFailed: "The revocation could not be saved. Nothing changed.",
    },
    toast: {
      savedWithUnknown: (count: number, labels: string) =>
        `Saved. ${count} label(s) are not in the register: ${labels}. Check them if that was not deliberate.`,
      saved: "Saved. The next extraction reads this immediately.",
    },
  },
  ko: {
    state: {
      none: "철회된 pair가 없습니다. 승인된 모든 pair가 실행될 수 있습니다.",
      stoppedByOperator: "운영자가 모든 추출을 중지했습니다. 어떤 pair도 실행될 수 없습니다.",
      malformed:
        "저장된 철회 목록을 읽을 수 없어 모든 pair를 철회된 것으로 처리합니다. 목록을 다시 쓰기 전까지 어떤 pair도 실행될 수 없습니다.",
      revoked: (count: number) =>
        `pair ${count}개가 철회되었습니다. 이 pair는 실행될 수 없고, 승인된 다른 pair는 실행될 수 있습니다.`,
    },
    badge: "긴급 철회",
    title: "배포 없이 추출 pair 중지",
    description:
      "철회는 다음 추출과 다음에 주입되는 메모리부터 적용되며, 기다려야 할 cache가 없습니다. 이 화면은 제한만 합니다. 메모리 활성화는 §12.4의 사람 절차이며 의도적으로 이 화면에 두지 않았습니다.",
    refresh: "새로고침",
    registeredPairs: "등록된 pair",
    registerEmpty: "레지스트리에 등록된 pair가 없습니다.",
    otherPairs: "기타 pair (한 줄에 하나씩)",
    otherPairsHelp:
      "레지스트리에 더 이상 없는 pair를 위한 입력입니다. 등록되지 않은 label은 거부되지 않고, 저장된 뒤 응답으로 보고됩니다.",
    reason: "사유 (감사 로그에 기록됨)",
    readOnly:
      "현재 관리자 역할은 이 화면을 읽을 수만 있고 변경할 수 없습니다. 철회에는 ops 쓰기 권한이 필요합니다.",
    clearAll: "모든 철회 해제",
    revokePairs: (count: number) => `pair ${count}개 철회`,
    stopAll: "모든 추출 중지",
    reasonRequired: "두 작업 모두 사유를 입력해야 사용할 수 있습니다.",
    error: {
      loadFailed: "추출 철회 목록을 불러오지 못했습니다.",
      saveFailed: "철회를 저장하지 못했습니다. 아무것도 바뀌지 않았습니다.",
    },
    toast: {
      savedWithUnknown: (count: number, labels: string) =>
        `저장했습니다. label ${count}개가 레지스트리에 없습니다: ${labels}. 의도한 것이 아니라면 확인하세요.`,
      saved: "저장했습니다. 다음 추출부터 바로 반영됩니다.",
    },
  },
});
