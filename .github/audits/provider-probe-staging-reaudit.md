# 프로바이더 프로브 staging 재감사 보고서

- 감사일: 2026-07-27
- 대상: `mposition/Tomverse` — AUD-R001 합성 프로바이더 프로브 (`lib/providerProbe.ts`, `app/api/internal/provider-probe/check/route.ts`, `lib/providerMonitoring.ts`)
- 관측 구간: staging 프로브 사이클 2026-07-27 20:10Z ~ 21:10Z (10분 간격 7사이클) + 직전 1시간 `ProviderProbeResult` 집계 (6사이클)
- 데이터 출처: Railway MCP (`get-logs`, `list-deployments`, `list-services`), staging Postgres 직접 조회 결과(운영자 제공), Sentry MCP, 리포지토리 코드
- 이 문서는 **감사 보고서이며, 여기서 기술한 수정은 이미 구현·커밋되었습니다** (`469d5aa`, `dcac85f`). 미해결 항목은 6장에 분리했습니다.

> **표기 규칙**
> - `[측정]` = staging 실데이터(로그·DB·Railway·Sentry)에서 확인된 값
> - `[코드]` = 리포지토리 코드에서 직접 확인된 사실
> - `[추정]` = 위에서 유도한 판단. 실측이 아님.

---

## 1. 최종 판정

### **프로브가 정상 프로바이더를 공개 장애로 보고하는 상태 — 프로덕션 배포 전 차단 필요**

staging에서 11개 프로바이더 중 5개가 매 10분 사이클마다 실패하고 있었습니다 `[측정]`. 조사 결과 **자격증명 문제가 아니었고**(`AUTH` 분류 0건 `[측정]`), 실패 5건 중 3건은 프로바이더가 아니라 **프로브 자신의 결함**이었습니다.

| 프로바이더 | 프로브 모델 (apiModel) | 관측 결과 | 원인 |
|---|---|---|---|
| perplexity | `sonar` | 6/6 실패 HTTP 400 | **프로브 결함** — 검색 모델을 호출 |
| groq | `meta-llama/llama-4-scout-17b-16e-instruct` | 6/6 실패 HTTP 404 | **레지스트리 드리프트** — 실사용자도 영향 |
| openai | `gpt-5.4-mini` | 6/6 실패 HTTP 400 | **프로브 결함** — 요청 파라미터 거부 |
| moonshot | `kimi-k2.7-code` | 6/6 실패 HTTP 400 | **프로브 결함** — 요청 파라미터 거부 |
| google | `gemini-3.5-flash` | 4 성공 / 503·타임아웃 각 1 | 실제 프로바이더 불안정 (정상 동작) |
| 나머지 6개 | — | 6/6 성공 | 정상 |

핵심 결론은 하나입니다. **AUD-R001은 유휴 프로바이더가 공개 상태 페이지에서 "unknown"으로 남는 문제를 없애려 도입됐지만, 현재 구현은 그것을 "정상 프로바이더의 허위 incident"라는 더 나쁜 상태로 바꿔놓았습니다.**

**완화 요인:** 프로브 크론은 프로덕션에 배포된 적이 없습니다 — 서비스 `Provider Probe`의 배포 10건이 전부 staging 환경이고, 프로덕션 조회는 "No deployment found"를 반환합니다 `[측정]`. 따라서 현재 실사용자 영향은 groq 항목 하나로 한정됩니다. 뒤집어 말하면 **수정 없이 프로덕션에 올렸을 경우 공개 상태 페이지에 정상 프로바이더 3곳의 허위 장애가 표시됐을 것입니다** `[추정]`.

---

## 2. 관측 증거

### 2.1 프로브 사이클 집계 `[측정]`

Railway `Provider Probe` 서비스(staging) 로그, 7사이클 연속:

| 시각 (UTC) | succeeded | failed |
|---|---|---|
| 20:10:48 | 6 | 5 |
| 20:20:27 | 6 | 5 |
| 20:30:35 | 7 | 4 |
| 20:40:19 | 6 | 5 |
| 20:50:17 | 6 | 5 |
| 21:00:02 | 6 | 5 |
| 21:10:09 | 6 | 5 |

`6/5`와 `7/4`의 변동은 google의 간헐 실패로 정확히 설명됩니다 — 고정 실패 4개 + google이 6사이클 중 2회 실패. DB 집계와 로그가 완전히 정합합니다.

### 2.2 `ProviderProbeResult` 직전 1시간 집계 `[측정]`

