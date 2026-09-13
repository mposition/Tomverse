import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for `AdminAuditIntegrityPanel`.
 *
 * The chain readings (`auditIntegrityReading`) are not here: a source test
 * reads their literal sentences out of the panel, so they stay in it.
 */
export const adminAuditIntegrityMessages = defineAdminMessages({
  en: {
    title: "Admin audit integrity",
    description:
      "New audit entries form a serialized HMAC chain. Verify it before exporting or investigating an incident.",
    verifyChain: "Verify chain",
    verifiedOf: (verified: string, checked: string) =>
      `Verified ${verified} of ${checked} entries`,
    unverifiedCount: (count: string) => ` · ${count} unverified`,
    linkageBreaks: ({ text, value }: { text: string; value: number }) =>
      ` · ${text} linkage ${value === 1 ? "break" : "breaks"}`,
    keysUsed: (used: number, available: number) =>
      ` · ${used} of ${available} keys used`,
    firstUnverified: " · first unverified ",
    legacyOrder: ({ text, value }: { text: string; value: number }) =>
      `${text} ${value === 1 ? "entry was" : "entries were"} signed before the key order moved to code point and ${value === 1 ? "reproduces" : "reproduce"} only under the older order. Verification accepts them; they stay exposed to a change of runtime collation. See docs/ops/admin-audit-key-epochs.md.`,
    keyCountsLabel: "Entries opened per key:",
    keyCount: (position: number, count: string) => `key ${position} — ${count}`,
    showEntry: "Show this entry",
    openInLog: "Open in the audit log",
    whatChanged: "What changed?",
    unverifiedListTitle: "Every unverified entry, newest first",
    moreNotListed: (count: string) => ` · ${count} more not listed`,
    open: "open",
    whatChangedShort: "what changed?",
    noMatch: (candidates: string, keysTried: number) =>
      `No single-field change reproduces this entry's hash. ${candidates} reconstructions were tried against ${keysTried} key${keysTried === 1 ? "" : "s"}. More than one field differs from what was signed, or a field this does not vary does, or it was signed with a key this environment no longer has.`,
    matchTitle: "The hash is reproduced by content differing in one field:",
    matchKey: (position: number) => `(key ${position})`,
    matchConclusion: "That is what changed since the entry was signed.",
    collation:
      "This entry reproduces its stored digest when object keys are sorted by collation rather than by code point — the order signing used before 2026-08-27. Nothing about the row changed, and verification accepts it. See docs/ops/admin-audit-key-epochs.md.",
    actorFingerprint:
      "This row names an actor by address but carries no user id. That is what deleting a user leaves behind: `actorUserId` is in the hash and also a foreign key set to null on delete, so the database rewrote the row with no application code involved. The id it was signed with cannot be recovered.",
    doNotRehash:
      "Do not re-hash the row: rewriting an audit entry to satisfy its own checker ends what the chain proves.",
    entry: {
      written: "Written",
      action: "Action",
      target: "Target",
      actor: "Actor",
      unknownAdmin: "Unknown admin",
    },
    toast: {
      verificationFailed: "Audit verification failed.",
      diagnoseFailed: "Could not diagnose this entry.",
      entryNotFound: "Audit event not found.",
    },
  },
  ko: {
    title: "관리자 감사 로그 무결성",
    description:
      "새 감사 항목은 직렬화된 HMAC chain을 이룹니다. 내보내거나 인시던트를 조사하기 전에 검증하세요.",
    verifyChain: "Chain 검증",
    verifiedOf: (verified: string, checked: string) =>
      `항목 ${checked}건 중 ${verified}건 검증됨`,
    unverifiedCount: (count: string) => ` · 미검증 ${count}건`,
    linkageBreaks: ({ text }: { text: string; value: number }) => ` · 연결 끊김 ${text}건`,
    keysUsed: (used: number, available: number) =>
      ` · 키 ${available}개 중 ${used}개 사용`,
    firstUnverified: " · 첫 미검증 항목 ",
    legacyOrder: ({ text }: { text: string; value: number }) =>
      `항목 ${text}건은 키 정렬 순서가 code point로 바뀌기 전에 서명되어 이전 순서에서만 재현됩니다. 검증은 이 항목을 통과시키지만, runtime collation이 바뀌면 영향을 받습니다. docs/ops/admin-audit-key-epochs.md를 참고하세요.`,
    keyCountsLabel: "키별로 연 항목 수:",
    keyCount: (position: number, count: string) => `키 ${position} — ${count}`,
    showEntry: "이 항목 보기",
    openInLog: "감사 로그에서 열기",
    whatChanged: "무엇이 바뀌었나요?",
    unverifiedListTitle: "모든 미검증 항목 (최신순)",
    moreNotListed: (count: string) => ` · 목록에 없는 항목 ${count}건 더 있음`,
    open: "열기",
    whatChangedShort: "무엇이 바뀌었나요?",
    noMatch: (candidates: string, keysTried: number) =>
      `필드 하나만 바꿔서는 이 항목의 hash가 재현되지 않습니다. 키 ${keysTried}개로 재구성 ${candidates}건을 시도했습니다. 서명 당시와 다른 필드가 둘 이상이거나, 이 진단이 바꿔 보지 않는 필드가 다르거나, 이 환경에 더 이상 없는 키로 서명되었습니다.`,
    matchTitle: "한 필드만 다른 내용으로 hash가 재현됩니다:",
    matchKey: (position: number) => `(키 ${position})`,
    matchConclusion: "항목이 서명된 이후 바뀐 것이 바로 이 필드입니다.",
    collation:
      "이 항목은 객체 키를 code point가 아니라 collation 순서로 정렬하면 저장된 digest가 재현됩니다. 2026-08-27 이전에 서명에 쓰던 순서입니다. 행 자체는 바뀌지 않았고 검증도 통과합니다. docs/ops/admin-audit-key-epochs.md를 참고하세요.",
    actorFingerprint:
      "이 행은 수행자를 이메일 주소로 기록하지만 사용자 id가 없습니다. 사용자를 삭제하면 이렇게 남습니다. `actorUserId`는 hash에 포함되면서 삭제 시 null로 설정되는 foreign key이기도 해서, 애플리케이션 코드 없이 데이터베이스가 행을 다시 썼습니다. 서명 당시의 id는 복구할 수 없습니다.",
    doNotRehash:
      "행을 다시 hash하지 마세요. 검사기를 통과시키려고 감사 항목을 다시 쓰면 chain이 증명하는 것이 사라집니다.",
    entry: {
      written: "기록 시각",
      action: "작업",
      target: "대상",
      actor: "수행자",
      unknownAdmin: "알 수 없는 관리자",
    },
    toast: {
      verificationFailed: "감사 로그 검증에 실패했습니다.",
      diagnoseFailed: "이 항목을 진단하지 못했습니다.",
      entryNotFound: "감사 이벤트를 찾을 수 없습니다.",
    },
  },
});
