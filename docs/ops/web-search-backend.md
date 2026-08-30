# 웹 검색 backend 운영

Google 모델의 웹 검색은 provider의 grounding이 아니라 **이 애플리케이션이
실행하는 function tool**입니다. 배경과 승인된 값은
`docs/policy/credit-and-cost-limits.md`의 "Application-managed web search"에
있습니다. 이 문서는 그것을 굴리기 위해 무엇을 설정해야 하는지만 다룹니다.

## 필요한 환경변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `BRAVE_SEARCH_API_KEY` | production 필수 | Brave Search API 구독 토큰. `X-Subscription-Token` 헤더로만 나갑니다. |
| `SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_DAY` | production 필수 | 일 지출 상한(micro-USD). |
| `SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_MONTH` | production 필수 | 월 지출 상한(micro-USD). |
| `WEB_SEARCH_FAKE_BACKEND` | 개발·테스트 전용 | `1`이면 결정적 fake adapter. **production에서는 설정되어 있기만 해도 readiness 실패.** |

**단위는 micro-USD입니다.** `10`은 1센트의 1,000분의 1이고, 그런 예산은 정책이
아니라 오타입니다. US$40/일이면 `40000000`입니다.

### 값을 고를 때

floor는 코드가 유도하며(`searchProviderBudgetFloorMicroUsd`) 오늘 값은 일·월
모두 **39,062,500 µUSD ≈ US$39.06**입니다. 그보다 낮게 설정하면 floor로
올려서 강제하고 그 사실을 보고합니다 — 조용히 적용하지 않습니다. 근거는 Max
계정 하나가 자기 월 크레딧 전부를 검색 turn에 쓰는 경우이며, 그보다 낮은 전역
상한은 한 계정의 entitlement보다 좁은 운영 상한이 되어 정당한 트래픽을
거절합니다.

월 값이 일 값보다 크지 않으면 통과하되 advisory를 남깁니다. 하루를 상한까지
쓰면 월이 소진되므로 월 window가 두 번째 bound 노릇을 못 한다는 뜻입니다.

## 배포 순서

**환경변수를 먼저, 코드를 나중에.** chat provider 예산과 같은 순서입니다.
capability register는 컴파일 시점에 정해지므로, Google 모델이
`app-managed`인 build가 배포되는 순간부터 credential이 필요합니다. 순서를
뒤집으면 `/api/ready`가 503을 내고 배포가 서지 않습니다.

## `/api/ready`

`checks.searchProviderBudget`가 다음일 때 실패합니다.

- production인데 활성 모델이 요구하는 backend의 credential이 없음
  (`no_backend_configured`)
- credential은 있는데 예산을 읽을 수 없음 (`budget_unusable`)
- production에서 `WEB_SEARCH_FAKE_BACKEND`가 설정됨
  (`fake_backend_in_production`)

개발·테스트에서 credential이 없는 것은 실패가 아닙니다. backend가 닿지 않는
배포로 취급되어 Google 모델이 "웹 검색 불가"로 표시되고, 그것이 사실입니다.
검색 경로를 로컬에서 돌려 보려면 `WEB_SEARCH_FAKE_BACKEND=1`을 씁니다.

## 예산이 소진되면

`SEARCH_PROVIDER_BUDGET_EXHAUSTED` 503이 나갑니다. **`PROVIDER_BUDGET_EXHAUSTED`와
다른 코드입니다** — 보아야 할 예산이 다르기 때문입니다. 사용자에게는 "웹 검색을
일시적으로 사용할 수 없다"고만 말하고, 어느 vendor인지·얼마인지는 구조화 로그와
Admin Console에만 남습니다.

사용량은 `ChatUsageBucket`의 `search-provider:brave` 행에서
`search-cost-day` · `search-cost-month` period로 읽습니다.

## 관측

- `app_managed_web_search` — tool 호출 1건마다. **query 원문은 없습니다.**
  status, 실패 코드, query 길이, 결과 수, 소요 시간만 남습니다.
- `searchMetadata.executionKind: "app_managed"` — 메시지에 저장되는 실행 기록.
  `backendRequestCount`(시도)와 `queryCount`(성공)를 함께 들고 있습니다.

## Brave 계약 확인 (2026-08-27)

- endpoint: `GET https://api.search.brave.com/res/v1/web/search`
- 인증: `X-Subscription-Token` 헤더
- 가격: "Data for AI" 플랜 US$5.00 / 1,000 requests
- 무료 할당량은 내부 비용 계산에서 **무시**합니다.

가격이 바뀌면 `lib/webSearchBackendPricing.ts`의 `pricingVersion`과
`effectiveDate`를 함께 올립니다. **과거 usage에 소급 적용하지 않습니다** —
동결된 rate가 정산을 매깁니다.
