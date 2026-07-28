# 프로바이더 프로브 staging 재감사 보고서

- 감사일: 2026-07-27
- 대상: `mposition/Tomverse` — AUD-R001 합성 프로바이더 프로브 (`lib/providerProbe.ts`, `app/api/internal/provider-probe/check/route.ts`, `lib/providerMonitoring.ts`)
- 관측 구간: staging 프로브 사이클 2026-07-27 20:10Z ~ 21:10Z (10분 간격 7사이클) + 직전 1시간 `ProviderProbeResult` 집계 (6사이클)
- 데이터 출처: Railway MCP (`get-logs`, `list-deployments`, `list-services`), staging Postgres 직접 조회 결과(운영자 제공), Sentry MCP, 리포지토리 코드
- 이 문서는 **감사 보고서이며, 여기서 기술한 수정은 이미 구현·커밋·병합되었습니다** (`469d5aa`, `dcac85f`, 및 파라미터 수정 커밋). 미해결 항목은 6장에 분리했습니다.

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
| openai | `gpt-5.4-mini` | 6/6 실패 HTTP 400 | **프로브 결함** — `maxOutputTokens: 8`이 최소값 16 미만 |
| moonshot | `kimi-k2.7-code` | 6/6 실패 HTTP 400 | **프로브 결함** — `temperature: 0` 거부 |
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

### F-07 (High) — 프로브 요청 파라미터가 일부 프로바이더에서 거부됨

`temperature: 0`과 `maxOutputTokens: 8`이 두 프로바이더에서 각각 거부됐습니다 `[측정]`.

- openai: `Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 8 instead.` — 상수 8이 OpenAI 최소값 16 미만.
- moonshot: `invalid temperature: only 1 is allowed for this model` — `kimi-k2.7-code`가 기본값 외 temperature를 거부.

F-01·F-02와 동일한 성격입니다. 프로바이더는 정상인데 프로브가 보낸 요청이 잘못됐고, 그 결과가 프로바이더 건강 신호로 집계됐습니다. 이 항목은 **F-03/F-04 수정이 없었다면 규명 자체가 불가능했습니다** — 두 건 모두 수정 전에는 진단 메시지 없는 `UNKNOWN`이었습니다.

이 발견은 본 감사에서 **F-03/F-04 수정이 실제로 값을 냈다는 증거**이기도 합니다. 관측성 수정을 먼저 넣지 않았다면 두 건은 지금도 원인 불명으로 남아 있었을 것입니다.

### F-08 (High) — `lib/models.ts`의 기존 모델 수정은 런타임에 반영되지 않음

**이 항목은 본 감사 자체의 오류에 대한 정정입니다.**

`lib/models.ts`는 런타임 소스가 아니라 **시드**입니다. `ensureModelRegistrySeeded`가 `createMany({ data: staticSeedRows(), skipDuplicates: true })`로 삽입만 하고 **기존 행은 절대 갱신하지 않습니다** (`modelRegistry.ts:138-150`) `[코드]`. 런타임 조회는 전부 `ModelRegistryEntry`를 읽습니다.

그 결과 커밋 `dcac85f`에서 `llama-4-scout`를 `enabled: false`로 바꾼 것은 **사용자에게 아무 효과가 없었습니다.** 실제로 바뀐 것은 두 가지뿐입니다.

- 프로브 동작 — `getProbeModelFor`는 정적 `AVAILABLE_MODELS`를 읽으므로 groq이 `llama-3-1`로 전환됨 (5.1의 실측이 이것입니다)
- 신규 DB를 시드할 때의 초기값

즉 기존 배포의 `ModelRegistryEntry`에서 `llama-4-scout`는 여전히 `enabled: true`이고, 사용자는 계속 선택할 수 있으며 선택 시 404로 실패합니다 `[코드]`. F-05의 실사용자 영향은 **이 감사 시점에도 해소되지 않은 상태였습니다.**

정적 파일 수정이 런타임에 무효라는 점 자체가 재발 가능한 함정입니다. 4장의 자동 반영이 이 특정 건을 해소하지만, 정적 레지스트리와 DB 레지스트리의 일반적인 동기화는 여전히 없습니다.

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
- **주의:** 이 변경은 정적 시드만 바꾸며 기존 배포의 DB 레지스트리에는 반영되지 않습니다. F-08과 4장의 자동 반영을 함께 보십시오.
- 후속 참조 정리: 비교 리뷰어 기본 패널이 groq 항목을 유지하도록 `llama-3-3`로 교체, multimodal 추천 목록에서 제거, 첨부 e2e 테스트를 guest 등급 비전 모델 `gemini-2-5-flash`로 재지정.

