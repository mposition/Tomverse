import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Platform settings panel (`/admin/platform`). */
export const adminPlatformSettingsMessages = defineAdminMessages({
  en: {
    toast: {
      packageImportSignIn:
        "Sign in again before changing this flag. Use the link at the top of this screen.",
      rationaleRequired: "Say why this is changing. It goes on the audit row.",
      refused: "Refused. This needs ops:write.",
      packageImportUnchanged: (after: string | undefined) =>
        `Recorded. It was already ${after}.`,
      packageImportChanged: (after: string | undefined, before: string) =>
        `Package import is now ${after}. Recorded with before=${before}.`,
      noBefore: "(none)",
      packageImportUndelivered: "The change could not be delivered.",
      reloaded: "Platform settings reloaded. The form now matches what is stored.",
      reloadFailed:
        "Platform settings could not be reloaded, so the form still shows the values it had. Retry before editing.",
      saveNeedsSignIn:
        "Platform settings were not saved: this is a high-risk action, so sign in again before saving.",
      notSavedWithError: (error: string) =>
        `Platform settings were not saved. ${error} Nothing changed.`,
      notSaved:
        "Platform settings were not saved. Nothing changed -- retry, or reload to discard the edit.",
      saved: "Platform settings saved and are live.",
      sendFailed:
        "Platform settings could not be sent. Nothing changed -- check your connection and retry.",
    },
    eyebrow: "Platform settings",
    title: "Product defaults and guest experience",
    description:
      "Configure platform-level behavior that is not part of billing, provider health, or user support workflows.",
    reload: "Reload DB",
    save: "Save platform settings",
    reauth: {
      title: "Nothing was saved",
      body:
        "Changing platform settings is a high-risk action and needs a more recent administrator sign-in than this session has. The whole request was refused, so every setting is still exactly as it was stored -- your edits below have not been applied and will not be re-sent for you.",
      next:
        "Signing in again ends this app session and brings you back to this screen. Review the settings here and save them again. Refreshing the page does not renew the sign-in.",
      link: "Sign in again to continue",
    },
    killSwitches: {
      eyebrow: "Emergency kill switches",
      title: "Operational feature controls",
      description:
        "Disabled features are blocked by the server immediately. Attachment deletion and share revocation remain available for safe cleanup.",
      aiChat: "AI chat",
      attachments: "Attachments",
      publicSharing: "Public sharing",
    },
    imageGeneration: {
      eyebrow: "Opt-in beta",
      title: "Image generation",
      description:
        "Default-off, unlike the kill switches above: it is enabled only while this toggle is on. Provider budget env vars must be live first or /api/ready fails the moment this turns on (docs/policy/image-generation.md §8).",
      toggle: "Image generation enabled",
    },
    optInRollout: "Opt-in rollout",
    externalImport: {
      title: "External conversation import",
      description:
        "Release A of the import/memory program: ChatGPT, Claude and Gemini (Google Takeout) export files, parsed in the browser, stored per account. One switch for all three — there is no per-provider flag, so enabling this enables Gemini too. Default-off and fail-closed; turning this off closes the import APIs and UI while listing, deletion and export stay available to owners (docs/policy/external-conversation-import-and-memory.md §15).",
      toggle: "External conversation import enabled",
      continuationBefore: "Continuing an imported conversation is a ",
      continuationSeparate: "separate",
      continuationAfter:
        " switch. It starts a new Tomverse conversation from an imported one and gives each of its turns a bounded excerpt of the source. Turning it off stops new continuations and stops the excerpt reaching a prompt; conversations already continued stay open and their messages stay readable (docs/policy/external-conversation-continuation.md §7).",
      continuationToggle: "Continue an imported conversation enabled",
    },
    assistantProfiles: {
      title: "Assistant profiles",
      description:
        "Release C of the import/memory program: private assistant profiles with their own instructions, model and versioned snapshots. Default-off and fail-closed. Knowledge files are a second switch and are only in force while profiles are on, so the order in docs/policy/external-conversation-import-and-memory.md §15 -- profiles first, then knowledge -- is what the two checkboxes below enforce, not a note to follow by hand.",
      profilesToggle: "Assistant profiles enabled",
      knowledgeToggle: "Assistant knowledge files enabled",
      knowledgeStaysOff: "Knowledge stays off until assistant profiles are enabled.",
    },
    guestDefault: {
      eyebrow: "Guest default model",
      title: "Guest mode default conversation engine",
      description:
        "Guests who are not signed in always get three models together: GPT · Claude · Gemini. The model chosen here only decides which of them goes first (the leading slot), and shapes a guest's first experience.",
      leadingEngine: "Leading engine",
    },
    packageImport: {
      eyebrow: "Its own control, not part of the save above",
      title: "External assistant package import",
      description:
        "Enabling and rolling back take the same path, and each press writes one audit row carrying the value on both sides of it, who pressed it, when, and the reason below. Needs ops:write and a session that has not aged out (docs/policy/assistant-package-import.md §12.2.1).",
      currentlyEnabled: "Currently enabled",
      currentlyDisabled: "Currently disabled",
      rationale: "Why this is changing",
      enable: "Enable",
      rollBack: "Roll back",
    },
    selection: {
      eyebrow: "Current selection",
      eligibility: "Only enabled guest-accessible Standard models can be used as the guest default.",
      noEligible: "No eligible guest-accessible Standard model is available.",
      synced: (time: string) => `Synced ${time}`,
      loadedOnOpen: "Loaded on page open",
    },
  },
  ko: {
    toast: {
      packageImportSignIn:
        "이 flag를 바꾸기 전에 다시 로그인하세요. 화면 상단의 링크를 사용하세요.",
      rationaleRequired: "변경 사유를 입력하세요. 감사 로그 행에 기록됩니다.",
      refused: "거부되었습니다. ops:write 권한이 필요합니다.",
      packageImportUnchanged: (after: string | undefined) =>
        `기록했습니다. 이미 ${after} 상태였습니다.`,
      packageImportChanged: (after: string | undefined, before: string) =>
        `패키지 가져오기가 이제 ${after} 상태입니다. before=${before}로 기록했습니다.`,
      noBefore: "(없음)",
      packageImportUndelivered: "변경 요청을 전달하지 못했습니다.",
      reloaded: "플랫폼 설정을 다시 불러왔습니다. 이제 양식이 저장된 값과 같습니다.",
      reloadFailed:
        "플랫폼 설정을 다시 불러오지 못해 양식에는 이전 값이 그대로 표시됩니다. 편집하기 전에 다시 시도하세요.",
      saveNeedsSignIn:
        "플랫폼 설정을 저장하지 않았습니다. 고위험 작업이므로 저장하기 전에 다시 로그인하세요.",
      notSavedWithError: (error: string) =>
        `플랫폼 설정을 저장하지 않았습니다. ${error} 변경된 것은 없습니다.`,
      notSaved:
        "플랫폼 설정을 저장하지 않았습니다. 변경된 것은 없습니다. 다시 시도하거나, 편집을 버리려면 다시 불러오세요.",
      saved: "플랫폼 설정을 저장했으며 바로 적용됩니다.",
      sendFailed:
        "플랫폼 설정을 전송하지 못했습니다. 변경된 것은 없습니다. 연결을 확인하고 다시 시도하세요.",
    },
    eyebrow: "플랫폼 설정",
    title: "제품 기본값과 게스트 경험",
    description:
      "결제, 공급자 상태, 사용자 지원 워크플로에 속하지 않는 플랫폼 수준 동작을 설정합니다.",
    reload: "DB 다시 불러오기",
    save: "플랫폼 설정 저장",
    reauth: {
      title: "아무것도 저장되지 않았습니다",
      body:
        "플랫폼 설정 변경은 고위험 작업이라 이 세션보다 더 최근의 관리자 로그인이 필요합니다. 요청 전체가 거부되었으므로 모든 설정은 저장된 그대로입니다. 아래의 편집 내용은 적용되지 않았고 자동으로 다시 전송되지도 않습니다.",
      next:
        "다시 로그인하면 현재 앱 세션이 끝나고 이 화면으로 돌아옵니다. 여기서 설정을 확인한 뒤 다시 저장하세요. 페이지를 새로고침해도 로그인은 갱신되지 않습니다.",
      link: "다시 로그인하고 계속하기",
    },
    killSwitches: {
      eyebrow: "긴급 kill switch",
      title: "운영 기능 제어",
      description:
        "비활성화한 기능은 서버가 즉시 차단합니다. 안전한 정리를 위해 첨부파일 삭제와 공유 해제는 계속 사용할 수 있습니다.",
      aiChat: "AI 채팅",
      attachments: "첨부파일",
      publicSharing: "공개 공유",
    },
    imageGeneration: {
      eyebrow: "옵트인 베타",
      title: "이미지 생성",
      description:
        "위의 kill switch와 달리 기본값이 꺼짐이며, 이 토글이 켜져 있는 동안에만 활성화됩니다. 공급자 예산 환경변수가 먼저 적용되어 있어야 하며, 그렇지 않으면 켜는 즉시 /api/ready가 실패합니다(docs/policy/image-generation.md §8).",
      toggle: "이미지 생성 사용",
    },
    optInRollout: "옵트인 롤아웃",
    externalImport: {
      title: "외부 대화 가져오기",
      description:
        "가져오기/메모리 프로그램의 Release A입니다. ChatGPT, Claude, Gemini(Google Takeout) 내보내기 파일을 브라우저에서 파싱해 계정별로 저장합니다. 세 가지 모두 스위치 하나로 제어하며 공급자별 flag가 없으므로, 이것을 켜면 Gemini도 켜집니다. 기본값은 꺼짐이고 fail-closed입니다. 끄면 가져오기 API와 UI가 닫히지만 목록 조회, 삭제, 내보내기는 소유자가 계속 사용할 수 있습니다(docs/policy/external-conversation-import-and-memory.md §15).",
      toggle: "외부 대화 가져오기 사용",
      continuationBefore: "가져온 대화 이어가기는 ",
      continuationSeparate: "별도의",
      continuationAfter:
        " 스위치입니다. 가져온 대화에서 새 Tomverse 대화를 시작하고, 각 turn에 원본의 제한된 발췌를 제공합니다. 끄면 새 이어가기가 중단되고 발췌가 prompt에 들어가지 않습니다. 이미 이어간 대화는 열린 상태로 남고 메시지도 계속 읽을 수 있습니다(docs/policy/external-conversation-continuation.md §7).",
      continuationToggle: "가져온 대화 이어가기 사용",
    },
    assistantProfiles: {
      title: "어시스턴트 프로필",
      description:
        "가져오기/메모리 프로그램의 Release C입니다. 자체 지침, 모델, 버전별 snapshot을 갖는 비공개 어시스턴트 프로필입니다. 기본값은 꺼짐이고 fail-closed입니다. 지식 파일은 두 번째 스위치이며 프로필이 켜져 있을 때만 적용되므로, docs/policy/external-conversation-import-and-memory.md §15의 순서(프로필 먼저, 그다음 지식)는 손으로 따라야 할 메모가 아니라 아래 두 체크박스가 강제하는 것입니다.",
      profilesToggle: "어시스턴트 프로필 사용",
      knowledgeToggle: "어시스턴트 지식 파일 사용",
      knowledgeStaysOff: "어시스턴트 프로필을 켜기 전까지 지식은 꺼진 상태로 유지됩니다.",
    },
    guestDefault: {
      eyebrow: "게스트 기본 모델",
      title: "게스트 모드 기본 대화 엔진",
      description:
        "로그인하지 않은 게스트에게는 항상 GPT · Claude · Gemini 3개 모델이 함께 제공됩니다. 여기서 고르는 모델은 그중 어느 모델을 맨 앞(리딩 슬롯)에 둘지만 결정하며, 게스트 첫 사용 경험에 영향을 줍니다.",
      leadingEngine: "리딩 엔진",
    },
    packageImport: {
      eyebrow: "위의 저장과 별개인 전용 제어",
      title: "외부 어시스턴트 패키지 가져오기",
      description:
        "켜기와 롤백은 같은 경로를 거치며, 누를 때마다 변경 전후 값, 누른 사람, 시각, 아래 사유를 담은 감사 로그 행이 하나씩 기록됩니다. ops:write 권한과 만료되지 않은 세션이 필요합니다(docs/policy/assistant-package-import.md §12.2.1).",
      currentlyEnabled: "현재 켜짐",
      currentlyDisabled: "현재 꺼짐",
      rationale: "변경 사유",
      enable: "켜기",
      rollBack: "롤백",
    },
    selection: {
      eyebrow: "현재 선택",
      eligibility: "활성화되어 있고 게스트가 사용할 수 있는 Standard 모델만 게스트 기본값으로 쓸 수 있습니다.",
      noEligible: "게스트가 사용할 수 있는 적격 Standard 모델이 없습니다.",
      synced: (time: string) => `동기화 ${time}`,
      loadedOnOpen: "페이지를 열 때 불러옴",
    },
  },
});
