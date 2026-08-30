# Google 웹 검색 staging 검증 체크리스트

template revision `2026-08-27`

이 문서는 **항목만** 가진 template입니다. 결과는
`app-managed-web-search-staging-verification-records/`에 실행 1회 = 파일 1개로
남깁니다. 여기에는 체크 표시도 승인표도 넣지 않습니다.

정책: `docs/policy/credit-and-cost-limits.md`의 "Application-managed web search".
운영 설정: `docs/ops/web-search-backend.md`.

## 무엇이 릴리스를 막고, 무엇이 막지 않는가

`AGENTS.md`의 "검증 범위는 되돌릴 수 없는 것에 비례합니다"에 따라, **되돌릴 수
없는 것만** 차단 항목입니다.

**차단 (§A · §B · §C)**

- **강제되지 않은 지출.** turn당 backend 요청이 5회를 넘거나, 예약과 정산이
  어긋나면 되돌릴 수 없습니다 — 돈은 이미 나갔고 회수가 성립하지 않습니다.
- **검색하지 않은 turn의 8크레딧 미환불.** 사용자 크레딧이 부당하게 소모된
  상태이고, 환불은 사람이 손으로 되돌려야 합니다.
- **credential·예산 누락 상태에서의 production 기동.** 상한 없는 vendor 지출.

**차단 아님 (§D 이하)**

- 라벨, 문구, citation 목록의 배열, badge 위치, 검색 결과의 품질·개수.
  전부 고쳐서 배포하면 끝나는 것들입니다. 실패해도 기록에 남기고 후속 티켓을
  다는 것으로 충분합니다.

## 비용

유료 turn은 **4회**(§D 각 1회)이며, 각 8크레딧 surcharge + 모델 기본 크레딧이
듭니다. §A·§B·§C는 무료입니다(HTTP 응답과 Admin Console 조회).

시료·정답지·기록 초안은 에이전트가 준비합니다. 사람이 하는 것은 **유료 turn
실행 · 답 내용 판정 · 서명** 뿐입니다.

## A. 배포 전 설정 (무료, 차단)

- [ ] `BRAVE_SEARCH_API_KEY`가 staging에 설정되어 있다.
- [ ] `SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_DAY` ·
      `_PER_MONTH`가 설정되어 있고 floor(39,062,500) 이상이다.
- [ ] `WEB_SEARCH_FAKE_BACKEND`가 **설정되어 있지 않다**.
- [ ] `GET /api/ready`가 200이고 `checks.searchProviderBudget`가 `true`다.
- [ ] 변수 하나를 일시적으로 제거하면 `/api/ready`가 503이 되고
      `checks.searchProviderBudget`가 `false`가 된다. (확인 후 되돌린다.)

## B. 상한과 예약 (무료, 차단)

- [ ] Admin Console 또는 DB에서 `ChatUsageBucket`의
      `search-provider:brave` / `search-cost-day` 행의 시작 값을 기록한다.
- [ ] §D 실행 후 같은 행을 다시 읽어, 증가분이 **성공한 backend 요청 수 ×
      5,000 µUSD**와 정확히 일치한다.
- [ ] 어떤 turn의 `searchMetadata.backendRequestCount`도 **5를 넘지 않는다**.
- [ ] `provider:google` 행에는 검색 비용이 **들어가지 않았다** — 증가분이
      토큰 비용만으로 설명된다.

## C. 크레딧 정산 (무료, 차단)

- [ ] §D-4(검색이 불필요한 질문)의 turn에서 **8크레딧이 환불**되어, 그 turn의
      최종 차감이 모델 기본 크레딧과 같다.
- [ ] §D-1~3의 turn에서 8크레딧이 **한 번만** 정산됐다(질의 수에 비례하지
      않는다).

## D. 유료 turn 4회 (각 1회, 비차단 — 답의 내용 판정)

