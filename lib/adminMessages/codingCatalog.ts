import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the coding catalogue tab (AdminCodingCatalogPanel): chat links, the
 * Code snapshot and the external channel switch. Provider conditions are gone
 * (owner decision 2026-11-21). A
 * dedicated model's whole-profile draft keeps its copy in modelCatalog.ts
 * (`codingFlow`), where the image flow it mirrors lives.
 */
export const adminCodingCatalogMessages = defineAdminMessages({
  en: {
    title: "Coding catalog",
    description:
      "Choose and turn on the coding models Code and the coding API use. A linked chat model keeps chat's name, prices, context and output limit.",
    refresh: "Refresh",
    addDedicated: "Add coding model",

    tiles: {
      active: "Active",
      activeDetail: (version: number | null, inactive: number) =>
        `${version === null ? "No snapshot yet" : `In Code snapshot v${version}`} · ${inactive} inactive`,
      attention: "Needs a check",
      attentionDetail: (floor: number, other: number) =>
        [floor ? `${floor} below the credit floor` : "", other ? `${other} other` : ""]
          .filter(Boolean)
          .join(" · ") || "Nothing waiting",
      candidates: "Chat candidates",
      candidatesDetail: "Chat models not in the coding catalog yet",
    },

    snapshot: {
      title: "Code snapshot",
      none: "Nothing published yet. Code's managed path refuses every model until a snapshot is published.",
      line: (models: number, published: string, until: string) => `${models} models · published ${published} · valid until ${until}`,
      valid: "Valid",
      stale: "Expired",
      pending: (count: number) => `${count} change${count === 1 ? "" : "s"} since publishing. They reach Code at the next publish.`,
      pendingKind: { added: "added", removed: "removed", changed: "changed" },
      upToDate: "The published snapshot matches the catalog.",
      republish:
        "No model changed, but the snapshot predates rows naming their source and channels. Publish once so the scheduled renewal keeps extending it.",
      publish: "Publish snapshot",
      readBy: "/api/code/model-catalog reads this snapshot",
      published: (version: number) => `Published snapshot v${version}.`,
      unchanged: "Nothing changed: the snapshot stays as it is.",
    },

    banner: {
      offTitle: "Switch-over pending: only Code's managed path reads this catalog",
      offBody: (env: string) =>
        `The coding API (/api/code/v1 and /api/code/anthropic: Claude Code, Codex, Cursor, the tomverse CLI and its Smart Adaptive) still offers the chat registry, as the general API does. With ${env}=true it follows the rows with Coding API in the newest snapshot.`,
      onTitle: "The coding API follows this catalog",
      onBody:
        "The coding API, its Smart Adaptive and the coding-app settings offer the rows whose channels include Coding API. A chat link bills as its chat model; a model chat does not have bills at its own row's prices and credits. The general API (/api/v1) keeps the chat registry. With no valid snapshot nothing is offered.",
    },

    filter: {
      search: "Search name, provider, API model id",
      provider: "Provider",
      providerAll: "All",
      source: "Source",
      sourceAll: "All sources",
      state: "Status",
      stateAll: "All",
    },

    list: {
      title: "Coding models",
      note: "A linked chat model inherits its name, prices, context and output limit from the chat registry. Open a row for its details.",
      empty: "No coding models match.",
      columns: {
        model: "Model",
        source: "Source",
        toolCalling: "Tool calling",
        structuredOutput: "Structured output",
        limits: "Context / max output",
        plan: "Minimum plan",
        weight: "Credit weight",
        state: "Status",
        channels: "Channels",
        actions: "Actions",
      },
      inherited: "from chat",
      ownValue: "coding value",
      floor: (floor: number) => `floor ×${floor}`,
      floorUnknown: "floor unknown",
      belowFloor: (floor: number) => `below ×${floor}`,
      notOffered: "Not offered",
      open: "Open",
    },
    source: { chat: "Linked chat model", dedicated: "Coding only" },
    state: { active: "Active", attention: "Needs a check", inactive: "Inactive" },
    stateDetail: {
      held: "Held by an operator",
      off: "Turned off",
      draft: "Draft to check",
      ready: "Ready to activate",
      snapshotChanged: "Changed since the snapshot",
    },
    channel: { code: "Code", api: "Coding API", cli: "Coding API" },

    candidates: {
      title: "Coding candidates among chat models",
      note:
        "Active, listed chat models of a usage class the API serves that are not in the coding catalog yet. Adding one reads the chat registry: tool calling is taken from it, and no LLM call is made.",
      summaryOpen: "View candidates",
      back: "Back to the list",
      none: "Every eligible chat model is already in the coding catalog.",
      facts: {
        limits: "Context / max output",
        price: "Input / output $ per 1M",
        image: "Image input",
        weight: "Chat credit weight",
      },
      yes: "Yes",
      no: "No",
      inheritNote: "These values come from chat. The coding catalog sets only tool calling, structured output and channels.",
      add: "Add to coding catalog",
      adding: "Adding…",
      addAll: "Add all chat models",
      addAllTitle: (count: number) => `Add ${count} chat model${count === 1 ? "" : "s"} to the coding catalog?`,
      addAllEffects: (count: number) => [
        `Each of the ${count} candidate${count === 1 ? "" : "s"} is linked on the coding API at its chat credits and switched on. It is linked on Code too only when it passes Code's rules (credit floor, context window, structured output).`,
        "Credits are never raised here. Tool calling comes from the chat registry; fill the rest with the LLM from the list afterwards.",
        "A model refused on every channel is left out and leaves nothing behind. The result lists the reasons.",
        "Nothing reaches Code or the coding API until a snapshot is published.",
        "Undo: hold a model from the list at any time. Work already under way finishes.",
      ],
      addAllPublish: "Publish the Code snapshot right after adding",
      addAllConfirm: "Add and activate",
      resultTitle: "Result",
      resultAdded: (added: number, attempted: number, withCode: number) =>
        `${added} of ${attempted} chat models added on the coding API, ${withCode} of them on Code too.`,
      resultNoCode: (count: number) => `${count} added without Code, by reason:`,
      resultLeftOut: (count: number) => `${count} not added, by reason:`,
      resultPublished: (version: number) => `Published snapshot v${version}.`,
      resultPublishNext: "Publish a snapshot so Code and the coding API see them.",
      resultPublishFailed: "The models were added, but the snapshot was not published. Publish it from the snapshot card.",
      resultDismiss: "Close",
      excludedTitle: "Chat models left out",
      excludedNote: "A model left out can still be added later, once chat lists and enables it.",
      excludedReason: (reason: string) =>
        reason === "disabled"
          ? "inactive"
          : reason === "not_listed"
            ? "not listed"
            : reason === "invalid_id"
              ? "id not accepted"
              : reason === "chat_credits_missing"
                ? "no chat credits set"
                : reason.startsWith("usage_class:")
                  ? `usage class ${reason.slice("usage_class:".length)}`
                  : reason,
      show: "Show",
      hide: "Hide",
      footnote:
        "Adding makes no LLM call and costs nothing. A single add leaves the model inactive and invisible to Code and the coding API until you activate it.",
      added: (name: string) => `Added ${name}. Check its coding settings.`,
    },

    detail: {
      back: "Back to the list",
      openChat: "Open chat model",
      unlink: "Remove from catalog",
      unlinkTitle: (name: string) => `Remove ${name} from the coding catalog?`,
      unlinkEffects: [
        "Only the coding link is removed; the chat model is untouched.",
        "It becomes a coding candidate again. The audit log keeps the link's values.",
      ],
      unlinked: (name: string) => `Removed ${name} from the coding catalog.`,
      steps: { profile: "Model details", draft: "Capabilities", review: "Check", enable: "Activate" },
      stepNotes: { profile: "from chat", draft: "LLM draft", registry: "chat registry", review: "now", enable: "after the check" },
      reviewTitle: "Check the coding settings, then activate once the judge passes.",
      reviewBody: (origin: "registry" | "llm", provider: string) =>
        (origin === "llm"
          ? `Tool calling and structured output were drafted by an LLM from ${provider}'s official documentation.`
          : "Tool calling comes from the chat registry; structured output stays at Not supported until you set it.") +
        " Values inherited from chat cannot be changed here.",
      inheritedTitle: "Inherited from chat",
      readOnly: "read-only",
      inheritedNote: "The chat registry row's values, read on every load. A change in chat shows here too, and reaches Code at the next snapshot.",
      editInChat: "Edit in the chat registry",
      inheritedChip: "inherited",
      fields: {
        name: "Name",
        provider: "Provider",
        apiModelId: "API model id",
        input: "Input $ per 1M",
        output: "Output $ per 1M",
        image: "Image input",
        context: "Context",
        maxOutput: "Max output",
        chatPlan: "Chat minimum plan",
      },
      settingsTitle: "Coding settings",
      settingsNote: "Values set on this screen. The judge decides from these.",
      llmDraft: "LLM draft",
      registryChip: "Chat registry",
      toolCallingHelp: "\"None\" is refused: Code's loop needs tool calls.",
      structuredOutputHelp: "Code needs structured output to read a plan; a model set to \"Not supported\" is not served in Code.",
      planFollowChat: (plan: string) => `Same as chat · ${plan}`,
      planHelp: "Without an override it follows chat's plan, and moves when chat's does.",
      weightPlaceholder: (weight: number) => `chat ×${weight}`,
      weightHelp: (weight: number | null) =>
        `${weight === null ? "Empty" : `Empty follows chat (×${weight})`}. The floor is computed from the input and output prices and the whole context; below it the model cannot be activated.`,
      weightFloorOk: (floor: number) => `floor ×${floor} met`,
      weightBelow: (floor: number) => `below the floor ×${floor}`,
      weightInvalid: "a whole number from 1 to 1000",
      channelsTitle: "Channels",
      channelsHelp:
        "Coding API: /api/code/v1 and /api/code/anthropic, which Claude Code, Codex, Cursor and the tomverse CLI use. It applies after the next publish while the coding API switch is on; Code reads the next published snapshot too.",
      channelsNone: "Pick at least one channel.",
      codeCreditsTitle: "Tomverse Code credits",
      codeCreditsHelp: "Charged per call on Code's managed path. Its floor assumes the whole context window as input; a new draft changes it.",
      apiCreditsTitle: "Coding API credits",
      apiCreditsDefault: (n: number) => `Default: the chat rule's minimum, ×${n}`,
      apiCreditsBelow: (n: number) => `Below the chat rule's minimum ×${n}: the coding API does not offer this model`,
      apiCreditsUnbounded:
        "The chat rule cannot price this model (no price or output cap, or a minimum above 1,000 credits), so the coding API does not offer it",
      apiCreditsHelp:
        "The coding API takes up to the chat input limit and charges by the chat rule. Leave blank to charge its minimum; enter a higher number to charge more. Applies after the next publish.",
      save: "Save settings",
      saved: "Saved the coding settings.",
      reset: "Undo changes",
      sourcesTitle: "Sources",
      sourcesRead: "Pages read",
      sourcesAt: "Read on",
      sourcesNone: "No pages recorded.",
      sourcesRegistry: "Read from the chat registry. No page was read.",
      officialSources: "Official sources",
      verdictTitle: "Judge",
      verdictPass: "Can be activated",
      verdictServing: "Active",
      verdictFail: "Cannot be activated yet",
      verdictPassItems: (tools: string, weight: number, floor: number | null) => [
        `Tool calling: ${tools}`,
        floor === null ? `Credit weight ×${weight}` : `Credit weight ×${weight}, floor ×${floor}`,
        "Sources: the provider's own documentation",
      ],
      activate: "Activate",
      activateNext: "Next: the confirmation shows the channels and credits.",
      hold: "Hold",
      saveFirst: "Save the settings first.",
    },

    activate: {
      title: (name: string) => `Activate ${name}?`,
      summary: (provider: string, apiModelId: string, source: string) => `${provider} · ${apiModelId} · ${source}`,
      effectChannels: (name: string, channels: string, plan: string, external: boolean) =>
        `${name} becomes available on ${channels} (${plan} and up).${external ? "" : " The coding API applies once its switch is on."}`,
      effectCredits: (weight: number) => `Each request charges credits at weight ×${weight}.`,
      effectProvider: (provider: string) => `The model's cost is paid to ${provider}.`,
      effectSnapshot: (version: number | null, until: string | null) =>
        version === null
          ? "Code's managed path uses it after the first snapshot is published."
          : `Code's managed path uses it after the next snapshot. Snapshot v${version} is valid until ${until}.`,
      effectJudge: "The judge passed: tool calling, credit floor and official sources.",
      undo: "Undo: hold it from the list at any time. Work already under way finishes.",
      publishAfter: "Publish the Code snapshot right after activating",
      confirm: "Activate",
      done: (name: string) => `Activated ${name}.`,
      donePublished: (name: string, version: number) => `Activated ${name} and published snapshot v${version}.`,
      donePublishFailed: (name: string) => `Activated ${name}, but the snapshot was not published. Publish it from the snapshot card.`,
    },

    channelVerdict: {
      api: (offered: boolean): string => (offered ? "Coding API: can be offered" : "Coding API: refused"),
      code: (offered: boolean): string => (offered ? "Code: can be offered" : "Code: refused"),
      reasons: (reasons: string) => ` · ${reasons}`,
      contextUnknown: "The chat registry has no context window for it",
    },

    fill: {
      button: "Fill capabilities with the LLM",
      filling: "Reading the documentation…",
      rowNote:
        "One LLM call over the provider's tool calling and structured output pages (agent budget). It changes only these two values and their sources; the channels stay as they are, so tick Code yourself once it passes.",
      done: (name: string) => `Filled the capabilities of ${name}. They reach Code and the coding API at the next snapshot.`,
      all: (count: number) => `Fill the capabilities of ${count} row${count === 1 ? "" : "s"} without them`,
      allTitle: (count: number) => `Fill ${count} row${count === 1 ? "" : "s"} with the LLM?`,
      allEffects: (count: number, skipped: number) => [
        `One LLM call per row (${count}), one after another, each over the provider's tool calling and structured output pages. This is a paid call from the agent budget.`,
        "A row that fails or times out keeps its values and is listed with the reason. A timed-out call may have been charged and is not retried; the run stops there.",
        `${skipped} row${skipped === 1 ? "" : "s"} of providers with no documentation pages are not included.`,
        "Channels do not change. Changed rows show as changed since the snapshot and reach Code and the coding API at the next publish.",
      ],
      allConfirm: "Fill with the LLM",
      progress: (done: number, total: number) => `Filling ${done}/${total}`,
      resultTitle: "Capabilities filled",
      resultDone: (ok: number, total: number) => `${ok} of ${total} rows filled.`,
      resultFailed: (count: number) => `${count} kept their values:`,
      resultStopped: "Stopped after a timeout: that call's outcome is unknown and it is not retried. Reload and press again for the rest.",
      resultClose: "Close",
      off: (env: string) => `Off: set ${env} to an enabled model to turn it on.`,
      noSource: "No documentation pages for this provider.",
    },

    toast: {
      refused: "Not done",
      checking: "The request timed out. Checking whether it finished…",
      finishedAnyway: "It finished after all.",
      network: "The network request failed.",
      sessionExpired: "Your admin session has expired.",
      relogin: "Sign in again",
    },
    draftNotConfigured: (env: string) => `Drafting is off. Set ${env} to an enabled model to turn it on.`,
    movedFromImage: "Coding models moved to their own tab.",
    movedLink: "Open the coding catalog",
  },
  ko: {
    title: "코딩 카탈로그",
    description: "Code와 코딩 API에서 쓸 코딩 모델을 고르고 켭니다. 채팅 모델을 연결하면 이름·단가·컨텍스트·최대 출력은 채팅 값을 그대로 씁니다.",
    refresh: "새로고침",
    addDedicated: "코딩 모델 추가",

    tiles: {
      active: "활성",
      activeDetail: (version: number | null, inactive: number) =>
        `${version === null ? "발행한 스냅샷 없음" : `Code 스냅샷 v${version}에 반영`} · 비활성 ${inactive}`,
      attention: "확인 필요",
      attentionDetail: (floor: number, other: number) =>
        [floor ? `크레딧 하한 미만 ${floor}` : "", other ? `기타 ${other}` : ""]
          .filter(Boolean)
          .join(" · ") || "기다리는 모델 없음",
      candidates: "채팅 후보",
      candidatesDetail: "채팅 모델 중 아직 코딩 카탈로그에 없는 모델",
    },

    snapshot: {
      title: "Code 스냅샷",
      none: "아직 발행하지 않았습니다. 스냅샷을 발행하기 전에는 Code 관리형 경로가 모든 모델을 거절합니다.",
      line: (models: number, published: string, until: string) => `모델 ${models}개 · ${published} 발행 · ${until}까지 유효`,
      valid: "유효",
      stale: "만료",
      pending: (count: number) => `발행 후 변경 ${count}건 — 다음 발행 때 Code에 반영됩니다.`,
      pendingKind: { added: "추가", removed: "빠짐", changed: "변경" },
      upToDate: "발행한 스냅샷이 지금 카탈로그와 같습니다.",
      republish: "바뀐 모델은 없지만, 행에 출처·노출 채널이 들어가기 전 스냅샷입니다. 정기 갱신이 이어지도록 한 번 발행해 주세요.",
      publish: "스냅샷 발행",
      readBy: "/api/code/model-catalog 가 이 스냅샷을 읽습니다",
      published: (version: number) => `스냅샷 v${version}을 발행했습니다.`,
      unchanged: "바뀐 것이 없어 스냅샷을 그대로 둡니다.",
    },

    banner: {
      offTitle: "전환 준비 중 — 지금은 Code 관리형 경로만 이 카탈로그를 읽습니다",
      offBody: (env: string) =>
        `코딩 API(/api/code/v1, /api/code/anthropic — Claude Code·Codex·Cursor·tomverse CLI와 그 Smart Adaptive)는 아직 일반 API처럼 채팅 레지스트리를 씁니다. ${env}=true로 전환하면 최신 스냅샷에서 코딩 API에 노출한 행을 따릅니다.`,
      onTitle: "코딩 API가 이 카탈로그를 따릅니다",
      onBody:
        "코딩 API와 그 Smart Adaptive, 코딩 앱 연동 설정은 노출 채널에 코딩 API가 있는 행만 씁니다. 채팅 모델 연결 행은 채팅 모델로, 채팅에 없는 모델은 자기 행의 단가와 크레딧으로 과금합니다. 일반 API(/api/v1)는 채팅 레지스트리 그대로입니다. 유효한 스냅샷이 없으면 아무 모델도 보이지 않습니다.",
    },

    filter: {
      search: "모델 이름, provider, apiModelId 검색",
      provider: "공급자",
      providerAll: "전체",
      source: "출처",
      sourceAll: "출처 전체",
      state: "상태",
      stateAll: "전체",
    },

    list: {
      title: "코딩 모델",
      note: "채팅 모델 연결 행의 이름·단가·컨텍스트·최대 출력은 채팅 레지스트리에서 상속합니다. 행을 누르면 상세가 열립니다.",
      empty: "조건에 맞는 코딩 모델이 없습니다.",
      columns: {
        model: "모델",
        source: "출처",
        toolCalling: "Tool calling",
        structuredOutput: "구조화 출력",
        limits: "컨텍스트 / 최대 출력",
        plan: "최소 플랜",
        weight: "크레딧 가중치",
        state: "상태",
        channels: "노출 채널",
        actions: "작업",
      },
      inherited: "채팅에서 상속",
      ownValue: "코딩 전용 값",
      floor: (floor: number) => `하한 ×${floor}`,
      floorUnknown: "하한 모름",
      belowFloor: (floor: number) => `하한 ×${floor} 미만`,
      notOffered: "노출 안 됨",
      open: "열기",
    },
    source: { chat: "채팅 모델 연결", dedicated: "코딩 전용" },
    state: { active: "활성", attention: "확인 필요", inactive: "비활성" },
    stateDetail: {
      held: "운영자가 보류함",
      off: "운영자가 끔",
      draft: "확인할 초안 있음",
      ready: "활성화 가능",
      snapshotChanged: "스냅샷 이후 변경",
    },
    channel: { code: "Code", api: "코딩 API", cli: "코딩 API" },

    candidates: {
      title: "채팅 모델 중 코딩 후보",
      note:
        "활성이고 usageClass standard 이상인 채팅 모델 가운데 아직 코딩 카탈로그에 없는 모델입니다. 추가하면 채팅 레지스트리에서 Tool calling을 가져오며 LLM은 호출하지 않습니다.",
      summaryOpen: "후보 보기",
      back: "목록으로",
      none: "조건에 맞는 채팅 모델은 모두 코딩 카탈로그에 있습니다.",
      facts: {
        limits: "컨텍스트 / 최대 출력",
        price: "입력 / 출력 $ per 1M",
        image: "이미지 입력",
        weight: "채팅 크레딧 가중치",
      },
      yes: "지원",
      no: "없음",
      inheritNote: "위 값은 채팅에서 상속합니다. 코딩 카탈로그에서는 Tool calling·구조화 출력·노출 채널만 정합니다.",
      add: "코딩 카탈로그에 추가",
      adding: "추가 중…",
      addAll: "채팅 모델 한 번에 추가",
      addAllTitle: (count: number) => `채팅 모델 ${count}개를 코딩 카탈로그에 추가할까요?`,
      addAllEffects: (count: number) => [
        `후보 ${count}개를 코딩 API에 채팅 크레딧 그대로 연결하고 활성화합니다. Code에는 Code 규칙(크레딧 하한·컨텍스트·구조화 출력)을 통과하는 모델만 함께 연결합니다.`,
        "크레딧은 올리지 않습니다. Tool calling은 채팅 레지스트리에서 가져오고, 나머지는 추가한 뒤 목록에서 LLM으로 채울 수 있습니다.",
        "어느 채널에서도 거절된 모델은 추가하지 않고 아무것도 남기지 않습니다. 거절 사유는 결과에 건수로 보입니다.",
        "스냅샷을 발행하기 전에는 Code와 코딩 API에 보이지 않습니다.",
        "되돌리기: 목록에서 언제든 보류합니다. 진행 중인 작업은 끝까지 갑니다.",
      ],
      addAllPublish: "추가 후 바로 Code 스냅샷 발행",
      addAllConfirm: "추가하고 활성화",
      resultTitle: "결과",
      resultAdded: (added: number, attempted: number, withCode: number) =>
        `채팅 모델 ${attempted}개 중 ${added}개를 코딩 API로 추가했고, 그중 ${withCode}개는 Code까지 연결했습니다.`,
      resultNoCode: (count: number) => `${count}개는 Code 없이 추가했습니다. 사유별 건수:`,
      resultLeftOut: (count: number) => `${count}개는 추가하지 않았습니다. 사유별 건수:`,
      resultPublished: (version: number) => `스냅샷 v${version}을 발행했습니다.`,
      resultPublishNext: "Code와 코딩 API에 보이려면 스냅샷을 발행해 주세요.",
      resultPublishFailed: "모델은 추가했지만 스냅샷은 발행되지 않았습니다. 스냅샷 카드에서 발행해 주세요.",
      resultDismiss: "닫기",
      excludedTitle: "후보에서 제외된 채팅 모델",
      excludedNote: "채팅에서 활성화·공개되면 나중에 다시 후보가 됩니다.",
      excludedReason: (reason: string) =>
        reason === "disabled"
          ? "비활성"
          : reason === "not_listed"
            ? "비공개"
            : reason === "invalid_id"
              ? "카탈로그가 받지 않는 id"
              : reason === "chat_credits_missing"
                ? "채팅 크레딧 미설정"
                : reason.startsWith("usage_class:")
                  ? `usageClass ${reason.slice("usage_class:".length)}`
                  : reason,
      show: "목록 펼치기",
      hide: "접기",
      footnote:
        "추가는 LLM을 호출하지 않아 비용이 들지 않습니다. 하나씩 추가한 모델은 활성화하기 전까지 Code와 코딩 API에 보이지 않습니다.",
      added: (name: string) => `${name}을(를) 추가했습니다. 코딩 전용 설정을 확인해 주세요.`,
    },

    detail: {
      back: "목록",
      openChat: "채팅 모델 화면 열기",
      unlink: "카탈로그에서 빼기",
      unlinkTitle: (name: string) => `${name}을(를) 코딩 카탈로그에서 뺄까요?`,
      unlinkEffects: ["코딩 연결만 지웁니다. 채팅 모델은 그대로입니다.", "다시 코딩 후보가 됩니다. 연결 값은 감사 기록에 남습니다."],
      unlinked: (name: string) => `${name}을(를) 코딩 카탈로그에서 뺐습니다.`,
      steps: { profile: "모델 정보", draft: "코딩 능력", review: "확인", enable: "활성화" },
      stepNotes: { profile: "채팅에서 상속", draft: "LLM 초안", registry: "채팅 레지스트리", review: "지금 할 일", enable: "확인 후" },
      reviewTitle: "코딩 전용 설정을 확인하고, 판정이 통과하면 활성화하세요.",
      reviewBody: (origin: "registry" | "llm", provider: string) =>
        (origin === "llm"
          ? `Tool calling·구조화 출력은 LLM이 ${provider} 공식 문서에서 읽은 값입니다.`
          : "Tool calling은 채팅 레지스트리에서 가져왔고, 구조화 출력은 정하기 전까지 지원 안 함입니다.") +
        " 채팅에서 상속한 값은 이 화면에서 바꿀 수 없습니다.",
      inheritedTitle: "채팅에서 상속",
      readOnly: "읽기 전용",
      inheritedNote: "채팅 레지스트리 행의 값을 그대로 씁니다. 채팅에서 바꾸면 여기도 바뀌고, Code에는 다음 스냅샷부터 반영됩니다.",
      editInChat: "채팅 모델 화면에서 수정",
      inheritedChip: "상속",
      fields: {
        name: "이름",
        provider: "공급자",
        apiModelId: "API 모델 id",
        input: "입력 단가 $ per 1M",
        output: "출력 단가 $ per 1M",
        image: "이미지 입력",
        context: "컨텍스트",
        maxOutput: "최대 출력",
        chatPlan: "채팅 최소 플랜",
      },
      settingsTitle: "코딩 전용 설정",
      settingsNote: "이 화면에서 정하는 값입니다. 판정 함수가 이 값으로 통과 여부를 계산합니다.",
      llmDraft: "LLM 초안",
      registryChip: "채팅 레지스트리",
      toolCallingHelp: "\"없음\"이면 판정에서 거절됩니다 — Code의 작업 루프는 도구 호출이 필요합니다.",
      structuredOutputHelp: "Code가 계획을 읽으려면 구조화 출력이 필요합니다. \"지원 안 함\"이면 Code에서 쓰지 않습니다.",
      planFollowChat: (plan: string) => `채팅과 같음 · ${plan}`,
      planHelp: "덮어쓰지 않으면 채팅 최소 플랜을 따릅니다. 채팅에서 플랜이 바뀌면 여기도 따라 바뀝니다.",
      weightPlaceholder: (weight: number) => `채팅 ×${weight}`,
      weightHelp: (weight: number | null) =>
        `${weight === null ? "비워 두면" : `비워 두면 채팅 가중치(×${weight})를 씁니다.`} 하한은 입력·출력 단가와 컨텍스트 전체로 계산하며, 판정 함수와 같은 식입니다. 하한 미만이면 활성화할 수 없습니다.`,
      weightFloorOk: (floor: number) => `하한 ×${floor} 이상`,
      weightBelow: (floor: number) => `하한 ×${floor} 미만`,
      weightInvalid: "1부터 1000 사이의 정수",
      channelsTitle: "노출 채널",
      channelsHelp:
        "코딩 API를 켜면 Claude Code·Codex·Cursor·tomverse CLI가 쓰는 /api/code/v1, /api/code/anthropic에 보입니다(다음 발행 뒤, 코딩 API 스위치가 켜져 있을 때). Code도 다음 스냅샷 발행 후 반영됩니다.",
      channelsNone: "채널을 하나 이상 고르세요.",
      codeCreditsTitle: "Tomverse Code 크레딧",
      codeCreditsHelp: "Code 관리형 경로에서 호출마다 차감합니다. 하한은 전체 컨텍스트를 입력으로 봅니다. 새 초안으로 바꿉니다.",
      apiCreditsTitle: "코딩 API 크레딧",
      apiCreditsDefault: (n: number) => `기본값: 채팅 기준 최소값 ×${n}`,
      apiCreditsBelow: (n: number) => `채팅 기준 최소값 ×${n}보다 낮아 코딩 API에 노출하지 않습니다`,
      apiCreditsUnbounded:
        "채팅 기준 하한을 계산할 수 없어(가격이나 출력 상한을 모르거나, 하한이 1,000 크레딧을 넘음) 코딩 API에 노출하지 않습니다",
      apiCreditsHelp:
        "코딩 API는 채팅 입력 한도까지만 받고 채팅 규칙으로 과금합니다. 비워 두면 그 최소값을, 더 높은 수를 넣으면 그 값을 받습니다. 다음 발행 뒤 적용됩니다.",
      save: "설정 저장",
      saved: "코딩 전용 설정을 저장했습니다.",
      reset: "변경 취소",
      sourcesTitle: "출처",
      sourcesRead: "읽은 문서",
      sourcesAt: "읽은 날",
      sourcesNone: "기록된 문서가 없습니다.",
      sourcesRegistry: "채팅 레지스트리에서 가져왔습니다. 읽은 문서는 없습니다.",
      officialSources: "공식 출처",
      verdictTitle: "판정 결과",
      verdictPass: "활성화할 수 있습니다",
      verdictServing: "활성",
      verdictFail: "아직 활성화할 수 없습니다",
      verdictPassItems: (tools: string, weight: number, floor: number | null) => [
        `Tool calling — ${tools}`,
        floor === null ? `크레딧 ×${weight}` : `크레딧 ×${weight} — 하한 ×${floor} 이상입니다`,
        "출처 — 공급자 공식 문서입니다",
      ],
      activate: "활성화",
      activateNext: "다음: 확인 대화상자에서 노출 범위와 크레딧을 확인합니다",
      hold: "보류",
      saveFirst: "먼저 설정을 저장해 주세요.",
    },

    activate: {
      title: (name: string) => `${name}을(를) 활성화할까요?`,
      summary: (provider: string, apiModelId: string, source: string) => `${provider} · ${apiModelId} · ${source}`,
      effectChannels: (name: string, channels: string, plan: string, external: boolean) =>
        `${channels} 사용자에게 ${name}이(가) 보입니다(${plan} 이상).${external ? "" : " 코딩 API는 스위치를 켜야 적용됩니다."}`,
      effectCredits: (weight: number) => `요청마다 사용자 크레딧이 ×${weight} 가중치로 차감됩니다.`,
      effectProvider: (provider: string) => `모델 호출 비용은 ${provider} 공급자 예산에서 나갑니다.`,
      effectSnapshot: (version: number | null, until: string | null) =>
        version === null
          ? "Code 관리형 경로에는 첫 스냅샷 발행 후 반영됩니다."
          : `Code 관리형 경로에는 다음 스냅샷 발행 후 반영됩니다. 지금 스냅샷 v${version}는 ${until}까지 유효합니다.`,
      effectJudge: "판정 통과 — Tool calling · 크레딧 하한 · 공식 출처",
      undo: "되돌리기: 목록에서 언제든 보류합니다. 진행 중인 작업은 끝까지 갑니다.",
      publishAfter: "활성화 후 바로 Code 스냅샷 발행",
      confirm: "활성화",
      done: (name: string) => `${name}을(를) 활성화했습니다.`,
      donePublished: (name: string, version: number) => `${name}을(를) 활성화하고 스냅샷 v${version}을 발행했습니다.`,
      donePublishFailed: (name: string) => `${name}을(를) 활성화했지만 스냅샷은 발행되지 않았습니다. 스냅샷 카드에서 발행해 주세요.`,
    },

    channelVerdict: {
      api: (offered: boolean) => (offered ? "코딩 API: 노출 가능" : "코딩 API: 거절"),
      code: (offered: boolean) => (offered ? "Code: 노출 가능" : "Code: 거절"),
      reasons: (reasons: string) => ` · ${reasons}`,
      contextUnknown: "채팅 레지스트리에 컨텍스트 크기가 없습니다",
    },

    fill: {
      button: "LLM으로 기능 정보 채우기",
      filling: "공식 문서를 읽는 중…",
      rowNote:
        "공급자의 Tool calling·구조화 출력 문서를 읽는 LLM 호출 1회입니다(에이전트 예산). 이 두 값과 출처만 바꾸고 채널은 그대로이므로, Code 판정을 통과하면 Code 채널은 직접 켜 주세요.",
      done: (name: string) => `${name}의 기능 정보를 채웠습니다. Code와 코딩 API에는 다음 스냅샷부터 반영됩니다.`,
      all: (count: number) => `정보 없는 행 ${count}개 모두 채우기`,
      allTitle: (count: number) => `행 ${count}개를 LLM으로 채울까요?`,
      allEffects: (count: number, skipped: number) => [
        `행마다 LLM 호출 1회(${count}회)를 차례로 합니다. 각 호출은 공급자의 Tool calling·구조화 출력 문서를 읽으며, 에이전트 예산에서 나가는 유료 호출입니다.`,
        "실패하거나 시간이 지난 행은 값을 그대로 두고 사유를 보여 줍니다. 시간 초과 호출은 비용이 나갔을 수 있어 다시 시도하지 않고, 거기서 멈춥니다.",
        `공식 문서 주소가 없는 공급자의 ${skipped}개 행은 포함하지 않습니다.`,
        "채널은 바뀌지 않습니다. 바뀐 행은 \"스냅샷 이후 변경\"으로 보이며 다음 발행 때 Code와 코딩 API에 반영됩니다.",
      ],
      allConfirm: "LLM으로 채우기",
      progress: (done: number, total: number) => `채우는 중 ${done}/${total}`,
      resultTitle: "기능 정보 채우기 결과",
      resultDone: (ok: number, total: number) => `행 ${total}개 중 ${ok}개를 채웠습니다.`,
      resultFailed: (count: number) => `${count}개는 값을 그대로 두었습니다:`,
      resultStopped: "시간 초과 뒤 멈췄습니다. 그 호출의 결과는 알 수 없어 다시 시도하지 않았습니다. 새로고침 후 다시 눌러 나머지를 채워 주세요.",
      resultClose: "닫기",
      off: (env: string) => `꺼져 있습니다. ${env}에 활성 모델을 지정하면 켜집니다.`,
      noSource: "이 공급자는 공식 문서 주소가 없습니다.",
    },

    toast: {
      refused: "처리하지 못했습니다",
      checking: "응답이 늦어 끝났는지 확인하는 중입니다…",
      finishedAnyway: "결국 끝났습니다.",
      network: "네트워크 요청이 실패했습니다.",
      sessionExpired: "관리자 로그인 시간이 만료되었습니다.",
      relogin: "다시 로그인",
    },
    draftNotConfigured: (env: string) => `초안 기능이 꺼져 있습니다. ${env}에 활성 모델을 지정하면 켜집니다.`,
    movedFromImage: "코딩 모델은 별도 탭으로 옮겼습니다.",
    movedLink: "코딩 카탈로그 열기",
  },
});
