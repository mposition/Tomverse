import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the provider usage reconciliation panel (AdminProviderUsageSyncPanel). */
export const adminProviderUsageSyncMessages = defineAdminMessages({
  en: {
    failureStage: {
      connection: "Waiting for response headers",
      response: "Reading provider response",
      provider_http: "Provider HTTP response",
      payload: "Validating provider payload",
      storage: "Saving reconciliation",
    },
    guidance: {
      openaiConnect:
        "Tomverse did not receive an HTTP response after automatic retries. Authentication cannot be diagnosed from this result. If it repeats after deployment, verify Railway outbound DNS/TLS and HTTPS access to api.openai.com before rotating the Admin API key.",
      openaiResponseTimeout:
        "OpenAI responded, but the response body did not finish in time. Retry once; if it repeats, use the provider request ID and Tomverse trace when escalating.",
      anthropicTimeout:
        "Anthropic Cost API did not finish within 10 seconds. Retry once; if it repeats, use the provider request ID and Tomverse trace when escalating.",
      anthropicAuth:
        "Replace ANTHROPIC_ADMIN_API_KEY with an Admin API key for the Claude Console organization, then redeploy. A standard ANTHROPIC_API_KEY cannot access cost reports.",
      xaiAuth:
        "Verify that XAI_MANAGEMENT_API_KEY is a Management Key with the required team permission and that XAI_TEAM_ID belongs to the same xAI team. A standard XAI_API_KEY cannot access Management Usage.",
      openaiAuth:
        "Replace OPENAI_ADMIN_API_KEY with an Organization Admin API key created by an Organization Owner, then redeploy.",
      xaiTeamNotFound:
        "Copy the Team ID from the active xAI Console team settings into XAI_TEAM_ID, then redeploy.",
      googleAuth:
        "Grant the configured service account BigQuery Job User on the query project and BigQuery Data Viewer on the billing-export dataset, then retry yesterday's sync.",
      googleJobIncomplete:
        "The bounded BigQuery job did not finish. Retry once; if it repeats, verify that the export table is partitioned and contains billing rows for the selected date.",
      googleDefault:
        "Verify GOOGLE_CLOUD_BILLING_EXPORT_TABLE and the billing service-account JSON. Billing export data can arrive several hours late.",
      alibabaNonUsd:
        "Tomverse will not guess a foreign-exchange rate. Use the international USD billing account or reconcile the non-USD Alibaba bill separately.",
      alibabaAuth:
        "Grant the RAM identity AliyunBSSReadOnlyAccess (or bssapi:QueryInstanceBill) and verify the AccessKey pair.",
      alibabaDefault:
        "Verify the Singapore BSS endpoint and optional ALIBABA_CLOUD_BILLING_PRODUCT_CODE. Daily instance bills can be delayed by about one day.",
      xaiLimitReached:
        "xAI returned only a subset of the requested usage series, so Tomverse did not store the partial total. Retry the single-day sync; if it repeats, review the xAI Usage Explorer and retain the Tomverse trace.",
      openaiRateLimited:
        "The automatic retry policy was exhausted. Wait for the provider retry window, then run the sync again.",
      rateLimited: "Wait for the provider retry window, then run the sync again.",
      anthropicServerError:
        "Anthropic returned a server error. Retry later and retain the provider request ID and Tomverse trace for support.",
      openaiServerError:
        "OpenAI returned a server error after automatic retries. Retry later and retain both request IDs for support.",
    },
    syncFailed: "Sync failed.",
    eyebrow: "Usage reconciliation",
    title: "Sync provider usage APIs",
    description:
      "Pull provider-reported spend for a day and store it beside Tomverse internal metering. Providers with supported response-level accounting show internal usage when an aggregate cost API is unavailable; remaining providers without a configured usage endpoint are skipped.",
    syncing: "Syncing",
    syncNow: "Sync now",
    synced: (count: number) => `${count} synced`,
    internal: (count: number) => `${count} internal`,
    skipped: (count: number) => `${count} skipped`,
    failed: (count: number) => `${count} failed`,
    date: (date: string) => `Date ${date}`,
    internalCost: (amount: string) => `Internal estimated cost ${amount}`,
    reportedCost: (amount: string) => `Reported net cost ${amount}`,
    usageSource: (label: string) => `Usage source: ${label}`,
    reconciliation: (label: string) => `Provider reconciliation: ${label}`,
    internalUsage: (requests: number, input: string, cached: string, output: string) =>
      `${requests} requests · ${input} input · ${cached} cached · ${output} output tokens`,
    viewFailureDetails: "View failure details",
    source: "Source",
    endpoint: "Endpoint",
    http: "HTTP",
    code: "Code",
    noResponse: "No response",
    unknown: "Unknown",
    requestsAttempted: "Requests attempted",
    elapsed: "Elapsed",
    perRequestTimeout: "Per-request timeout",
    failureStageLabel: "Failure stage",
    providerDetail: "Provider detail",
    providerRequestId: "Provider request ID",
    notReturned: "Not returned",
    tomverseTrace: "Tomverse trace",
    recommendedCheck: "Recommended check",
  },
  ko: {
    failureStage: {
      connection: "응답 헤더 대기",
      response: "공급자 응답 읽기",
      provider_http: "공급자 HTTP 응답",
      payload: "공급자 payload 검증",
      storage: "대조 결과 저장",
    },
    guidance: {
      openaiConnect:
        "자동 재시도 후에도 Tomverse가 HTTP 응답을 받지 못했습니다. 이 결과로는 인증 문제를 진단할 수 없습니다. 배포 후에도 반복되면 Admin API key를 교체하기 전에 Railway outbound DNS/TLS와 api.openai.com HTTPS 접근을 확인하세요.",
      openaiResponseTimeout:
        "OpenAI가 응답했지만 응답 본문이 제시간에 끝나지 않았습니다. 한 번 재시도하고, 반복되면 에스컬레이션할 때 공급자 request ID와 Tomverse trace를 함께 전달하세요.",
      anthropicTimeout:
        "Anthropic Cost API가 10초 안에 끝나지 않았습니다. 한 번 재시도하고, 반복되면 에스컬레이션할 때 공급자 request ID와 Tomverse trace를 함께 전달하세요.",
      anthropicAuth:
        "ANTHROPIC_ADMIN_API_KEY를 Claude Console 조직의 Admin API key로 교체한 뒤 다시 배포하세요. 일반 ANTHROPIC_API_KEY로는 비용 보고서에 접근할 수 없습니다.",
      xaiAuth:
        "XAI_MANAGEMENT_API_KEY가 필요한 팀 권한을 가진 Management Key인지, XAI_TEAM_ID가 같은 xAI 팀에 속하는지 확인하세요. 일반 XAI_API_KEY로는 Management Usage에 접근할 수 없습니다.",
      openaiAuth:
        "OPENAI_ADMIN_API_KEY를 Organization Owner가 만든 Organization Admin API key로 교체한 뒤 다시 배포하세요.",
      xaiTeamNotFound:
        "활성 xAI Console 팀 설정의 Team ID를 XAI_TEAM_ID에 복사한 뒤 다시 배포하세요.",
      googleAuth:
        "설정된 service account에 query 프로젝트의 BigQuery Job User와 billing-export dataset의 BigQuery Data Viewer 권한을 부여한 뒤 어제 동기화를 다시 실행하세요.",
      googleJobIncomplete:
        "제한된 BigQuery job이 끝나지 않았습니다. 한 번 재시도하고, 반복되면 export 테이블이 파티션되어 있고 선택한 날짜의 결제 행이 있는지 확인하세요.",
      googleDefault:
        "GOOGLE_CLOUD_BILLING_EXPORT_TABLE과 결제 service-account JSON을 확인하세요. 결제 export 데이터는 몇 시간 늦게 도착할 수 있습니다.",
      alibabaNonUsd:
        "Tomverse는 환율을 추정하지 않습니다. 국제 USD 결제 계정을 사용하거나 USD가 아닌 Alibaba 청구서는 따로 대조하세요.",
      alibabaAuth:
        "RAM identity에 AliyunBSSReadOnlyAccess(또는 bssapi:QueryInstanceBill)를 부여하고 AccessKey 쌍을 확인하세요.",
      alibabaDefault:
        "Singapore BSS endpoint와 선택 항목인 ALIBABA_CLOUD_BILLING_PRODUCT_CODE를 확인하세요. 일별 인스턴스 청구는 약 하루 지연될 수 있습니다.",
      xaiLimitReached:
        "xAI가 요청한 사용량 시계열의 일부만 반환해 Tomverse는 부분 합계를 저장하지 않았습니다. 하루 단위 동기화를 다시 실행하고, 반복되면 xAI Usage Explorer를 확인하고 Tomverse trace를 보관하세요.",
      openaiRateLimited:
        "자동 재시도 정책을 모두 소진했습니다. 공급자 재시도 대기 시간이 지난 뒤 동기화를 다시 실행하세요.",
      rateLimited: "공급자 재시도 대기 시간이 지난 뒤 동기화를 다시 실행하세요.",
      anthropicServerError:
        "Anthropic이 서버 오류를 반환했습니다. 나중에 다시 시도하고, 지원 요청용으로 공급자 request ID와 Tomverse trace를 보관하세요.",
      openaiServerError:
        "자동 재시도 후 OpenAI가 서버 오류를 반환했습니다. 나중에 다시 시도하고, 지원 요청용으로 두 request ID를 모두 보관하세요.",
    },
    syncFailed: "동기화에 실패했습니다.",
    eyebrow: "사용량 대조",
    title: "공급자 사용량 API 동기화",
    description:
      "하루치 공급자 보고 지출을 가져와 Tomverse 내부 계측 옆에 저장합니다. 응답 단위 집계를 지원하는 공급자는 집계 비용 API가 없을 때 내부 사용량을 표시하고, 사용량 endpoint가 설정되지 않은 나머지 공급자는 건너뜁니다.",
    syncing: "동기화 중",
    syncNow: "지금 동기화",
    synced: (count: number) => `동기화 ${count}`,
    internal: (count: number) => `내부 ${count}`,
    skipped: (count: number) => `건너뜀 ${count}`,
    failed: (count: number) => `실패 ${count}`,
    date: (date: string) => `날짜 ${date}`,
    internalCost: (amount: string) => `내부 추정 비용 ${amount}`,
    reportedCost: (amount: string) => `보고된 순비용 ${amount}`,
    usageSource: (label: string) => `사용량 출처: ${label}`,
    reconciliation: (label: string) => `공급자 대조: ${label}`,
    internalUsage: (requests: number, input: string, cached: string, output: string) =>
      `요청 ${requests}건 · 입력 ${input} · 캐시 ${cached} · 출력 ${output} 토큰`,
    viewFailureDetails: "실패 상세 보기",
    source: "출처",
    endpoint: "Endpoint",
    http: "HTTP",
    code: "코드",
    noResponse: "응답 없음",
    unknown: "알 수 없음",
    requestsAttempted: "시도한 요청 수",
    elapsed: "경과 시간",
    perRequestTimeout: "요청당 timeout",
    failureStageLabel: "실패 단계",
    providerDetail: "공급자 상세",
    providerRequestId: "공급자 request ID",
    notReturned: "반환되지 않음",
    tomverseTrace: "Tomverse trace",
    recommendedCheck: "권장 점검",
  },
});
