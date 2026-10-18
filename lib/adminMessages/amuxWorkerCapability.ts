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
      "Version 35 moves what each worker can do -- model, routing tags, tools and the v22 profile -- into the registry. Assignment reads the catalog derived from these capabilities (stage R2c); the catalog environment variables are no longer read or imported (stage R2e). This section shows what is recorded.",
    writesOff: "Capability writes are off: R2a ships with its code latch off, and the operator's activation record turns it on.",
    writesOn: "Capability writes are on. Only the owner may record a capability, after a recent sign-in.",
    unavailable: "The capabilities could not be read. Nothing is shown rather than a guessed list.",
    reread: "Read again",
    reading: "Reading…",
    column: { worker: "Worker", ceiling: "Ceiling", current: "Recorded" },
    none: "none",
    tags: "tags",
    tools: "tools",
    v22: "v22",
    model: "model",
  },
  ko: {
    title: "Worker 능력",
    description:
      "버전 35는 worker가 할 수 있는 것(모델, 역할 태그, 도구, v22 프로필)을 등록부로 옮깁니다. 배정은 이 능력에서 유도한 카탈로그를 읽습니다(R2c 단계). 카탈로그 환경 변수는 더 이상 읽지도 가져오지도 않습니다(R2e 단계). 이 구획은 기록된 능력을 보입니다.",
    writesOff: "능력 쓰기가 꺼져 있습니다. R2a는 코드 래치를 끈 채 출고되며, 운영자 활성화 기록이 켭니다.",
    writesOn: "능력 쓰기가 켜져 있습니다. owner만 최근 로그인 뒤에 능력을 기록할 수 있습니다.",
    unavailable: "능력을 읽지 못했습니다. 추측한 목록 대신 아무것도 보이지 않습니다.",
    reread: "다시 읽기",
    reading: "읽는 중…",
    column: { worker: "Worker", ceiling: "상한", current: "기록됨" },
    none: "없음",
    tags: "태그",
    tools: "도구",
    v22: "v22",
    model: "모델",
  },
});
