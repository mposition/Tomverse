import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the AMUX pages (Ideas, Execution board, Safety & recovery) and
 * the pointer the Routing page keeps to where AMUX assignment moved.
 *
 * Status chips name a switch state that `lib/adminAmuxTabStatus.ts` reads from
 * the server; the copy never decides the state.
 */
export const adminAmuxWorkspaceMessages = defineAdminMessages({
  en: {
    testCardIntake: "Register U21 test card",
    status: {
      preview_apply_off: "Preview · apply off",
      apply_on: "Apply on",
      behind_server_switch: "Behind server switch",
      server_switch_on: "Server switch on",
      read_only: "Read only",
    },
    routingMoved: {
      before: "AMUX assignment evidence moved to ",
      link: "Execution board › Diagnostics",
      after: ".",
    },
    // Safety & recovery: the retired tools and the reservation tab.
    legacy: {
      intro:
        "These tools belong to the older AMUX flow. Ideas and the execution board replaced them; they stay here with their data and their gates unchanged. Open one to use it.",
      open: "Open",
      close: "Close",
      sections: {
        import: "Catalog import",
        reconciliation: "Source reconciliation",
        metadata: "Card metadata",
        recommendation: "Recommendation pool",
        promotion: "Manual promotion",
        "auto-promotion": "Auto-promotion (legacy grants)",
      },
    },
    reservations: {
      title: "Unused reservations are released from the idea",
      detail:
        "Open the idea in Ideas. Its detail shows the release button when the server finds an unclaimed hold with no usage, and says why none can be released otherwise. A claim that needs a decision opens here from its own link.",
    },
  },
  ko: {
    testCardIntake: "U21 테스트 카드 등록",
    status: {
      preview_apply_off: "미리보기 · 적용 꺼짐",
      apply_on: "적용 켜짐",
      behind_server_switch: "서버 스위치 꺼짐",
      server_switch_on: "서버 스위치 켜짐",
      read_only: "읽기 전용",
    },
    routingMoved: {
      before: "AMUX 배정 근거는 ",
      link: "실행 보드 › 진단",
      after: "로 옮겼습니다.",
    },
    legacy: {
      intro:
        "예전 AMUX 흐름의 도구예요. 아이디어와 실행 보드가 대신하게 됐고, 데이터와 게이트는 그대로 두고 여기에 남겼어요. 쓰려면 열어 주세요.",
      open: "열기",
      close: "닫기",
      sections: {
        import: "카탈로그 이관",
        reconciliation: "소스 재조정",
        metadata: "카드 메타데이터",
        recommendation: "추천 풀",
        promotion: "수동 승격",
        "auto-promotion": "자동 승격 (기존 grant)",
      },
    },
    reservations: {
      title: "쓰이지 않은 예약은 아이디어에서 풀어요",
      detail:
        "아이디어 화면에서 해당 아이디어를 열어 주세요. 서버가 사용 없이 남은 예약을 찾으면 상세에 풀기 버튼이 나오고, 풀 수 없으면 이유를 알려 줘요. 결정이 필요한 claim은 자기 링크로 여기에 열려요.",
    },
  },
});