### 세 번째 커밋 — 프로브 요청 파라미터 (F-07)

병합 후 staging 로그가 규명해준 두 파라미터를 수정했습니다.

- `PROBE_MAX_OUTPUT_TOKENS` 8 → 32. 최소값 16에 맞추지 않고 여유를 둔 것은, 이 예산이 reasoning 토큰까지 흡수해야 하는 모델이 있기 때문입니다.
- `temperature: 0` 제거. 프로브는 호출 성공 여부만 확인하므로 샘플링을 고정할 이유가 없고, 파라미터를 생략하면 각 프로바이더 기본값을 따라가 이 계열의 거부가 통째로 사라집니다.
- 두 값을 고정하는 회귀 테스트 추가 — 실제 staging 실패 문구를 주석에 남겨 재발 시 맥락이 유지되도록 했습니다.
### 네 번째 커밋 — 카탈로그 → 레지스트리 자동 반영 (F-05)

탐지는 되는데 강제력이 없던 부분을 닫았습니다. 레지스트리에 이미 있던 폐기 필드를 쓰고, 병렬 메커니즘을 만들지 않았습니다.

- 결정 로직은 `planCatalogReconciliation`(순수 함수, `providerModelCatalogCore.ts`)에 두고 DB 경계는 `providerModelCatalogReconciliation.ts`가 담당합니다 — 리포지토리의 기존 `*Core.ts` 패턴을 따랐습니다.
- **비활성화만 하고 삭제하지 않습니다.** `catalogDeleted`는 관리자 삭제 엔드포인트가 쓰는 필드이고 모든 런타임 조회에서 행을 숨기므로 사람의 결정으로 남겨뒀습니다. `enabled: false`만으로 사용자 선택은 차단됩니다.
- **되돌릴 수 있습니다.** `operationalReason`에 마커를 남기고, 모델이 카탈로그에 다시 나타나면 **그 마커가 있는 행만** 복구합니다. 운영자가 의도적으로 비활성화한 모델을 자동으로 되살리지 않습니다.
- **프로바이더의 활성 모델 전체를 한 번에 비활성화하지 않습니다.** 전체 소실은 실제 폐기보다 카탈로그 응답 절삭일 가능성이 높아, 이 경우 작업을 보류하고 `PROVIDER_MODEL_CATALOG_RECONCILIATION_HELD` 인시던트를 올립니다.
- 완료되지 않은 체크(`failed`/`skipped`)는 근거로 삼지 않습니다.
- `PROVIDER_MODEL_CATALOG_AUTO_DISABLE=false`로 자동화를 끄면 기존처럼 통보 전용으로 돌아갑니다.
- 일일 리포트에 "Registry auto-updates" 섹션과 요약 카운트를 추가했습니다. Slack은 저장된 템플릿이라 새 변수를 무시하므로 기존 summary 줄에 접어 넣었습니다.

groq `llama-4-scout`는 이미 `consecutiveMissing: 7`이므로 다음 카탈로그 실행에서 DB 레지스트리가 자동으로 비활성화됩니다 — F-08이 드러낸 실사용자 노출이 이것으로 해소됩니다 `[추정]`.

---

## 5. 검증 결과

| 항목 | 결과 |
|---|---|
| 유닛 테스트 (`npm run test:unit`) | **494개 전부 통과** |
| 타입체크 (`next typegen && tsc --noEmit`) | 통과 (exit 0) |
| ESLint (`--max-warnings=0`) | 통과 (exit 0) |
| 프로브 모델 선택 (11개 프로바이더 실행 검증) | perplexity → `no_probe_model`, groq → `llama-3.1-8b-instant`(카탈로그 `available`), 나머지 9개 변동 없음 |
| `MONITORED_PROVIDERS` | 11개 유지 |

### 5.1 staging 실환경 재검사 `[측정]`

병합(`bb0e7c7`) 후 staging 배포 완료(23:32:00Z) 기준 첫 사이클:

