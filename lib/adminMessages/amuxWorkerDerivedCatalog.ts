import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for AMUX › Execution › Workers, derived catalog (orchestration policy
 * version 35, stage R2b). Worker names, providers, models, tags and fields are
 * identifiers and render as stored.
 */
export const adminAmuxWorkerDerivedCatalogMessages = defineAdminMessages({
  en: {
    title: "Derived catalog (shadow)",
    description:
      "Version 35 R2b: the assignment catalog the registry would give (each active worker with no open stop latch, its recorded capability under its current ceiling, plus the engineering runner's code constant), beside the catalog variables. Assignment still reads the variables until R2c; this only compares.",
    shadowOff:
      "The shadow is off: R2b ships with its code latch off, and the operator's activation record turns it on. Nothing is read.",
    unavailable: "The derived catalog could not be read. Nothing is shown rather than a guessed comparison.",
    derivedUnreadable:
      "The registry side could not be read, so there is no derived catalog. That is the same as no catalog: nobody would be assigned.",
    catalogUnreadable: "A catalog variable is unset or invalid, so there is nothing to compare against.",
    equal: "Equal: the derived catalog would assign exactly what the catalog variables assign.",
    different: (count: number) =>
      `Different for ${count} worker${count === 1 ? "" : "s"}. R2b's observation period counts only while every row is equal; a difference restarts it.`,
    reload: "Reload the page to read again.",
    column: { worker: "Worker", env: "Catalog variables", derived: "Derived", verdict: "Result" },
    env: { assignable: "assignable", held: "held", absent: "not listed" },
    derived: { present: "listed", absent: "not listed" },
    verdict: {
      equal: "equal",
      env_only: "only the variables would assign it",
      derived_only: "only the derived catalog would assign it",
      differs: (fields: string) => `differs: ${fields}`,
    },
    field: {
      provider: "provider",
      model: "model",
      routing_roles: "routing tags",
      tool_capabilities: "tools",
      v22: "v22 profile",
    },
    constant: "code constant (engineering agent policy)",
  },
  ko: {
    title: "유도 카탈로그(shadow)",
    description:
      "버전 35 R2b: 등록부가 만들 배정 카탈로그(원하는 상태가 active이고 열린 자동 정지 래치가 없는 worker의 기록된 능력을 지금 상한 안에서, 그리고 engineering runner의 코드 상수)를 카탈로그 환경 변수 옆에 보입니다. R2c 전까지 배정은 여전히 환경 변수를 읽습니다. 이 화면은 비교만 합니다.",
    shadowOff: "shadow가 꺼져 있습니다. R2b는 코드 래치를 끈 채 출고되며, 운영자 활성화 기록이 켭니다. 아무것도 읽지 않습니다.",
    unavailable: "유도 카탈로그를 읽지 못했습니다. 추측한 비교 대신 아무것도 보이지 않습니다.",
    derivedUnreadable: "등록부 쪽을 읽지 못해 유도 카탈로그가 없습니다. 카탈로그가 없는 것과 같으며, 아무도 배정되지 않습니다.",
    catalogUnreadable: "카탈로그 환경 변수가 없거나 형식이 틀려 비교할 대상이 없습니다.",
    equal: "같음: 유도 카탈로그는 카탈로그 환경 변수와 정확히 같은 worker를 배정합니다.",
    different: (count: number) =>
      `worker ${count}개가 다릅니다. R2b의 관측 기간은 모든 행이 같을 때만 세며, 차이가 생기면 처음부터 다시 셉니다.`,
    reload: "다시 읽으려면 페이지를 새로 고치세요.",
    column: { worker: "Worker", env: "카탈로그 환경 변수", derived: "유도", verdict: "결과" },
    env: { assignable: "배정 가능", held: "보류", absent: "없음" },
    derived: { present: "있음", absent: "없음" },
    verdict: {
      equal: "같음",
      env_only: "환경 변수만 배정",
      derived_only: "유도 카탈로그만 배정",
      differs: (fields: string) => `다름: ${fields}`,
    },
    field: {
      provider: "공급사",
      model: "모델",
      routing_roles: "역할 태그",
      tool_capabilities: "도구",
      v22: "v22 프로필",
    },
    constant: "코드 상수(engineering agent 정책)",
  },
});
