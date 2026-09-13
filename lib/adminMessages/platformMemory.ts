import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * The account memory (Release B) card on the platform settings screen.
 *
 * Its own catalog because its copy cites
 * docs/policy/external-conversation-import-and-memory.md by section -- the
 * §12.4 human procedure for enabling the flags and §12.1 emergency pair
 * revocation -- and the platform settings catalog names other policy documents
 * with sections of the same numbers.
 */
export const adminPlatformMemoryMessages = defineAdminMessages({
  en: {
    eyebrow: "Reported, not editable",
    title: "Account memory (Release B)",
    description:
      "Enabling either flag is the import/memory policy §12.4 human procedure — a decision-grade eval, blind review, an independent re-run, a signed approval, a register merge and a staging verification. There is no control here on purpose, and the endpoint refuses a request naming these flags rather than ignoring it. Stopping is the opposite direction and does have a control: emergency pair revocation (§12.1).",
    approvedPairs: "Approved, un-revoked pairs",
    blocked:
      "Blocked — no decision-grade eval has been run and no extraction pair is approved. Both flags above are inert whatever they read: every extraction run answers MEMORY_EXTRACTION_PAIR_UNAVAILABLE and injection refuses with no_approved_pair. What has to be decided first is in docs/ops/memory-extraction-eval-program-kickoff.md.",
  },
  ko: {
    eyebrow: "보고 전용, 편집 불가",
    title: "계정 메모리(Release B)",
    description:
      "두 flag 중 어느 하나를 켜는 것은 가져오기/메모리 정책 §12.4의 사람 절차입니다. decision-grade eval, 블라인드 검토, 독립 재실행, 서명된 승인, 레지스트리 병합, staging 검증이 필요합니다. 이 화면에 제어가 없는 것은 의도된 것이며, 엔드포인트는 이 flag를 지정한 요청을 무시하지 않고 거부합니다. 중지는 반대 방향이며 제어가 있습니다: 긴급 pair 철회(§12.1).",
    approvedPairs: "승인되고 철회되지 않은 pair",
    blocked:
      "차단됨 — decision-grade eval이 실행된 적이 없고 승인된 extraction pair가 없습니다. 위 두 flag는 값과 관계없이 효과가 없습니다. 모든 extraction 실행은 MEMORY_EXTRACTION_PAIR_UNAVAILABLE로 응답하고 injection은 no_approved_pair로 거부됩니다. 먼저 결정해야 할 사항은 docs/ops/memory-extraction-eval-program-kickoff.md에 있습니다.",
  },
});
