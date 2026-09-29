import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the AMUX group's three pages (Backlog, Promotion, Execution) and
 * the pointer the Routing page keeps to where AMUX assignment moved.
 *
 * Status chips name a switch state that `lib/adminAmuxTabStatus.ts` reads from
 * the server; the copy never decides the state.
 */
export const adminAmuxWorkspaceMessages = defineAdminMessages({
  en: {
    status: {
      preview_apply_off: "Preview · apply off",
      apply_on: "Apply on",
      behind_server_switch: "Behind server switch",
      server_switch_on: "Server switch on",
      read_only: "Read only",
    },
    routingMoved: {
      before: "AMUX assignment evidence moved to ",
      link: "AMUX › Execution",
      after: ".",
    },
  },
  ko: {
    status: {
      preview_apply_off: "미리보기 · 적용 꺼짐",
      apply_on: "적용 켜짐",
      behind_server_switch: "서버 스위치 꺼짐",
      server_switch_on: "서버 스위치 켜짐",
      read_only: "읽기 전용",
    },
    routingMoved: {
      before: "AMUX 배정 근거는 ",
      link: "AMUX › 실행",
      after: "으로 옮겼습니다.",
    },
  },
});
