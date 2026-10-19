import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for AMUX › Execution › Workers (orchestration policy version 31,
 * sections 3 and 8). Worker names, classes, roles and states are identifiers
 * and render as stored beside their sentence.
 */
export const adminAmuxWorkerRegistryMessages = defineAdminMessages({
  en: {
    title: "Worker registry",
    description:
      "Policy version 31 makes this registry the one list of AMUX workers. Since stage R2c, assignment reads the catalog derived from this registry and the capabilities below; the catalog environment variables are no longer read. This screen records the registry and assigns nothing itself.",
    writesOff:
      "Registry writes are off: stage R1 ships with its code latch off, and the operator's R1 activation record turns it on. Reading is open.",
    writesOn: "Registry writes are on. Only the owner may register or change a worker, after a recent sign-in.",
    readOnly: "Read only. Only the owner may register or change a worker.",
    unavailable: "The registry could not be read. Nothing is shown rather than a guessed registry.",
    unreadableRows: "A stored registry row is outside the policy's rules, so the registry is shown as unreadable.",
    reread: "Read again",
    reading: "Reading…",
    workersTitle: "Workers",
    noWorkers: "No worker is registered yet.",
    column: {
      worker: "Worker",
      class: "Class",
      role: "Role ceiling",
      desired: "Desired",
      revision: "Rev.",
      changed: "Changed",
      latch: "Stop latch",
      observation: "Last observation",
      effective: "Assignable by the registry",
    },
    verified: "verified",
    unverified: "unverified",
    latch: { opened: "open", released: "released", none: "none" },
    noObservation: "none",
    assignable: "yes",
    reason: {
      not_registered: "not registered",
      not_active: "not active",
      latch_unreadable: "latch unreadable",
      latch_open: "stop latch open",
      no_observation: "no observation yet (R4)",
      observation_not_ok: "last observation not ok",
    },
    seedTitle: "Register the thirteen workers of version 27",
    seedHelp:
      "R1 registers the seven catalog workers as active and the six Cursor and Copilot sessions as requested. Each worker is one change with its own audit entry. If any answer is unclear, the run stops and the registry is read again before anything else is sent.",
    seedAllRegistered: "All thirteen are registered.",
    seedRegister: (count: number) => `Register ${count} worker${count === 1 ? "" : "s"}`,
    seedRegistering: (done: number, total: number) => `Registering ${done} of ${total}…`,
    seedDone: "Registered. The registry below was read again.",
    seedStopped: "Stopped. The registry below was read again; register again to continue with what is left.",
    seedOutcomeUnknown:
      "The last change's outcome is unknown. The registry was read again; check it before registering anything else.",
    seedUnread:
      "The run ended, but the registry could not be read again. Read it again before registering anything else.",
    seedRefused: (worker: string, code: string) => `${worker} was refused (${code}). Nothing was written for it.`,
    changeFailed: "The registry change failed.",
  },
  ko: {
    title: "Worker 등록부",
    description:
      "정책 버전 31에서 이 등록부가 AMUX worker의 단일 목록입니다. R2c 단계부터 배정은 이 등록부와 아래 능력에서 유도한 카탈로그를 읽고, 카탈로그 환경 변수는 더 이상 읽지 않습니다. 이 화면은 등록부를 기록할 뿐 직접 배정하지 않습니다.",
    writesOff:
      "등록부 쓰기가 꺼져 있습니다. R1 단계는 코드 래치를 끈 채 출고되며, 운영자의 R1 활성화 기록이 켭니다. 읽기는 열려 있습니다.",
    writesOn: "등록부 쓰기가 켜져 있습니다. owner만 최근 로그인 뒤에 worker를 등록하거나 바꿀 수 있습니다.",
    readOnly: "읽기 전용입니다. owner만 worker를 등록하거나 바꿀 수 있습니다.",
    unavailable: "등록부를 읽지 못했습니다. 추측한 등록부 대신 아무것도 보이지 않습니다.",
    unreadableRows: "저장된 등록부 행이 정책 규칙을 벗어나 등록부를 읽을 수 없는 상태로 보입니다.",
    reread: "다시 읽기",
    reading: "읽는 중…",
    workersTitle: "Worker",
    noWorkers: "아직 등록된 worker가 없습니다.",
    column: {
      worker: "Worker",
      class: "종류",
      role: "역할 상한",
      desired: "원하는 상태",
      revision: "Rev.",
      changed: "변경 시각",
      latch: "자동 정지 래치",
      observation: "최신 관측",
      effective: "등록부 기준 배정 가능",
    },
    verified: "검증",
    unverified: "미검증",
    latch: { opened: "열림", released: "해제", none: "없음" },
    noObservation: "없음",
    assignable: "예",
    reason: {
      not_registered: "미등록",
      not_active: "active 아님",
      latch_unreadable: "래치를 읽을 수 없음",
      latch_open: "자동 정지 래치 열림",
      no_observation: "관측 없음(R4 전)",
      observation_not_ok: "최신 관측이 정상 아님",
    },
    seedTitle: "버전 27의 worker 13개 등록",
    seedHelp:
      "R1은 카탈로그의 7개를 active로, Cursor·Copilot 세션 6개를 requested로 등록합니다. worker마다 감사 기록을 가진 변경 하나입니다. 결과가 불분명한 응답이 하나라도 오면 멈추고, 다른 것을 보내기 전에 등록부를 다시 읽습니다.",
    seedAllRegistered: "13개 모두 등록되어 있습니다.",
    seedRegister: (count: number) => `worker ${count}개 등록`,
    seedRegistering: (done: number, total: number) => `${total}개 중 ${done}개 등록 중…`,
    seedDone: "등록했습니다. 아래 등록부를 다시 읽었습니다.",
    seedStopped: "멈췄습니다. 아래 등록부를 다시 읽었습니다. 남은 것은 다시 등록하면 이어집니다.",
    seedOutcomeUnknown:
      "마지막 변경의 결과를 알 수 없습니다. 등록부를 다시 읽었으니, 다른 것을 등록하기 전에 확인하세요.",
    seedUnread: "실행은 끝났지만 등록부를 다시 읽지 못했습니다. 다른 것을 등록하기 전에 다시 읽으세요.",
    seedRefused: (worker: string, code: string) => `${worker} 등록이 거부되었습니다(${code}). 그 worker에는 아무것도 쓰지 않았습니다.`,
    changeFailed: "등록부 변경에 실패했습니다.",
  },
});