`errorClassification` / `diagnosticCode` 실측값:

| 프로바이더 | classification | diagnosticCode | 건수 |
|---|---|---|---|
| google | `SERVER_ERROR` | `PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_503.RETRYABLE` | 1 |
| google | `TIMEOUT` | `PROVIDER_PROBE_FAILED.TimeoutError` | 1 |
| groq | `UNKNOWN` | `PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_404` | 6 |
| moonshot | `UNKNOWN` | `PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_400` | 6 |
| openai | `UNKNOWN` | `PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_400` | 6 |
| perplexity | `UNKNOWN` | `PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_400` | 6 |

**`AUTH` 분류는 단 한 건도 없습니다.** 자격증명 가설은 이 데이터로 기각됩니다.

### 2.3 모델 카탈로그 교차검증 `[측정]`

`ProviderModelCatalogEntry` 조회 결과:

| provider | apiModel | status | consecutiveMissing | missingSinceAt |
|---|---|---|---|---|
| groq | `meta-llama/llama-4-scout-17b-16e-instruct` | **`likely_deprecated`** | **7** | **2026-07-21T03:40:12.564Z** |
| groq | `llama-3.1-8b-instant` | `available` | 0 | NULL |
| groq | `llama-3.3-70b-versatile` | `available` | 0 | NULL |
| moonshot | `kimi-k2.7-code` | **`available`** | 0 | NULL |

이 데이터가 두 가지를 동시에 확정합니다. groq의 404는 실제 모델 소실이며 시스템이 **6일 전부터 이미 탐지하고 있었습니다.** 반대로 moonshot의 모델은 정상 존재하므로 그 400은 드리프트가 **아닙니다.**

---

## 3. 발견 항목

### F-01 (High) — 프로브가 자신의 계약을 위반해 검색 모델을 호출

`getProbeModelFor`는 `usageClass: "standard"` 모델이 없으면 해당 프로바이더의 **모든 활성 모델**로 폴백했습니다 `[코드]`. perplexity는 전 모델이 `research`/`deep-research`이므로 폴백은 필연적으로 검색 모델 `sonar`를 선택합니다.

이는 라우트가 명시한 계약 — *"no tools/search/image/file/deep-research"* (`route.ts:29-31`) — 을 정면으로 위반합니다 `[코드]`. `sonar`에 `maxOutputTokens: 8`로 "OK 한 단어만" 요청하면 400은 예견된 결과이며, 부수적으로 **매 사이클 웹 검색 요청이 과금**됩니다.

### F-02 (High) — 허위 실패가 공개 상태 페이지를 incident로 승격

프로브 실패는 `recordProviderProbeFailure` → `ProviderHealthState.consecutiveProbeFailures` 증가 → `evaluatePublicProviderStatus`로 이어집니다 `[코드]`. 임계값은 연속 3회이고, 이를 넘으면 `degraded`가 아니라 **`incident`로 승격**됩니다 (`providerPublicStatusCore.ts:70-73, 79`) `[코드]`.

실패 4개 프로바이더는 시간당 6회씩 최소 1시간 이상 연속 실패했으므로 임계값을 크게 초과한 상태였습니다 `[측정]`.

### F-03 (Medium) — 실패가 사후 진단 불가능

`classifyProbeError`에는 401/403과 5xx 사이에 분기가 없어 **HTTP 400과 404가 모두 `UNKNOWN`으로 붕괴**했습니다 `[코드]`. 그 결과 설정 문제와 프로바이더 장애가 저장 데이터상 구분되지 않습니다.

추가로 `safeErrorMetadata`는 name·code·status만 남기고 프로바이더 메시지를 폐기합니다 `[코드]`. 이 때문에 400의 실제 사유(모델 부재인지 파라미터 거부인지)를 저장된 데이터만으로는 **끝까지 판별할 수 없었습니다.**

### F-04 (Medium) — 지속 실패에 대한 관측성 부재

프로브 실패는 `ProviderProbeResult`에 기록될 뿐 로그도 Sentry 이벤트도 남기지 않았습니다 `[코드]`. `lib/providerMonitoring.ts`는 `reportOperationalIncident`를 전혀 호출하지 않습니다(grep 0건) `[코드]`. Sentry는 정상 동작 중이며(24시간 내 이슈 2건 수신) 그럼에도 시간당 약 30건의 프로바이더 실패에 대해 이벤트가 0건이었습니다 `[측정]`.

