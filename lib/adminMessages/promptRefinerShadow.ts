import { defineAdminMessages } from "@/lib/adminLocale";

export const adminPromptRefinerShadowMessages = defineAdminMessages({
  en: {
    eyebrow: "Prompt Refiner",
    title: "Bounded shadow run",
    description:
      "Approve and execute the frozen 16-case staging shadow. This screen never displays prompt or model-output content and cannot connect the Refiner to product Chat traffic.",
    boundary:
      "One deployment, one model, retry 0. An unknown outcome stops the run and this screen never resends it automatically.",
    loading: "Loading exact server preview...",
    refresh: "Refresh status",
    stageTitle: "1. Reservation stage",
    stageBody:
      "Creates a 60-minute immutable reservation authority. It does not call a provider.",
    runTitle: "2. Frozen run approval",
    runBody:
      "Narrows the stage to exactly 16 synthetic cases and a US$0.398656 worst-case ceiling.",
    executionTitle: "3. Execute and observe",
    executionBody:
      "Runs only the approved synthetic corpus. No product conversation or customer content is read.",
    approveStage: "Approve 60-minute stage",
    continueToRun: "Load run preview",
    approveRun: "Approve frozen 16-case run",
    continueToExecution: "Load execution status",
    execute: "Execute approved run",
    resume: "Resume remaining cases",
    working: "Working...",
    deployment: "Deployment",
    commit: "Commit",
    model: "Model",
    status: "Status",
    expires: "Expires",
    approvalWindow: "Approval window",
    perRequestCeiling: "Per-request ceiling",
    stageCeiling: "Stage authority ceiling",
    runCeiling: "Run ceiling",
    maxReservations: "Stage slots",
    maxDispatches: "Run cases",
    retryCount: "Retries",
    timeout: "Timeout",
    approvalFlag: "Run approval flag",
    executionFlag: "Execution flag",
    dispatches: "Dispatches",
    terminals: "Terminals",
    evidenceGate: "Evidence gate",
    evidenceCases: "Evidence cases passed",
    evidenceCost: "Evidence cost",
    evidenceLatency: "Evidence latency p90 / max",
    nextCase: "Next case",
    inFlight: "In flight",
    enabled: "enabled",
    disabled: "disabled",
    none: "none",
    previewInvalid:
      "The server preview does not match the frozen operator contract. Nothing was approved.",
    responseInvalid:
      "The server response was malformed or drifted. Stop and inspect the deployment.",
    requestFailed: "The operator request failed.",
    transportUnknown:
      "The execution request outcome is unknown. Do not resend it. Refresh status and inspect provider and billing records.",
    statusRefreshFailed:
      "The execution response was received, but its follow-up status read failed. The execution button remains locked; refresh status before any new action.",
    stoppedUnknown:
      "The run is stopped on an unknown provider outcome. Automatic continuation is forbidden.",
    completed: "All 16 cases have durable terminal receipts.",
    postFailureStop:
      "The server refused the execution request. It is not a retry signal; inspect status before any new action.",
    runApprovalFlagDisabled:
      "PROMPT_REFINER_SHADOW_RUN_APPROVAL_ENABLED is off. Enable it and redeploy before approving a new run.",
    executionFlagDisabled:
      "PROMPT_REFINER_SHADOW_EXECUTION_ENABLED is off. Enable it and redeploy before executing the approved run.",
    reauthenticate: "Sign in again and return to this screen",
  },
  ko: {
    eyebrow: "Prompt Refiner",
    title: "제한된 shadow 실행",
    description:
      "동결된 staging 합성 16건을 승인하고 실행합니다. 이 화면은 prompt나 모델 출력 내용을 표시하지 않으며 Refiner를 제품 Chat 트래픽에 연결할 수 없습니다.",
    boundary:
      "단일 배포·단일 모델·재시도 0입니다. 결과가 불명이면 실행을 멈추고 이 화면은 자동 재전송하지 않습니다.",
    loading: "서버의 exact preview를 불러오는 중...",
    refresh: "상태 새로고침",
    stageTitle: "1. 예약 stage",
    stageBody:
      "60분짜리 immutable 예약 권한을 만듭니다. 이 단계에서는 provider를 호출하지 않습니다.",
    runTitle: "2. 동결 run 승인",
    runBody:
      "stage를 정확히 16개 합성 case와 최악 비용 상한 US$0.398656로 좁힙니다.",
    executionTitle: "3. 실행 및 관찰",
    executionBody:
      "승인된 합성 corpus만 실행합니다. 제품 대화나 고객 content는 읽지 않습니다.",
    approveStage: "60분 stage 승인",
    continueToRun: "run preview 불러오기",
    approveRun: "동결된 16건 run 승인",
    continueToExecution: "실행 상태 불러오기",
    execute: "승인된 run 실행",
    resume: "남은 case 이어서 실행",
    working: "처리 중...",
    deployment: "배포",
    commit: "커밋",
    model: "모델",
    status: "상태",
    expires: "만료",
    approvalWindow: "승인 유효기간",
    perRequestCeiling: "요청당 상한",
    stageCeiling: "stage 권한 상한",
    runCeiling: "run 상한",
    maxReservations: "stage slot",
    maxDispatches: "run case",
    retryCount: "재시도",
    timeout: "timeout",
    approvalFlag: "run 승인 flag",
    executionFlag: "실행 flag",
    dispatches: "dispatch",
    terminals: "terminal",
    evidenceGate: "증거 게이트",
    evidenceCases: "증거 통과 case",
    evidenceCost: "증거 집계 비용",
    evidenceLatency: "증거 지연 p90 / 최대",
    nextCase: "다음 case",
    inFlight: "진행 중",
    enabled: "활성",
    disabled: "비활성",
    none: "없음",
    previewInvalid:
      "서버 preview가 동결된 운영 계약과 일치하지 않습니다. 아무것도 승인하지 않았습니다.",
    responseInvalid:
      "서버 응답 형식이 잘못됐거나 계약이 drift했습니다. 중단하고 배포를 확인하세요.",
    requestFailed: "운영 요청을 처리하지 못했습니다.",
    transportUnknown:
      "실행 요청의 결과를 알 수 없습니다. 재전송하지 마세요. 상태를 새로고침하고 provider·결제 기록을 확인하세요.",
    statusRefreshFailed:
      "실행 응답은 받았지만 후속 상태 조회에 실패했습니다. 실행 버튼은 잠긴 상태이므로 새 작업 전에 상태를 새로고침하세요.",
    stoppedUnknown:
      "provider 결과 불명으로 run이 중단됐습니다. 자동으로 이어서 실행할 수 없습니다.",
    completed: "16개 case 모두 durable terminal receipt가 있습니다.",
    postFailureStop:
      "서버가 실행 요청을 거부했습니다. 재시도 신호가 아니므로 새 작업 전에 상태를 확인하세요.",
    runApprovalFlagDisabled:
      "PROMPT_REFINER_SHADOW_RUN_APPROVAL_ENABLED가 꺼져 있습니다. 새 run 승인 전에 활성화하고 다시 배포하세요.",
    executionFlagDisabled:
      "PROMPT_REFINER_SHADOW_EXECUTION_ENABLED가 꺼져 있습니다. 승인된 run 실행 전에 활성화하고 다시 배포하세요.",
    reauthenticate: "다시 로그인한 뒤 이 화면으로 돌아오기",
  },
});
