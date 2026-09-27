import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxIntakeMessages = defineAdminMessages({
  en: {
    title: "AMUX intake",
    description:
      "Preview shows one explicit registration and writes nothing. The card stays inactive. Register stays off until the server reports that intake apply is permitted. This screen cannot turn that permission on, promote the card, or start a worker.",
    requestLabel: "Intake draft",
    preview: "Preview",
    register: "Register",
    registerDisabled: "Register is disabled. The server refuses it even if this control is bypassed.",
    renewSignIn: "Renew administrator sign-in",
    inactive: "Registration is inactive.",
    reconfirm: "The draft changed after confirmation. Confirm the new draft.",
    error: (code: string) => `Error: ${code}`,
    unit: (title: string) => `Unit: ${title}`,
    scope: (scope: string) => `Scope: ${scope}`,
    completion: (completion: string) => `Completion: ${completion}`,
    priority: (priority: string) => `Priority: ${priority}`,
    sourceVersion: (version: string) => `Source version: ${version}`,
    sourceDigest: (digest: string) => `Source digest: ${digest}`,
  },
  ko: {
    title: "AMUX 등록",
    description:
      "미리보기는 명시적 등록 한 건을 보여주고 아무것도 쓰지 않습니다. 카드는 비활성입니다. 등록은 서버가 intake 적용을 허용했다고 보고할 때만 켜집니다. 이 화면은 그 허용을 켜거나, 카드를 승격하거나, 워커를 시작하지 않습니다.",
    requestLabel: "등록 초안",
    preview: "미리보기",
    register: "등록",
    registerDisabled: "등록은 꺼져 있습니다. 이 버튼을 우회해도 서버가 거절합니다.",
    renewSignIn: "관리자 로그인을 갱신",
    inactive: "등록은 비활성입니다.",
    reconfirm: "확인 뒤에 초안이 바뀌었습니다. 새 초안을 다시 확인하세요.",
    error: (code: string) => `오류: ${code}`,
    unit: (title: string) => `단위: ${title}`,
    scope: (scope: string) => `범위: ${scope}`,
    completion: (completion: string) => `완료 조건: ${completion}`,
    priority: (priority: string) => `우선순위: ${priority}`,
    sourceVersion: (version: string) => `소스 버전: ${version}`,
    sourceDigest: (digest: string) => `소스 다이제스트: ${digest}`,
  },
});
