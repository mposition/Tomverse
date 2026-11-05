import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the trust-safety observer's digest section
 * (docs/policy/trust-safety-compliance-agent.md §9, §14).
 *
 * The section shows two lines the operator judges stage 1 by -- the count
 * comparison and the late-closure history -- the switch, and the fixed list of
 * what this panel does not show. It does not show when the observer last ran:
 * §5.3 keeps the run table unread, and §8 gives that question to the external
 * monitor.
 */
export const adminTrustSafetyMessages = defineAdminMessages({
  en: {
    title: "Trust and safety: DSR deadlines",
    note:
      "Counts every privacy request against its deadline, records one row per successful round and pings an external monitor. It changes no request and notifies no one.",
    unavailable: "The values could not be read. Nothing was written; reopen the page to try again.",

    activationTitle: "Observation",
    mode: "Switch",
    mode_on: "On",
    mode_off: "Off",
    modeUnknown: "Not established",
    version: "Version",
    observedAt: "Read at",
    faultTitle: "Configuration fault",
    fault_config_row_missing: "No configuration row yet. Turning the switch on creates it.",
    fault_signature_unverified:
      "The newest activation entry does not verify, so the switch is not believed.",
    fault_binding_mismatch:
      "The configuration row and its audit entry disagree, so the switch is not believed.",
    fault_unhashed_entry_present:
      "An activation entry has no hash, so the chain cannot be walked past it.",
    fault_chain_broken: "The entry after the activation entry does not point at it.",
    fault_ping_url_missing:
      "No monitor URL is configured, so the round runs but sends no ping. The monitor will report the silence.",
    faultStopsCounting: "No counting happens while this fault stands.",

    countsTitle: "Deadlines now",
    countsNote: "Computed when this page was opened and not stored.",
    observed: "Requests counted",
    overdue: "Past the deadline",
    imminent: "Due soon",
    imminentWindowUnset: "No window has been approved, so nothing is counted as due soon.",
    imminentWindow: "Within {days} days",
    legalHold: "of those, on legal hold",
    legalHoldNote:
      "Legal hold is counted alongside, never subtracted: a request on hold still has a deadline.",
    lateTitle: "Closed late",
    closedLate: "Closed after the deadline",
    worstLateDays: "Worst overrun",
    worstLateNone: "None",
    worstLateSameDay: "Within a day",
    worstLateDaysValue: "{days} days",

    switchTitle: "Turn observation on or off",
    switchOwnerOnly: "Only the owner can change this, with a recent sign-in.",
    turnOn: "Turn on",
    turnOff: "Turn off",
    switchRefused: "Refused: {code}. Nothing was written.",
    switchReauth: "Your sign-in is too old. Sign in again, then change the switch.",

    excludedTitle: "What this panel does not show",
    excluded_policy: "Policy citations and AI transparency check results.",
    excluded_gates:
      "Release gates, MODERATION-01, ABUSE-01 and the memory gates. This agent is not evidence for any gate.",
    excluded_security: "Security workflow results, and where those checks run.",
    excluded_moderation: "This agent performs no moderation or abuse handling.",
    excluded_lastRun:
      "When the observer last ran. The round record is written and never read back; the external monitor reports silence.",
  },
  ko: {
    title: "신뢰·안전: DSR 기한",
    note:
      "개인정보 요청을 기한에 비추어 세고, 성공한 회차마다 한 행을 남기고, 외부 monitor에 ping을 보냅니다. 요청을 바꾸지 않고 누구에게도 알리지 않습니다.",
    unavailable: "값을 읽지 못했습니다. 아무것도 쓰이지 않았으니 페이지를 다시 열어 주세요.",

    activationTitle: "관측",
    mode: "스위치",
    mode_on: "켜짐",
    mode_off: "꺼짐",
    modeUnknown: "확정되지 않음",
    version: "버전",
    observedAt: "읽은 시각",
    faultTitle: "설정 오류",
    fault_config_row_missing: "설정 행이 아직 없습니다. 스위치를 켜면 만들어집니다.",
    fault_signature_unverified: "가장 최신 activation 기록의 서명이 검증되지 않아 스위치를 믿지 않습니다.",
    fault_binding_mismatch: "설정 행과 감사 기록이 어긋나 스위치를 믿지 않습니다.",
    fault_unhashed_entry_present: "해시 없는 activation 기록이 있어 그 뒤로 체인을 걸을 수 없습니다.",
    fault_chain_broken: "activation 기록 다음 기록이 그것을 가리키지 않습니다.",
    fault_ping_url_missing:
      "monitor URL이 설정되지 않아 회차는 돌지만 ping이 나가지 않습니다. 침묵은 monitor가 알립니다.",
    faultStopsCounting: "이 오류가 있는 동안에는 count를 계산하지 않습니다.",

    countsTitle: "현재 기한",
    countsNote: "이 페이지를 열 때 계산했고 저장하지 않습니다.",
    observed: "센 요청",
    overdue: "기한 경과",
    imminent: "임박",
    imminentWindowUnset: "임박 기준이 승인되지 않아 임박으로 세는 건이 없습니다.",
    imminentWindow: "{days}일 안",
    legalHold: "그 가운데 legal hold",
    legalHoldNote: "legal hold는 빼지 않고 함께 셉니다 — hold 중인 요청에도 기한이 있습니다.",
    lateTitle: "기한 초과 종결",
    closedLate: "기한을 넘긴 채 종결",
    worstLateDays: "최대 초과",
    worstLateNone: "없음",
    worstLateSameDay: "하루 이내",
    worstLateDaysValue: "{days}일",

    switchTitle: "관측 켜기·끄기",
    switchOwnerOnly: "소유자만 최근 로그인 상태에서 바꿀 수 있습니다.",
    turnOn: "켜기",
    turnOff: "끄기",
    switchRefused: "거절: {code}. 아무것도 쓰이지 않았습니다.",
    switchReauth: "로그인이 오래되었습니다. 다시 로그인한 뒤 스위치를 바꿔 주세요.",

    excludedTitle: "이 패널이 표시하지 않는 것",
    excluded_policy: "정책 인용과 AI 투명성 검사 결과.",
    excluded_gates:
      "release gate, MODERATION-01, ABUSE-01, memory 게이트. 이 Agent는 어떤 gate의 증거도 아닙니다.",
    excluded_security: "보안 workflow 결과, 그리고 그 검사들이 어디서 실행되는지.",
    excluded_moderation: "이 Agent는 moderation·abuse 대응을 수행하지 않습니다.",
    excluded_lastRun:
      "관측이 마지막으로 돈 시각. 회차 기록은 쓰기만 하고 되읽지 않으며, 침묵은 외부 monitor가 알립니다.",
  },
});
