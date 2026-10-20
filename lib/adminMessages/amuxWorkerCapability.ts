import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the capability editor in AMUX › Operations settings › Workers.
 * Worker names, tags, roles and models are identifiers and render as stored.
 */
export const adminAmuxWorkerCapabilityMessages = defineAdminMessages({
  en: {
    none: "none",
    tags: "tags",
    tools: "tools",
    v22: "v22",
    model: "model",
    importDone: "Recorded. The capabilities below were read again.",
    importStopped: "Stopped. The capabilities below were read again; nothing more was sent.",
    importOutcomeUnknown:
      "The last change's outcome is unknown. The capabilities were read again; check them before recording anything else.",
    importUnread: "The run ended, but the capabilities could not be read again. Read them again before recording anything else.",
    importRefused: (worker: string, code: string) => `${worker} was refused (${code}). Nothing was written for it.`,
    changeFailed: "The capability change failed.",
    editTitle: (worker: string) => `Capability of ${worker}`,
    editHelp:
      "Records one change with its own audit entry. The ceiling rule is checked here before saving and again when the change is recorded.",
    field: {
      model: "Model (blank for none)",
      tags: "Routing tags",
      tools: "Tools (comma-separated)",
      v22: "v22 one-shot profile",
      v22Model: "v22 model",
      v22Roles: "v22 roles",
      v22Tools: "v22 tools",
    },
    requirement: {
      any: "any ceiling",
      implementation: "implementation ceiling or above",
      contract: "contract ceiling",
      verified: "verified provider only",
    },
    editRefusal: (code: string) => `This would be refused (${code}). Change the form before saving.`,
    editUnchanged: "Nothing differs from what is recorded.",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
  },
  ko: {
    none: "없음",
    tags: "태그",
    tools: "도구",
    v22: "v22",
    model: "모델",
    importDone: "기록했습니다. 아래 능력을 다시 읽었습니다.",
    importStopped: "멈췄습니다. 아래 능력을 다시 읽었습니다. 그 뒤로는 아무것도 보내지 않았습니다.",
    importOutcomeUnknown: "마지막 변경의 결과를 알 수 없습니다. 능력을 다시 읽었으니, 다른 것을 기록하기 전에 확인하세요.",
    importUnread: "실행은 끝났지만 능력을 다시 읽지 못했습니다. 다른 것을 기록하기 전에 다시 읽으세요.",
    importRefused: (worker: string, code: string) => `${worker} 기록이 거부되었습니다(${code}). 그 worker에는 아무것도 쓰지 않았습니다.`,
    changeFailed: "능력 변경에 실패했습니다.",
    editTitle: (worker: string) => `${worker}의 능력`,
    editHelp: "감사 기록을 가진 변경 하나로 기록합니다. 상한 규칙은 저장하기 전에 여기서 한 번, 기록할 때 다시 한 번 확인합니다.",
    field: {
      model: "모델(비우면 없음)",
      tags: "Routing 태그",
      tools: "도구(쉼표로 구분)",
      v22: "v22 one-shot 프로필",
      v22Model: "v22 모델",
      v22Roles: "v22 역할",
      v22Tools: "v22 도구",
    },
    requirement: {
      any: "상한 무관",
      implementation: "상한 implementation 이상",
      contract: "상한 contract",
      verified: "검증된 공급사만",
    },
    editRefusal: (code: string) => `이대로는 거부됩니다(${code}). 저장하기 전에 고치세요.`,
    editUnchanged: "기록된 것과 다른 점이 없습니다.",
    save: "저장",
    saving: "저장 중…",
    cancel: "취소",
  },
});