즉 프로바이더 4곳이 무기한 실패해도 **외부에 드러나는 첫 신호는 공개 상태 페이지가 장애로 바뀌는 순간**입니다.

### F-05 (Medium) — 카탈로그 탐지와 모델 레지스트리 사이에 연결이 없음

카탈로그 모니터는 `llama-4-scout`의 소실을 2026-07-21에 기록하고 7회 연속 미검출 후 `likely_deprecated`로 승격시켰습니다 `[측정]`.

**정정 사항:** 이 신호가 조용히 묻힌 것은 아닙니다. `app/api/internal/provider-model-catalog/check/route.ts`가 `sendProviderModelCatalogReport`를 호출해 "Missing from successful provider catalogs" 섹션이 포함된 일일 이메일/Slack 리포트를 발송합니다 `[코드]`. 따라서 해당 항목은 6일간 매일 보고되고 있었을 것입니다 `[추정]`.

실제 결함은 **탐지·통보와 레지스트리 사이에 강제력이 없다는 점**입니다. `lib/models.ts`는 정적 파일이고, 카탈로그 상태를 읽어 모델을 비활성화하는 코드 경로가 없습니다 — `ProviderModelCatalogEntry`를 읽는 곳은 모니터 자신의 델타 계산뿐입니다 `[코드]`. 그 결과 모델은 6일간 `enabled: true`로 남아 사용자가 선택 가능한 상태였고, 선택 시 404로 실패했습니다.

### F-06 (Low) — `MONITORED_PROVIDERS`의 무의미한 필터

`providerSet`은 `AVAILABLE_MODELS`에서 생성되므로 zhipu 가드가 검사하던 조건은 항상 참이었고, 이 필터는 아무것도 제외할 수 없었습니다 `[코드]`. 제거 후 모니터링 대상이 11개로 동일함을 실측 확인했습니다.

---

## 4. 구현한 수정

### 커밋 `469d5aa` — 프로브 결함

- `getProbeModelFor`에서 `research`/`deep-research` usage class를 **하드 필터로 제외**. 프로브 가능한 모델이 없는 프로바이더는 `undefined`를 반환해 `no_probe_model`로 처리되며, 호출부는 이를 건강 신호로 집계하지 않습니다. 환경변수 오버라이드는 운영자용 escape hatch로 유지. (F-01, F-02)
- `classifyProbeError`에 `MODEL_NOT_FOUND`(404) / `BAD_REQUEST`(400) 분기 추가. 프로바이더 오류 이름에 포함된 숫자와의 오매칭을 막기 위해 `HTTP_` 접두사에 앵커링. (F-03)
- `runProviderProbe`가 프로바이더 원본 오류 메시지를 300자로 잘라 캡처. **운영자 로그 전용이며 `ProviderProbeResult`에는 저장하지 않습니다** — 해당 테이블의 public-safe 계약을 유지하기 위함. (F-03)
- 실패 시 프로바이더별 `console.warn` 추가. (F-04)
- `noProbeModel` 카운트를 라우트 응답과 크론 로그에 노출 — 프로브 불가 프로바이더가 집계에서 조용히 사라지지 않도록. (F-04)
- `MONITORED_PROVIDERS`의 무의미한 필터 제거. (F-06)

### 커밋 `dcac85f` — groq 모델 폐기

- `llama-4-scout`를 `enabled: false` / `status: "disabled"` / `publiclyListed: false` / `replacementModelId: "llama-3-3"`로 전환. `gemini-2-5-pro`가 이미 쓰고 있는 기존 폐기 패턴을 그대로 따랐습니다. (F-05)
- **비전 기능 손실을 명시합니다.** groq 카탈로그에 현재 비전 지원 모델이 없어 `apiModel` 교체가 불가능했고, `llama-3-3`는 텍스트 전용입니다. 이는 마이그레이션이 아니라 **groq 라인업에서 이미지 입력이 제거되는 변경**입니다.
- 후속 참조 정리: 비교 리뷰어 기본 패널이 groq 항목을 유지하도록 `llama-3-3`로 교체, multimodal 추천 목록에서 제거, 첨부 e2e 테스트를 guest 등급 비전 모델 `gemini-2-5-flash`로 재지정.

---

## 5. 검증 결과

| 항목 | 결과 |
|---|---|
| 유닛 테스트 (`npm run test:unit`) | **493개 전부 통과** |
| 타입체크 (`next typegen && tsc --noEmit`) | 통과 (exit 0) |
| ESLint (`--max-warnings=0`) | 통과 (exit 0) |
| 프로브 모델 선택 (11개 프로바이더 실행 검증) | perplexity → `no_probe_model`, groq → `llama-3.1-8b-instant`(카탈로그 `available`), 나머지 9개 변동 없음 |
| `MONITORED_PROVIDERS` | 11개 유지 |

