import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for AMUX › Execution › Workers, capabilities (orchestration policy
 * version 35, stage R2a). Worker names, tags, roles and models are
 * identifiers and render as stored.
 */
export const adminAmuxWorkerCapabilityMessages = defineAdminMessages({
  en: {
    title: "Worker capabilities",
    description:
      "Version 35 moves what each worker can do -- model, routing tags, tools and the v22 profile -- into the registry. Until stage R2c, assignment still reads the catalog variables; this records the capabilities and assigns nothing.",
    writesOff: "Capability writes are off: R2a ships with its code latch off, and the operator's activation record turns it on.",
    writesOn: "Capability writes are on. Only the owner may record a capability, after a recent sign-in.",
    unavailable: "The capabilities could not be read. Nothing is shown rather than a guessed list.",
    catalogUnreadable: "A catalog variable is unset or invalid, so nothing can be imported. A v22 variable that is set but does not parse blocks the import rather than reading as no profiles.",
    reread: "Read again",
    reading: "Reading…",
    column: { worker: "Worker", ceiling: "Ceiling", current: "Recorded", proposed: "From the catalog variables", status: "Import" },
    none: "none",
    tags: "tags",
    tools: "tools",
    v22: "v22",
    model: "model",
    status: {
      same: "already recorded",
      ready: "will be recorded",
      refused: (code: string) => `refused (${code})`,
      none: "nothing to import",
    },
    importTitle: "Import from the catalog variables",
    importHelp:
      "Records, for each worker the catalog variables describe, the capability shown above -- one change each, with its own audit entry. A proposal the ceiling rule refuses is not sent. If any answer is unclear, the run stops and the capabilities are read again before anything else is sent.",
    importNothing: "Everything the catalog variables describe is already recorded.",
    importRun: (count: number) => `Record ${count} capabilit${count === 1 ? "y" : "ies"}`,
    importRunning: (done: number, total: number) => `Recording ${done} of ${total}…`,
    importDone: "Recorded. The capabilities below were read again.",
    importStopped: "Stopped. The capabilities below were read again; import again to continue with what is left.",
    importOutcomeUnknown:
      "The last change's outcome is unknown. The capabilities were read again; check them before recording anything else.",
    importUnread: "The run ended, but the capabilities could not be read again. Read them again before recording anything else.",
    importRefused: (worker: string, code: string) => `${worker} was refused (${code}). Nothing was written for it.`,
    changeFailed: "The capability change failed.",
  },
  ko: {
    title: "Worker 능력",
    description:
      "버전 35는 worker가 할 수 있는 것(모델, 역할 태그, 도구, v22 프로필)을 등록부로 옮깁니다. R2c 단계 전까지 배정은 여전히 카탈로그 환경 변수를 읽습니다. 이 화면은 능력을 기록할 뿐 아무것도 배정하지 않습니다.",
    writesOff: "능력 쓰기가 꺼져 있습니다. R2a는 코드 래치를 끈 채 출고되며, 운영자 활성화 기록이 켭니다.",
    writesOn: "능력 쓰기가 켜져 있습니다. owner만 최근 로그인 뒤에 능력을 기록할 수 있습니다.",
    unavailable: "능력을 읽지 못했습니다. 추측한 목록 대신 아무것도 보이지 않습니다.",
    catalogUnreadable: "카탈로그 환경 변수가 없거나 형식이 틀려 가져올 것이 없습니다. v22 변수가 설정되어 있는데 읽히지 않으면 '프로필 없음'으로 보지 않고 가져오기를 막습니다.",
    reread: "다시 읽기",
    reading: "읽는 중…",
    column: { worker: "Worker", ceiling: "상한", current: "기록됨", proposed: "카탈로그 환경 변수", status: "가져오기" },
    none: "없음",
    tags: "태그",
    tools: "도구",
    v22: "v22",
    model: "모델",
    status: {
      same: "이미 기록됨",
      ready: "기록 예정",
      refused: (code: string) => `거부(${code})`,
      none: "가져올 것 없음",
    },
    importTitle: "카탈로그 환경 변수에서 가져오기",
    importHelp:
      "카탈로그 환경 변수가 설명하는 worker마다 위에 보이는 능력을 기록합니다. worker마다 감사 기록을 가진 변경 하나입니다. 상한 규칙이 거부하는 제안은 보내지 않습니다. 결과가 불분명한 응답이 하나라도 오면 멈추고, 다른 것을 보내기 전에 능력을 다시 읽습니다.",
    importNothing: "카탈로그 환경 변수가 설명하는 것은 모두 기록되어 있습니다.",
    importRun: (count: number) => `능력 ${count}건 기록`,
    importRunning: (done: number, total: number) => `${total}건 중 ${done}건 기록 중…`,
    importDone: "기록했습니다. 아래 능력을 다시 읽었습니다.",
    importStopped: "멈췄습니다. 아래 능력을 다시 읽었습니다. 남은 것은 다시 가져오면 이어집니다.",
    importOutcomeUnknown: "마지막 변경의 결과를 알 수 없습니다. 능력을 다시 읽었으니, 다른 것을 기록하기 전에 확인하세요.",
    importUnread: "실행은 끝났지만 능력을 다시 읽지 못했습니다. 다른 것을 기록하기 전에 다시 읽으세요.",
    importRefused: (worker: string, code: string) => `${worker} 기록이 거부되었습니다(${code}). 그 worker에는 아무것도 쓰지 않았습니다.`,
    changeFailed: "능력 변경에 실패했습니다.",
  },
});
