import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Platform settings panel (`/admin/platform`). */
export const adminPlatformSettingsMessages = defineAdminMessages({
  en: {
    toast: {
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
      leadSaved: "Leading model saved and is live.",
      leadNotSaved: "The leading model was not saved. Nothing else changed.",
      copyDoesNotApply: "This copy does not change anything.",
      copyFailed: "Could not copy. Select the text and copy it yourself.",
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
    chatStarter: {
      eyebrow: "Opt-in rollout",
      title: "Chat starter catalogue",
      description:
        "The cards a new conversation's welcome screen offers. Default-off, and off is off: nothing renders, not a disabled teaser. A card is only shown where its own feature is on, so switching this on cannot advertise anything the build does not do (docs/ui-contracts/chat-starter-catalog.md). CHAT_STARTER_KILL_SWITCH overrides this toggle and needs no database.",
      toggle: "Chat starter catalogue enabled",
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
      title: "Guest first conversation — leading model",
      description:
        "Guests who are not signed in always get three models together. The model chosen here only decides which of those three goes first. It does not change which three they see, and it does not change the default for a signed-in account.",
      leadingEngine: "Leading model (first of the guest trio)",
      saveLead: "Save leading model",
      trioFixed: (ids: string) => `Guest trio (fixed in code): ${ids}`,
      visibleOrder: (ids: string) => `Order guests see now: ${ids}`,
      noEligible: "No model can be chosen as the lead.",
      outsideTrio: (name: string, id: string) =>
        `${name} (${id}) is not in the guest trio, so it cannot lead. Changing the trio is a code change.`,
      storedNotApplied: (stored: string, effective: string) =>
        `Stored lead ${stored} is not applied, so ${effective} leads.`,
      substituted: (missing: string, substitute: string) =>
        `${missing} is outside the guest conditions, so guests see ${substitute} instead.`,
    },
    decisions: {
      eyebrow: "Three different decisions",
      title: "Default models",
      subtitle:
        "The same value can still be three decisions. Changing one does not change the others.",
      fallbackTitle: "New-account default model (application fallback)",
      fallbackBadge: "Fixed in code · changed by a deploy",
      fallbackCurrent: (name: string, id: string, provider: string) =>
        `${name} (${id}) · ${provider}`,
      fallbackApplies:
        "Applies to the representative model of a newly created account, the last substitute when a stored model cannot be used, and a request that names no model.",
      fallbackDoesNot:
        "Does not change an existing account's representative model or new-chat combination, existing conversations, or the guest trio and its lead.",
      fallbackProtection:
        "Turning it off, raising its minimum plan, or removing it from the catalogue is refused.",
      fallbackHow:
        "Moving it is a reviewed code change. The procedure is docs/policy/default-model-luna-migration.md §1.1 and §7.",
      checkTitle: "Transition check (nothing is saved)",
      checkEmpty:
        "There is no other model to check. Adopt the successor in the model registry first.",
      checkCandidate: "Candidate",
      checkCopy: "Copy transition request",
      checks: {
        registry_live: "Enabled and publicly listed in the registry",
        guest_plan: "Minimum plan is Guest",
        standard_class: "Usage class is Standard",
        credit_ceiling: "Credits are at or below the current fallback",
        code_catalog: "Present in the code catalogue. A registry-only model cannot be the fallback.",
        pricing_profile: "Has a pricing profile",
      },
      pass: "Pass",
      fail: "Fail",
      accountTitle: "Each account's new-chat combination",
      accountBadge: "Set by each account · no administrator edit",
      accountBody:
        "Existing accounts move only after a model retirement is approved, and only through the reconciliation script (§7). This screen does not run it.",
      accountLink: "Default-model distribution in usage analytics",
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
      leadSaved: "선두 모델을 저장했으며 바로 적용됩니다.",
      leadNotSaved: "선두 모델을 저장하지 않았습니다. 그 밖의 설정은 바뀌지 않았습니다.",
      copyDoesNotApply: "이 복사만으로 바뀌는 것은 없습니다.",
      copyFailed: "복사하지 못했습니다. 직접 선택해 복사하세요.",
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
    chatStarter: {
      eyebrow: "옵트인 롤아웃",
      title: "Chat 시작 카탈로그",
      description:
        "새 대화의 환영 화면이 제안하는 카드입니다. 기본값은 꺼짐이고, 꺼짐은 아무것도 렌더하지 않는 것입니다 — 비활성 teaser가 아닙니다. 각 카드는 자기 기능이 켜져 있을 때만 보이므로, 이것을 켜도 빌드가 하지 못하는 일을 광고할 수는 없습니다(docs/ui-contracts/chat-starter-catalog.md). CHAT_STARTER_KILL_SWITCH가 이 토글을 무시하고 끄며, DB가 필요 없습니다.",
      toggle: "Chat 시작 카탈로그 사용",
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
      title: "게스트 첫 대화 — 선두 모델",
      description:
        "로그인하지 않은 게스트에게는 항상 세 모델이 함께 제공됩니다. 여기서 고르는 모델은 그 셋 중 어느 것을 맨 앞에 둘지만 정합니다. 세 모델의 구성도, 로그인 계정의 기본 모델도 바꾸지 않습니다.",
      leadingEngine: "선두 모델 (게스트 3종 중 맨 앞)",
      saveLead: "선두 모델 저장",
      trioFixed: (ids: string) => `게스트 3종 (코드 고정): ${ids}`,
      visibleOrder: (ids: string) => `지금 게스트에게 보이는 순서: ${ids}`,
      noEligible: "선두로 고를 수 있는 모델이 없습니다.",
      outsideTrio: (name: string, id: string) =>
        `${name} (${id})는 게스트 3종이 아니라 선두로 고를 수 없습니다. 3종 변경은 코드 변경입니다.`,
      storedNotApplied: (stored: string, effective: string) =>
        `저장된 선두 ${stored}가 적용되지 않아 ${effective}가 선두입니다.`,
      substituted: (missing: string, substitute: string) =>
        `${missing}가 게스트 조건을 벗어나 ${substitute}가 대신 보입니다.`,
    },
    decisions: {
      eyebrow: "서로 다른 세 결정",
      title: "기본 모델",
      subtitle: "값이 같아도 따로 움직입니다. 하나를 바꿔도 나머지는 바뀌지 않습니다.",
      fallbackTitle: "신규 계정 기본 모델 (앱 fallback)",
      fallbackBadge: "코드에 고정 · 배포로 변경",
      fallbackCurrent: (name: string, id: string, provider: string) =>
        `${name} (${id}) · ${provider}`,
      fallbackApplies:
        "적용되는 곳: 새로 만들어지는 계정의 대표 모델, 저장된 모델을 쓸 수 없을 때의 마지막 대체, 모델을 지정하지 않은 요청.",
      fallbackDoesNot:
        "바꾸지 않는 것: 기존 계정의 대표 모델과 새 대화 조합, 기존 대화, 게스트 3종과 선두.",
      fallbackProtection: "끄기, 최소 플랜 올리기, 카탈로그에서 제거는 거부됩니다.",
      fallbackHow:
        "전환은 검토를 거치는 코드 변경입니다. 절차는 docs/policy/default-model-luna-migration.md §1.1과 §7입니다.",
      checkTitle: "전환 후보 점검 (저장하지 않음)",
      checkEmpty: "점검할 다른 모델이 없습니다. 먼저 모델 레지스트리에서 후속 모델을 채택하세요.",
      checkCandidate: "후보",
      checkCopy: "전환 요청 복사",
      checks: {
        registry_live: "레지스트리에서 활성·공개",
        guest_plan: "최소 플랜 Guest",
        standard_class: "사용 등급 Standard",
        credit_ceiling: "크레딧이 현재 fallback 이하",
        code_catalog: "코드 카탈로그에 있음. 레지스트리에만 있는 모델은 fallback이 될 수 없습니다.",
        pricing_profile: "가격 profile이 있음",
      },
      pass: "통과",
      fail: "실패",
      accountTitle: "계정별 새 대화 기본 조합",
      accountBadge: "각 계정이 설정 · 관리자 변경 없음",
      accountBody:
        "기존 계정 이동은 모델 은퇴가 승인된 뒤 reconciliation 스크립트로만 합니다(§7). 이 화면에서 실행하지 않습니다.",
      accountLink: "사용량 분석의 기본 모델 분포",
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