수정 후 예상되는 사이클 출력은 `succeeded 7~8 / failed 2~3 / noProbeModel 1`입니다 `[추정]` — perplexity의 허위 실패가 제거되고, groq이 정상 모델로 전환되며, openai·moonshot 2건과 google 간헐 실패만 남습니다.

**staging 재검사 제약:** staging은 `develop`에서 배포되고 본 수정은 작업 브랜치에만 있으므로, **실제 staging 재검사는 머지 이후에만 가능합니다.** 본 보고서의 검증은 로컬 동작 검증까지입니다.

---

## 6. 미해결 항목

### 6.1 openai / moonshot의 HTTP 400 — 파라미터 문제로 좁혀졌으나 미확정

두 건 모두 **모델 드리프트가 아님이 확정**됐습니다. moonshot은 카탈로그가 `available`로 확인했고 `[측정]`, openai `gpt-5-4-mini`는 `DEFAULT_MODEL_ID`(`models.ts:132`)이므로 이 모델이 실제로 죽었다면 제품 기본 모델이 통째로 정지한 상태여야 합니다 `[코드]`. 따라서 실패 원인은 **프로브의 요청 형태**입니다 `[추정]`.

후보 파라미터는 `temperature: 0`과 `maxOutputTokens: 8` 두 가지입니다 `[코드]`. 다만 동일한 파라미터로 xai·qwen·zhipu·deepseek·mistral이 정상 성공하므로, 파라미터 단독으로는 차이를 설명하지 못합니다.

관련 정황으로, `getActiveAiModel`에서 **openai만 `createOpenAI(configuration)(model.apiModel)` 기본 호출**을 쓰고 나머지 10개는 모두 `.chat()`을 명시합니다 `[코드]`. `@ai-sdk/openai` 4.0.20의 타입 시그니처상 이 기본 호출은 `(modelId: OpenAIResponsesModelId)` — 즉 **Responses API**입니다 `[코드]`. openai만 다른 API 표면을 타는 것이 400의 유력한 배경입니다 `[추정]`. moonshot은 `.chat()`이므로 이 설명이 적용되지 않아 별개 원인으로 남습니다.

**해결 경로:** 커밋 `469d5aa`가 추가한 프로바이더 오류 메시지 로깅이 정확히 이 판별을 위한 것입니다. 머지 후 첫 사이클의 `Provider probe failed:` 로그에 거부된 파라미터명이 그대로 남으므로, 그 시점에 1줄 수정으로 종결 가능합니다.

### 6.2 카탈로그 → 레지스트리 자동 반영 (F-05)

탐지·통보는 동작하지만 강제력이 없습니다. `likely_deprecated` 상태가 일정 기간 지속된 모델을 자동으로 비활성화하거나, 최소한 배포 시점에 실패시키는 체크가 없습니다. 이는 감사 범위를 넘는 기능 추가이므로 별도 과제로 제안합니다.

### 6.3 groq 비전 모델 공백

`llama-4-scout` 폐기로 groq에 이미지 입력 모델이 없습니다. 카탈로그의 groq `candidate` 항목(`qwen/qwen3.6-27b`, `openai/gpt-oss-120b` 등)에 비전 지원 모델이 있는지는 각 모델의 실제 입력 능력 확인이 필요하며, 이 환경에서는 조회가 불가능했습니다.

---

## 7. 감사 환경 제약

다음 경로가 차단되어 조사 방법에 영향을 주었습니다. 결론의 근거를 판단할 때 참고가 필요합니다.

- `staging.tomverse.app` 및 `tomverse-staging.up.railway.app` — 환경 네트워크 정책이 CONNECT에 403 응답. 공개 상태 엔드포인트 직접 조회 불가.
- Railway `list-variables` — 시크릿 평문 반환으로 권한 분류기가 차단. 프로바이더 키 설정 여부를 직접 확인하지 못했습니다(다만 `AUTH` 분류 0건으로 자격증명 가설은 다른 경로로 기각됨).
- staging Postgres — 컨테이너에서 직접 도달 불가. 2.2·2.3장 데이터는 **운영자가 직접 실행해 제공한 결과**입니다.
- 로컬 프로바이더 API 키 부재로 프로브의 로컬 재현 불가.