```
23:40:55Z  succeeded: 8, failed: 2, noProbeModel: 1
```

수정 전 `succeeded: 6, failed: 5`에서 바뀐 내역이 전부 의도한 대로입니다 — perplexity가 허위 실패에서 `noProbeModel`로 이동(집계에서 사라지지 않고 명시), groq이 `llama-3.1-8b-instant`로 정상 성공, 남은 실패는 openai·moonshot 2건.

> 참고: 직전 23:30:48Z 사이클은 `succeeded: 7, failed: 4, noProbeModel: undefined`를 기록했으나 **검증 근거가 아닙니다.** 크론 컨테이너만 새 빌드였고 호출 대상 웹 서비스는 아직 구 빌드였습니다(웹 배포 완료 23:32:00Z). `noProbeModel: undefined`가 그 증거입니다.

파라미터 수정(F-07)까지 배포된 뒤(웹 배포 완료 23:53:51Z) 최종 사이클:

```
00:00:37Z  succeeded: 9, failed: 1, noProbeModel: 1
```

남은 실패 1건은 google이며, 같은 사이클의 실패 로그가 `errorClassification: 'TIMEOUT'` / `latencyMs: 10001`로 기록했습니다 `[측정]` — 프로브 결함이 아니라 **실제 프로바이더 불안정이고, 프로브가 설계대로 동작하고 있다는 신호**입니다. openai·moonshot은 실패 목록에서 사라졌습니다.

11개 프로바이더가 전부 설명되는 상태로 종료했습니다 — 성공 9, 실제 장애 1, 프로브 대상 제외 1. 감사 착수 시점의 `succeeded: 6, failed: 5`와 대비됩니다.

### 5.2 F-03/F-04 수정이 실제로 원인을 규명함 `[측정]`

새로 추가한 실패 로그가 같은 사이클에서 남긴 내용이 남은 2건을 그대로 종결시켰습니다:

```
provider: 'openai',   errorClassification: 'BAD_REQUEST',
errorMessage: "Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 8 instead."

provider: 'moonshot', errorClassification: 'BAD_REQUEST',
errorMessage: 'invalid temperature: only 1 is allowed for this model'
```

수정 전이라면 두 건 모두 `UNKNOWN` 분류에 진단 메시지 없이 DB에만 남았을 내용입니다.

---

## 6. 미해결 항목

### 6.1 정적 레지스트리 ↔ DB 레지스트리 일반 동기화 (F-08)

4장의 자동 반영은 **카탈로그가 소실을 증명한 모델**만 처리합니다. `lib/models.ts`에서 기존 모델의 이름·가격·능력·플랜 등을 수정하는 일반적인 변경은 여전히 런타임에 반영되지 않으며, 이를 알아챌 방법도 없습니다(조용히 무효가 됩니다).

최소한의 보완은 배포 시점에 정적 시드와 DB 행의 차이를 감지해 경고하는 체크입니다. 어느 쪽을 진실로 삼을지는 제품 결정이라 손대지 않았습니다.

### 6.2 groq 비전 모델 공백

`llama-4-scout` 폐기로 groq에 이미지 입력 모델이 없습니다. 카탈로그의 groq `candidate` 항목(`qwen/qwen3.6-27b`, `openai/gpt-oss-120b` 등)에 비전 지원 모델이 있는지는 각 모델의 실제 입력 능력 확인이 필요하며, 이 환경에서는 조회가 불가능했습니다.

---

## 7. 감사 환경 제약

다음 경로가 차단되어 조사 방법에 영향을 주었습니다. 결론의 근거를 판단할 때 참고가 필요합니다.

- `staging.tomverse.app` 및 `tomverse-staging.up.railway.app` — 환경 네트워크 정책이 CONNECT에 403 응답. 공개 상태 엔드포인트 직접 조회 불가.
- Railway `list-variables` — 시크릿 평문 반환으로 권한 분류기가 차단. 프로바이더 키 설정 여부를 직접 확인하지 못했습니다(다만 `AUTH` 분류 0건으로 자격증명 가설은 다른 경로로 기각됨).
- staging Postgres — 컨테이너에서 직접 도달 불가. 2.2·2.3장 데이터는 **운영자가 직접 실행해 제공한 결과**입니다.
- 로컬 프로바이더 API 키 부재로 프로브의 로컬 재현 불가.
