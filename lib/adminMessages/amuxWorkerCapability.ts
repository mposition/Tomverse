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
    model: "model",
    oneShotTasks: "takes Tasks",
    importDone: "Recorded. The capabilities below were read again.",
    importStopped: "Stopped. The capabilities below were read again; nothing more was sent.",
    importOutcomeUnknown:
      "The last change's outcome is unknown. The capabilities were read again; check them before recording anything else.",
    importUnread: "The run ended, but the capabilities could not be read again. Read them again before recording anything else.",
    importRefused: (worker: string, code: string) => `${worker} was refused (${code}). Nothing was written for it.`,
    changeFailed: "The capability change failed.",
    editTitle: (worker: string) => `Capability of ${worker}`,
    editHelp:
      "Pick the worker's role and model; the role decides the work it takes. Saving records one change with its own audit entry.",
    custom: "Custom",
    customHelp: "What is recorded matches no role. Saving replaces it with the role chosen below.",
    chooseModel: "Choose a model",
    field: {
      preset: "Role",
      model: "Model",
      oneShot: "AMUX hands this worker Tasks of its own",
    },
    preset: {
      chore: { label: "Chore", help: "Small fixes, tests and routine work. Investigates when it takes Tasks." },
      impl: { label: "Implementation", help: "Ordinary features and fixes across files. Implements and investigates Tasks." },
      contract: { label: "Contract", help: "Irreversible work: pricing, migrations, security. Designs, implements, reviews and investigates." },
      review: { label: "Review", help: "Reads and reviews only. Reviews and investigates Tasks, never writes." },
    },
    oneShotOnHelp:
      "AMUX starts this worker for one Task at a time (investigate, implement, design or review), and it stops when the Task is done.",
    oneShotOffHelp: "It only works in its own long-running session. AMUX does not start it for Tasks.",
    issue: {
      retired: (replacement: string | null) => `Retired in Tomverse${replacement === null ? "" : ` · use ${replacement}`}`,
      disabled: (replacement: string | null) => `Off in Tomverse${replacement === null ? "" : ` · use ${replacement}`}`,
      unpriced: "No price: AMUX will not hand it Tasks",
      unlisted: "The CLI no longer offers it",
    },
    issueShort: { retired: "retired", disabled: "off", unpriced: "no price", unlisted: "not offered" },
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
    model: "모델",
    oneShotTasks: "맡는 Task",
    importDone: "기록했습니다. 아래 능력을 다시 읽었습니다.",
    importStopped: "멈췄습니다. 아래 능력을 다시 읽었습니다. 그 뒤로는 아무것도 보내지 않았습니다.",
    importOutcomeUnknown: "마지막 변경의 결과를 알 수 없습니다. 능력을 다시 읽었으니, 다른 것을 기록하기 전에 확인하세요.",
    importUnread: "실행은 끝났지만 능력을 다시 읽지 못했습니다. 다른 것을 기록하기 전에 다시 읽으세요.",
    importRefused: (worker: string, code: string) => `${worker} 기록이 거부되었습니다(${code}). 그 worker에는 아무것도 쓰지 않았습니다.`,
    changeFailed: "능력 변경에 실패했습니다.",
    editTitle: (worker: string) => `${worker}의 능력`,
    editHelp: "worker의 역할과 모델을 고릅니다. 맡는 일은 역할로 정해집니다. 저장하면 감사 기록을 가진 변경 하나로 기록합니다.",
    custom: "사용자 지정",
    customHelp: "기록된 값이 어느 역할과도 맞지 않습니다. 저장하면 아래에서 고른 역할 값으로 바뀝니다.",
    chooseModel: "모델을 고르세요",
    field: {
      preset: "역할",
      model: "모델",
      oneShot: "AMUX가 이 worker에게 Task를 직접 맡깁니다",
    },
    preset: {
      chore: { label: "Chore (잡무)", help: "작은 수정, 테스트, 반복 작업. Task를 받으면 조사를 맡습니다." },
      impl: { label: "Implementation (구현)", help: "여러 파일에 걸친 일반 기능과 수정. Task를 받으면 구현과 조사를 맡습니다." },
      contract: { label: "Contract (되돌릴 수 없는 작업)", help: "가격, migration, 보안 같은 되돌릴 수 없는 작업. 설계, 구현, 검토, 조사를 맡습니다." },
      review: { label: "Review (검토 전용)", help: "읽고 검토만 합니다. 검토와 조사 Task를 맡고 코드를 쓰지 않습니다." },
    },
    oneShotOnHelp:
      "AMUX가 Task 하나마다 이 worker를 실행하고, Task가 끝나면 멈춥니다(조사, 구현, 설계, 검토).",
    oneShotOffHelp: "자기 상주 세션에서만 일합니다. AMUX가 Task를 맡기려고 실행하지 않습니다.",
    issue: {
      retired: (replacement: string | null) => `Tomverse에서 은퇴${replacement === null ? "" : ` · ${replacement}로 바꾸세요`}`,
      disabled: (replacement: string | null) => `Tomverse에서 꺼짐${replacement === null ? "" : ` · ${replacement}로 바꾸세요`}`,
      unpriced: "가격 없음: AMUX가 Task를 맡기지 않습니다",
      unlisted: "CLI가 더 이상 제공하지 않음",
    },
    issueShort: { retired: "은퇴", disabled: "꺼짐", unpriced: "가격 없음", unlisted: "제공 안 함" },
    editRefusal: (code: string) => `이대로는 거부됩니다(${code}). 저장하기 전에 고치세요.`,
    editUnchanged: "기록된 것과 다른 점이 없습니다.",
    save: "저장",
    saving: "저장 중…",
    cancel: "취소",
  },
});