각 prompt는 **정확히 이 문장**을 씁니다. 답 내용 판정 기준은
`app-managed-web-search-staging-verification-records/README.md`의 정답지에
있습니다.

### D-1. Gemini 3.7 Flash — 최신 사실 검색과 citation

- [ ] 웹 검색 스위치를 켜고 **Gemini 3.7 Flash만** 선택한다.
- [ ] prompt:

  > 오늘 기준으로 Brave Search API의 "Data for AI" 요금제 가격이 1,000
  > 요청당 얼마인지, 출처 URL과 함께 알려 줘.

- [ ] 답변에 source badge와 citation 목록이 보인다.
- [ ] citation의 URL이 **실제로 열린다**(모델이 지어낸 주소가 아니다).
- [ ] `searchMetadata.queryCount ≥ 1`, `executionKind: "app_managed"`,
      `searchBackend: "brave"`.

### D-2. Gemini 3.6 Flash — 복수 query, 5회 이하

- [ ] 웹 검색을 켜고 **Gemini 3.6 Flash만** 선택한다.
- [ ] prompt:

  > OpenAI, Anthropic, Google이 각각 가장 최근에 공개한 주력 언어 모델의
  > 이름과 공개일을 정리해 줘. 회사마다 출처를 하나씩 달아 줘.

- [ ] `backendRequestCount`가 2 이상 5 이하다.
- [ ] 세 회사 각각에 대한 citation이 있다.

### D-3. Gemini 3.1 Pro — 검색 결과로 파일 생성

- [ ] 웹 검색을 켜고 **Gemini 3.1 Pro만** 선택한다.
- [ ] prompt:

  > 위 세 회사의 최신 모델 정보를 검색해서, 회사·모델명·공개일·출처 URL
  > 네 개 열을 가진 xlsx 파일로 만들어 줘.

- [ ] 다운로드 카드가 나오고 **xlsx가 열린다**(csv로 대체되지 않았다).
- [ ] 같은 turn에 citation 목록도 있다 — 검색과 파일 생성이 **공존**했다.
- [ ] artifact tool이 `native_search_conflict`로 꺼지지 않았다.

### D-4. Gemini 3.5 Flash-Lite — 검색 0회와 환불

Tomverse ID는 `gemini-2-5-flash`이고 상위 apiModel은 `gemini-3.5-flash-lite`
입니다.

- [ ] 웹 검색을 **켠 채로** 이 모델만 선택한다.
- [ ] prompt:

  > 다음 문장을 존댓말로 바꿔 줘: "내일 회의 몇 시에 시작하는지 알려줘."

- [ ] 답변 badge가 "검색하지 않음 · 8크레딧 환불"이다.
- [ ] `searchMetadata.executed: false`, `backendRequestCount: 0`.
- [ ] 검색 결과 목록이 **없다**.

## E. 표면 일관성 (비차단)

- [ ] 모델 선택기에서 네 Google 모델 모두 "웹 검색" 배지를 가진다.
- [ ] "웹 검색" 필터에 네 모델이 모두 나온다.
- [ ] Google 모델만 선택했을 때 "웹 검색 불가" 차단 문구가 **없다**.
- [ ] Google + OpenAI 혼합 선택에서 지원/미지원 개수가 맞는다.
- [ ] 최대 추가 크레딧 표시가 모델당 8이다.
- [ ] 모바일 composer에서 textarea가 자기 행을 온전히 차지한다
      (`docs/ui-contracts/mobile-chat-composer.md`).

## F. 안전 (비차단이지만 관찰 필수)

- [ ] 검색 결과에 지시문처럼 보이는 문장이 포함된 페이지가 나왔을 때, 모델이
      그것을 **보고**하고 **따르지** 않았다. (재현되지 않으면 `n/a`.)
- [ ] 구조화 로그 `app_managed_web_search`에 **query 원문이 없다**.
- [ ] 어떤 사용자 응답에도 원시 내부 USD가 없다.
