import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the feedback inbox on the Support page and its closing dialog. */
export const adminFeedbackInboxMessages = defineAdminMessages({
  en: {
    verification: {
      verified: "Verified server error (signed token)",
      clientEmptyResponse: "Client-classified EMPTY_RESPONSE — server token not issued",
      missingToken: "Unverified — no server token",
      expired: "Unverified — token expired",
      invalidSignature: "Unverified — invalid token signature",
      payloadMismatch: "Unverified — token does not match this trace",
      unsupportedVersion: "Unverified — unsupported token version",
      untrustedTraceSource: "Unverified — client-supplied trace",
      manualTrace: "Unverified — manual trace",
    },
    evidence: {
      recorded: "Evidence recorded",
      intentionallyNotRecorded: "No evidence row by policy",
      existingLimitEvent: "See existing limit-decision events for this trace",
      existingProviderEvent: "See existing provider events for this trace",
      notYetAvailable: "Evidence row not found (write pending, capped or failed)",
      ambiguousTrace: "Multiple occurrences share this trace — no exact link",
    },
    notification: {
      delivered: " The reporter was emailed.",
      queued: " Reporter email queued; delivery will be retried.",
      alreadyNotified: " This stage was already announced -- no new email.",
    },
    statuses: {
      all: "all",
      open: "open",
      reviewing: "reviewing",
      resolved: "resolved",
      closed: "closed",
    },
    toast: {
      updated: (notificationSentence: string) =>
        `Feedback status updated.${notificationSentence}`,
      updateFailed: "Feedback update failed.",
      updateFailedFallback: "Failed to update feedback.",
      contextCopied: "Feedback context copied.",
      contextCopyFailed: "Could not copy feedback context.",
    },
    eyebrow: "Feedback",
    title: "Support inbox",
    description:
      "Review user feedback, copy reproduction context, and move issues through support states without leaving the Admin console.",
    rowLimit: (limit: number) =>
      ` Showing the ${limit} most recent reports; the counters below describe those reports, not every report ever filed.`,
    openCount: (count: number) => `${count} open`,
    exportCsv: "Export CSV",
    searchPlaceholder: "Search email, trace ID, model, path, message...",
    empty: "No feedback matches the current filter.",
    emailUpdatesOn: "Email updates on",
    noEmailUpdates: "No email updates",
    guest: "guest",
    copyContext: "Copy context",
    reply: "Reply",
    reviewingEmailHint:
      "Moving this report to reviewing (or closing it) emails the reporter a status update.",
    meta: {
      trace: (value: string) => `Trace: ${value}`,
      model: (value: string) => `Model: ${value}`,
      plan: (value: string) => `Plan: ${value}`,
      attachments: (count: number) => `Attachments: ${count}`,
      path: (value: string) => `Path: ${value}`,
      userAgent: (value: string) => `UA: ${value}`,
    },
    traceSource: "Trace source: ",
    traceSourceAuthenticated: "server_generated (authenticated)",
    traceSourceClaim: (provenance: string) => `${provenance} (client claim)`,
    clientCode: (code: string) => `Client-classified code: ${code}`,
    shadowDiagnosis: "Shadow diagnosis (observation only, no auto-fix): ",
    evidenceRow: {
      serverCode: (code: string, source: string) => `Server code: ${code} (${source})`,
      route: (routeClass: string) => `Route: ${routeClass}`,
      release: (release: string, environment: string) => `Release: ${release} (${environment})`,
      provider: (provider: string, model: string) => `Provider: ${provider} / ${model}`,
      occurred: (at: string) => `Occurred: ${at}`,
      sentryEvent: (id: string) => `Sentry event: ${id}`,
    },
    dialog: {
      cancel: "Cancel",
      label: (status: string) => `Close feedback as ${status}`,
      title: (status: string) => `Mark as ${status}`,
      alreadyCompleted:
        "This report was already closed once. The completion email is sent only for the first closure, so no new email will go out.",
      willEmail:
        "The reporter opted into email updates. Confirming sends the completion email previewed below.",
      noEmail: "This reporter has no email updates. The status changes without sending anything.",
      outcome: "Outcome",
      reply: "Reply to the reporter (optional, included in the email)",
      replyTooShort: (min: number) =>
        `A reply needs at least ${min} characters, or leave it empty.`,
      replyHint: (length: number, max: number) =>
        `Visible to the reporter. Never paste internal notes, trace IDs or diagnostics here. ${length}/${max}`,
      preview: (language: string) => `Email preview (${language})`,
      confirm: (status: string) => `Mark ${status}`,
    },
  },
  ko: {
    verification: {
      verified: "검증된 서버 오류 (서명된 token)",
      clientEmptyResponse: "클라이언트가 분류한 EMPTY_RESPONSE — 서버 token 미발급",
      missingToken: "미검증 — 서버 token 없음",
      expired: "미검증 — token 만료",
      invalidSignature: "미검증 — token 서명 불일치",
      payloadMismatch: "미검증 — token이 이 trace와 일치하지 않음",
      unsupportedVersion: "미검증 — 지원하지 않는 token 버전",
      untrustedTraceSource: "미검증 — 클라이언트가 제공한 trace",
      manualTrace: "미검증 — 수동 입력 trace",
    },
    evidence: {
      recorded: "증거 기록됨",
      intentionallyNotRecorded: "정책상 증거 행 없음",
      existingLimitEvent: "이 trace의 기존 한도 판정 이벤트를 확인하세요",
      existingProviderEvent: "이 trace의 기존 공급자 이벤트를 확인하세요",
      notYetAvailable: "증거 행 없음 (쓰기 대기, 상한 도달 또는 실패)",
      ambiguousTrace: "여러 발생 건이 이 trace를 공유함 — 정확한 연결 없음",
    },
    notification: {
      delivered: " 신고자에게 이메일을 보냈습니다.",
      queued: " 신고자 이메일을 대기열에 넣었으며 발송을 재시도합니다.",
      alreadyNotified: " 이 단계는 이미 안내되어 새 이메일을 보내지 않습니다.",
    },
    statuses: {
      all: "전체",
      open: "접수",
      reviewing: "검토 중",
      resolved: "해결됨",
      closed: "종료",
    },
    toast: {
      updated: (notificationSentence: string) =>
        `피드백 상태를 업데이트했습니다.${notificationSentence}`,
      updateFailed: "피드백을 업데이트하지 못했습니다.",
      updateFailedFallback: "피드백을 업데이트하지 못했습니다.",
      contextCopied: "피드백 컨텍스트를 복사했습니다.",
      contextCopyFailed: "피드백 컨텍스트를 복사하지 못했습니다.",
    },
    eyebrow: "피드백",
    title: "고객 지원 수신함",
    description:
      "Admin 콘솔을 벗어나지 않고 사용자 피드백을 검토하고, 재현 컨텍스트를 복사하고, 이슈를 지원 상태별로 옮깁니다.",
    rowLimit: (limit: number) =>
      ` 최근 신고 ${limit}건만 표시합니다. 아래 카운터는 이 신고들에 대한 것이며, 지금까지 접수된 전체 신고가 아닙니다.`,
    openCount: (count: number) => `접수 ${count}건`,
    exportCsv: "CSV 내보내기",
    searchPlaceholder: "이메일, trace ID, 모델, 경로, 메시지 검색...",
    empty: "현재 필터에 맞는 피드백이 없습니다.",
    emailUpdatesOn: "이메일 알림 켜짐",
    noEmailUpdates: "이메일 알림 없음",
    guest: "게스트",
    copyContext: "컨텍스트 복사",
    reply: "답장",
    reviewingEmailHint:
      "이 신고를 검토 중으로 옮기거나 종료하면 신고자에게 상태 변경 이메일이 발송됩니다.",
    meta: {
      trace: (value: string) => `Trace: ${value}`,
      model: (value: string) => `모델: ${value}`,
      plan: (value: string) => `플랜: ${value}`,
      attachments: (count: number) => `첨부: ${count}`,
      path: (value: string) => `경로: ${value}`,
      userAgent: (value: string) => `UA: ${value}`,
    },
    traceSource: "Trace 출처: ",
    traceSourceAuthenticated: "server_generated (인증됨)",
    traceSourceClaim: (provenance: string) => `${provenance} (클라이언트 주장)`,
    clientCode: (code: string) => `클라이언트 분류 코드: ${code}`,
    shadowDiagnosis: "Shadow 진단 (관찰 전용, 자동 수정 없음): ",
    evidenceRow: {
      serverCode: (code: string, source: string) => `서버 코드: ${code} (${source})`,
      route: (routeClass: string) => `경로 분류: ${routeClass}`,
      release: (release: string, environment: string) => `릴리스: ${release} (${environment})`,
      provider: (provider: string, model: string) => `공급자: ${provider} / ${model}`,
      occurred: (at: string) => `발생 시각: ${at}`,
      sentryEvent: (id: string) => `Sentry 이벤트: ${id}`,
    },
    dialog: {
      cancel: "취소",
      label: (status: string) => `피드백을 ${status} 상태로 종료`,
      title: (status: string) => `${status} 상태로 표시`,
      alreadyCompleted:
        "이 신고는 이미 한 번 종료되었습니다. 완료 이메일은 첫 종료 때만 발송되므로 새 이메일은 나가지 않습니다.",
      willEmail:
        "신고자가 이메일 알림을 선택했습니다. 확인하면 아래 미리보기의 완료 이메일이 발송됩니다.",
      noEmail: "이 신고자는 이메일 알림을 받지 않습니다. 아무것도 발송하지 않고 상태만 바뀝니다.",
      outcome: "처리 결과",
      reply: "신고자에게 보낼 답변 (선택, 이메일에 포함)",
      replyTooShort: (min: number) =>
        `답변은 ${min}자 이상이어야 합니다. 아니면 비워 두세요.`,
      replyHint: (length: number, max: number) =>
        `신고자에게 보입니다. 내부 메모, trace ID, 진단 정보를 절대 붙여 넣지 마세요. ${length}/${max}`,
      preview: (language: string) => `이메일 미리보기 (${language})`,
      confirm: (status: string) => `${status} 상태로 변경`,
    },
  },
});
