# Trace 기반 오류 신고 자동화 정책

사용자 오류 신고를 Trace 증거와 연결하고, 장기적으로 제한된 자동 수정까지
확장하기 위한 3단계 rollout의 경계와 invariant를 정의한다. 이 문서는
`AGENTS.md`의 요약 invariant가 가리키는 원본이다.

## 1. 3단계 rollout

| Phase | 범위 | 상태 |
|---|---|---|
| 1 | 메시지별 Trace 상관관계, 서버 발급 token, Trace evidence 모델, Admin 표시 | **구현됨** |
| 2 | case 상태 머신, 증거 수집(collector), 적격성 판정, 진단 보고서 (diagnosis-only shadow mode) | **구현됨** (기본 비활성 — §8) |
| 3 | 제한된 자동 수정, `develop` PR, 소유자 승인, 서버 관측 기반 승격(§9.3) | **인프라 구현됨** (완전 비활성 — §9.1) |

각 Phase는 별도 PR과 별도 사람 승인으로 진행한다. Admin Console은 Support의
`자동 수정 검토` section(`/admin/support?tab=fixes`)에서 case의 문제점·해결책·
승격 진행을 표시한다(2026-09-15, §9.3).

## 2. Trace provenance 모델

Trace ID **문자열 자체는 인증 수단이 아니다.** UUID 형식 검사는 출처 신뢰를
의미하지 않는다. 출처는 4가지로 구분한다
(`lib/errorReportContract.ts`의 `TRACE_PROVENANCE`).

- `server_generated`: 서버 route가 직접 `randomUUID()`로 생성.
- `client_supplied`: client request header/body에서 전달되어 서버가 채택.
- `client_fallback`: 서버 Trace가 없어 client가 생성.
- `unknown`: 출처를 증명할 수 없음.

현재 route별 기대 provenance:

| 경로 | 동작 | provenance |
|---|---|---|
| `app/api/chat/route.ts` | route 내부 `randomUUID()` | `server_generated` |
| `app/api/chat/preflight/route.ts` | `X-Client-Request-ID` 채택(유효 UUID일 때) | `client_supplied` |
| `app/api/chat/deep-research/status/route.ts` | route 내부 `randomUUID()` | `server_generated` |
| `proxy.ts` origin 거부 | client `x-request-id` 채택 | `client_supplied` |
| `ChatPageClient.tsx` fallback | `clientTraceId` 생성 | `client_fallback` |

같은 문자열이 다른 요청에서 발견돼도 provenance는 승격되지 않는다.

## 3. errorReportToken

### 3.1 목적과 비권한성

Token(`lib/errorReportToken.ts`, versioned HMAC `terr1.*`)은 "이 Trace와
발급 시점에 서버가 알던 오류 사실이 Tomverse 서버가 발급한 것"만 증명한다.
사용자 인증·권한·데이터 소유권 검사의 대체물이 아니며, feedback endpoint의
rate limit과 Turnstile 검증을 대체하지 않는다.

Token이 증명하지 않는 것: 사용자 서술의 사실 여부, client가 나중에 분류한
오류 코드, 자동 수정 가능 여부, evidence row 존재 여부, 최신 `develop`에서의
재현 여부.

### 3.2 발급 범위 (중앙 발급 invariant)

발급은 `lib/traceErrorEvidence.ts`의 `issueChatErrorReportGrant` 한 곳에서만
하며, 호출 지점은 오류 응답 builder다.

- `app/api/chat/route.ts`의 `tracedJsonError` (JSON 오류 전체)
- 같은 route의 `ChatAccessError` exit (limit·entitlement 거절)
- `app/api/chat/deep-research/status/route.ts`의 failed poll 응답

전달은 response header `X-Error-Report-Token`
(`ERROR_REPORT_TOKEN_HEADER`)로, 기존 `X-Request-ID` 계약과 나란히 실린다.

발급 조건: Node route가 **직접 생성한** `server_generated` Trace의
서버 분류(reportable) 오류일 것. 다음에는 발급하지 않는다.

- client가 보낸 `x-request-id` / `X-Client-Request-ID` / `clientTraceId`
- `proxy.ts` 등 Edge 경로 (token 모듈은 `node:crypto` 의존 Node 전용이며
  Edge bundle에 import되지 않아야 한다)
- 정상 HTTP 200 stream 종료 후 client가 분류한 `EMPTY_RESPONSE`
- 정상 stream에 대한 선발급 (빈 응답 대비 목적 포함, Phase 1 금지)

### 3.3 EMPTY_RESPONSE 정책 (Phase 1: A안)

서버 stream은 빈 응답을 감지하면 내부적으로 `AI_EMPTY_RESPONSE.*` provider
failure를 **기록만** 하고(`recordProviderFailure`), 이미 시작된 200 stream에
오류 frame을 보내지 않는다. 사용자-facing `EMPTY_RESPONSE`는 client 분류다.

- 빈 응답 신고는 정상 접수되고 `missing_token`/unverified로 표시된다.
- Trace가 일치하는 provider event가 발견돼도 Feedback을 verified로
  승격하지 않는다.
- Admin은 "Client-classified EMPTY_RESPONSE — server token not issued"로
  표시한다.
- stream-start header 선발급 또는 final control frame 방식의 verified 지원은
  Phase 2 검토 항목이다.

### 3.4 만료·서명·fail-closed

- TTL 기본 72시간. `ERROR_REPORT_TOKEN_TTL_HOURS` override는 1~168시간으로
  clamp되며 범위 밖 값은 기본값으로 되돌아간다.
- secret은 `ERROR_REPORT_SIGNING_SECRET`, 최소 32자. 미만/미설정이면 발급과
  검증만 fail-closed로 비활성화되고 **feedback 제출은 계속 동작한다**
  (`missing_token`으로 기록). staging/production에서는 secret을 코드보다
  먼저 배포한다.
- constant-time 서명 비교, parsing 전 2,048자 크기 제한, 알 수 없는 version
  거부, malformed token은 예외 전파 없이 검증 실패 처리.
- optional field의 canonical serialization: 필드 부재와 빈 문자열은 서로
  다른 payload이고 다른 서명을 가진다.

### 3.5 Token persistence 금지

원시 token은 client 메모리와 화면 표시 밖으로 나가지 않는다. Prisma DB,
Conversation/Message 저장, guest localStorage, 로그인 sync, guest import,
analytics, 구조화 로그, Sentry, server cache 어디에도 저장하지 않는다.
유일한 예외는 feedback 제출 요청 body 1회이며, 서버는 즉시 검증하고 원문을
버린다. 서버는 검증 **결과만** 저장한다.

강제 수단: `Message.errorReport`는 runtime 전용 필드이고, 모든 직렬화는
`lib/chatMessageSerialization.ts`의 allowlist serializer를 통한다. spread
기반 serializer로 되돌리지 않는다. reload 후 token이 사라지는 것은 정상이며
해당 신고는 `missing_token`이 된다.

## 4. Trace evidence 모델

`TraceErrorEvidence`(prisma)의 identity 원칙:

- PK는 서버 생성 surrogate `id`, 멱등성 identity는 서버가 오류 occurrence마다
  생성하는 `occurrenceId`(unique)다.
- **`traceId`는 non-unique index일 뿐이다.** PK·unique·upsert key로 쓰지
  않는다. client가 영향을 줄 수 있는 값은 dedupe identity가 될 수 없다.
- 같은 Trace 문자열에 여러 evidence row가 존재할 수 있고, 새 요청이 기존
  row를 덮어쓸 수 없다.
- Feedback 연결은 token payload의 `occurrenceId`로만 한다. `traceId`로
  첫/최신 row를 고르는 loose lookup은 authoritative가 아니다.
- **answer attribution은 이 연결과 별개 축이다.** 메모리 정책 §22가 요구하는
  "이 피드백이 어느 답변에 대한 것인가"는 Trace로 유도하지 않는다. `traceId`로
  답변을 찾거나 `occurrenceId`를 답변 ID로 재사용하지 않고, 소유권을 서버가
  재검증한 별도 nullable FK로 관리한다. 둘은 겹치는 경우가 있어도 같은 사실이
  아니다 — Trace는 오류 occurrence를, answer link는 품질 신호의 대상을 가리킨다.

저장 allowlist: occurrence 시각, environment, release, routeClass, phase,
errorCode, classificationSource, httpStatus, provider, modelId, retryable,
fingerprint, sentryEventId. **저장 금지**: prompt/대화/응답 본문, email,
user agent, cookie/header 원문, provider 원시 payload, 원시 token, secret,
결제 정보, 내부 USD.

## 5. Evidence write 제어

- **기록 대상 필터** (`traceEvidenceRecordability`): 애플리케이션·provider
  실패(`AI_PROVIDER_ERROR`, `AI_REQUEST_FAILED`, `DEEP_RESEARCH_JOB_FAILED`,
  `AI_EMPTY_RESPONSE`, 5xx)만 새 row를 만든다. limit·quota·credit·
  concurrency·guardrail 거절은 token은 받되 기존 `ChatLimitDecisionEvent`
  등을 참조한다(`existing_limit_event`). routine 4xx는 기록하지 않는다.
- **운영 write cap**: `TRACE_EVIDENCE_MAX_WRITES_PER_MINUTE`(기본 120),
  `TRACE_EVIDENCE_MAX_WRITES_PER_DAY`(기본 5,000). operational namespace이며
  entitlement·credit·provider budget과 무관하다. cap 도달은 60초 cooldown이
  적용된 집계 로그(`trace_evidence_write_capped`)로만 남는다.
- **best-effort 쓰기**: evidence 쓰기는 오류 응답의 status·code·전달 여부를
  바꾸지 않는다. 쓰기는 detached promise로 수행되고 실패는
  `trace_evidence_write_failed` 구조화 이벤트로 남는다. 이 전달 보장은
  long-lived Node 서버(Railway) 전제다: 응답 직후 프로세스가 죽으면 해당
  row 하나를 잃을 수 있고, 그 경우 feedback은 `not_yet_available`로 정직하게
  표시된다. serverless로 이전한다면 이 방식을 재설계해야 한다.
- **retention**: 30일. `lib/maintenance.ts`의 `cleanupExpiredData()`가
  provider 오류 진단과 같은 주기로 삭제하고 삭제 건수만 기록한다. 연결된
  Feedback row는 FK `SetNull`로 검증 결과를 유지한다.

## 6. Verification / classification / availability 분리

세 가지는 독립 관찰이며 별도 컬럼에 저장된다
(`Feedback.errorReportVerification`, `errorClassificationSource`,
`evidenceAvailability`).

- Token 검증 성공은 evidence row가 없어도 유지된다.
- 검증 상태: `verified`, `missing_token`, `expired`, `invalid_signature`,
  `payload_mismatch`, `unsupported_version`, `untrusted_trace_source`.
- 분류 출처: `server`(verified token의 code), `client`(EMPTY_RESPONSE 등),
  `provider`, `unknown`. client 분류는 server 사실로 승격되지 않는다.
- availability: `recorded`, `intentionally_not_recorded`,
  `existing_limit_event`, `existing_provider_event`, `not_yet_available`
  (쓰기 진행 중·cap·실패를 구분하지 않는 정직한 미존재 표시 — Phase 1
  단순화), `ambiguous_trace`, `not_applicable`.
- `evidence_not_found` 같은 단일 상태로 사유를 합치지 않는다.

## 7. Sentry 연계

- `issueChatErrorReportGrant`가 Error 객체를 받은 경우에만
  `captureException`을 호출하고 Trace ID·errorCode·routeClass·occurrenceId를
  tag로 남긴다. 반환된 event ID는 evidence row에 저장한다.
- 기존 `sentry.server.config.ts`의 sanitizer(beforeSend)가 메시지·stack의
  민감 정보를 계속 제거한다. token·secret·사용자 본문은 Sentry로 보내지
  않는다. Sentry 실패는 사용자 응답을 바꾸지 않는다.
- **ingestion 지연 (Phase 2 collector 요구사항)**: `captureException`이
  event ID를 반환해도 조회 API에는 늦게 나타날 수 있다. collector는 초기
  `not found`를 영구 실패로 판정하지 말고 bounded exponential backoff
  (5s/15s/30s/60s → 60s 간격, 총 5분)와 jitter를 적용하며, 고갈 후에는
  `evidence_pending`/`sentry_unavailable`로 남긴다. source-map upload token을
  재사용하지 말고 별도 read-only `project:read` token을 쓴다.

## 8. Phase 2 — diagnosis-only shadow mode (구현됨)

Phase 2는 관찰 인프라다: PR·branch·코드 수정이 없고, LLM을 호출하지 않으며,
LLM confidence는 관찰용 컬럼(`llmConfidence`, 항상 null)일 뿐 게이트가
아니다. client-supplied Trace와 client-classified `EMPTY_RESPONSE`는 자동
진단 대상에서 제외된다.

구현 요약:

- **case 생성**: `type=bug` + 검증된 token(`verified`)일 때만 feedback 저장
  transaction 안에서 `FeedbackAutoFixCase`(feedbackId unique)를 만든다.
  fingerprint는 `serverErrorCode|release`로 중복 관찰용이며 identity가
  아니다.
- **kill switch**: `FEEDBACK_AUTOFIX_SHADOW_ENABLED === "true"`일 때만
  큐잉·처리한다. 기본 fail-closed. 끄면 신규 case가 생기지 않고 worker가
  중단되며, 기존 case는 그대로 남는다.
- **worker**: `lib/feedbackAutoFixShadow.ts`가 maintenance cron cadence로
  실행된다(`/api/internal/maintenance/cleanup`에 편승, 실패해도 retention
  작업을 실패시키지 않음). claim은 compare-and-swap 조건부 UPDATE + 5분
  lease이고, lease가 만료된 고아 case는 다음 pass가 collecting으로 되돌려
  재처리한다. 상태 전이는 `lib/feedbackAutoFixCore.ts`의 그래프만 허용한다
  (임의 terminal 점프 금지).
- **상태**: received → collecting_evidence → {evidence_ready |
  evidence_delayed} → classifying → {diagnostic_ready →
  awaiting_human_review | ineligible} → closed.
- **evidence 지연**: 검증됐지만 row가 `not_yet_available`이면 1/5/15/30/60/
  120분 백오프(worker cadence 하한)로 최대 6회 재시도 후
  `evidence_incomplete`로 정직하게 종료한다. §7의 Sentry ingestion 지연
  원칙의 구현이며, cadence가 cron 주기라서 §7의 초 단위 백오프보다 거칠다는
  점을 명시해 둔다.
- **분류(결정적 규칙)**: untrusted_trace(미검증) / client_classified /
  operational_limit(기존 limit event 참조) / provider_transient(retryable
  또는 `AI_EMPTY_RESPONSE*`·`DEEP_RESEARCH_JOB*`) / evidence_incomplete /
  **application_candidate**(검증 + 기록된 비일시적 서버 실패)만 사람 검토
  대기(awaiting_human_review)로 간다. candidate는 "수정 대상"이 아니라
  "사람이 볼 가치가 있음"이라는 뜻이다.
- **진단 요약**: 기술 사실만 담는 bounded JSON(오류 코드·route·release·
  provider/model·재시도성·관련 provider/limit event 수·Sentry event ID).
  사용자 본문·prompt·원시 provider payload·token은 절대 넣지 않는다.
- **Sentry 읽기**: 전용 read-only 환경변수(`SENTRY_EVIDENCE_READ_TOKEN`,
  `SENTRY_EVIDENCE_ORG_SLUG`, `SENTRY_EVIDENCE_PROJECT_SLUG`)가 있을 때만
  event title 1회 fetch(5초 timeout). 미설정·실패는 case를 지연시키지 않고
  요약에 사유만 남긴다. source-map upload token을 재사용하지 않는다.
- **관찰 지표**: `GET /api/admin/trace-diagnostics`(admin 전용)가 30일
  창의 신고 수·token 검증 분포·case 상태/분류 분포를 집계한다. 분류
  정확도(사람 대조)와 clean base 재현 후보 비율은 candidate를 사람이
  검토하며 수기로 축적한다.
- **retention**: terminal(closed·ineligible) case는 90일 후
  `cleanupExpiredData()`가 정리한다. 열린 case는 삭제하지 않는다.

## 9. Phase 3 경계 (인프라 구현됨 — 운영 비활성)

- **진입 조건**: Phase 2 shadow mode에서 최소 30일 관찰 + 검증된 traced
  report 최소 30건 + 개인정보·금지 정보 유출 0건, 그리고 별도 사람 승인.
  표본 조건 변경은 근거·owner·승인자와 함께 이 문서에 기록한다.
  **코드는 이 조건을 스스로 검사하지 않는다** — `FEEDBACK_AUTOFIX_ENABLED`
  플래그를 켜는 행위가 "사람이 조건 충족을 확인했다"는 약속이다.

### 9.1 구현 상태와 활성화 절차

인프라는 배포돼 있지만 3중으로 잠겨 있다: (1) `FEEDBACK_AUTOFIX_ENABLED`
미설정 시 모든 엔드포인트가 비활성 응답, (2)
`FEEDBACK_AUTOFIX_SYNC_SECRET`(≥32자) 미설정 시 전 엔드포인트 401,
(3) workflow는 `workflow_dispatch` 전용이고 schedule이 없다(§9.2).

구성 요소:

- **상태 확장**: `awaiting_human_review → fix_attempting →
  red_green_proven → pr_open → merged → staging_verified → closed`,
  실패는 `fix_failed`. 전이는 `lib/feedbackAutoFixCore.ts` 그래프만
  허용하고, lease가 만료된 fix 시도는 review pool로 되돌아간다.
- **sync 프로토콜**: `app/api/internal/feedback-autofix/{pending,claim,
  result,heartbeat}` — 전부 POST, dedicated Bearer secret(digest 비교),
  bounded body + 폐쇄형 Zod schema. claim은 CAS이고, result 콜백은
  서버가 change manifest와 Red→Green proof를 **재검증**한 뒤에만 전이한다
  (workflow의 자기 보고를 신뢰하지 않음). replay·순서 위반은
  `{applied:false}` no-op이다.
- **change policy** (`lib/feedbackAutoFixPolicy.ts`): 최대 5파일/300줄,
  테스트 추가 필수, 테스트 삭제·skip/only·snapshot 금지, `.github/`·
  `prisma/`·config·정책 문서·인증/결제/크레딧/concurrency 표면·**파이프라인
  자기 자신** 금지. workflow가 git diff에서 manifest를 재계산해 검사하고
  (`scripts/feedback-autofix-policy-check.mjs`) 서버가 다시 검사한다.
- **Red→Green proof**: 신규 테스트만 clean base worktree에 적용해 assertion
  으로 실패(문법·import 실패는 불인정), fixed head에서 동일 테스트 통과,
  base≠head SHA. proof는 case에 저장된다.
- **workflow** (`.github/workflows/feedback-autofix.yml`): checkout·
  setup-node commit SHA 고정 + fix CLI version/integrity 고정, LLM step엔
  LLM key만·PR step엔 GH PAT만·sync secret은 그 둘 어디에도 없음(전부
  security regression이 고정). branch는 `feedback-autofix/<case-id>`,
  PR은 `develop` 대상이며 **auto-merge를 켜지 않는다** — 초기 운영(최초
  20개 PR과 30일 중 늦은 쪽)엔 사람 승인이 필수다.

활성화 절차(순서 고정): ① §9 진입 조건 확인·기록 → ② GitHub secrets
설정: `FEEDBACK_AUTOFIX_SYNC_SECRET`(서버 env와 동일 값),
`FEEDBACK_AUTOFIX_ANTHROPIC_API_KEY` → ③ 서버 env:
`FEEDBACK_AUTOFIX_SYNC_SECRET`, `FEEDBACK_AUTOFIX_ENABLED=true`,
필요 시 `FEEDBACK_AUTOFIX_MAX_CASES_PER_DAY`(기본 5) → ④ 수동
`workflow_dispatch`로 첫 실행. kill switch는 ③의 플래그 제거 하나로
충분하다(모든 엔드포인트가 즉시 비활성).

### 9.2 미검증(N/V) 사항

- workflow는 실제로 실행된 적이 없다(secrets 미설정, dispatch 전용).
  첫 활성화 때 §9.1 ④를 staging 환경 대상(TOMVERSE_APP_URL 조정)으로
  드라이런하는 것을 권장한다.
- scheduled 실행은 default branch에서만 동작하며, schedule 추가 자체가
  별도 go-live 결정이다.
- 유일한 자동 적격 게이트는 **결정적 Red→Green 재현 증명**이다: clean
  `develop`에서 assertion으로 실패(문법 오류·import 누락·fixture 부재 제외),
  수정 후 동일 테스트 통과, 허용된 저위험 파일만 변경, 필수 CI 통과,
  provider live 상태·production 데이터·개인정보·결제 없이 재현.
- 자동 생성 수정(LLM)이 만드는 것은 `develop` PR뿐이다. 자동화는 어떤 PR도
  병합하지 않는다 — `main` 승격은 §9.3의 소유자 승인 뒤 **사람이 GitHub에서**
  병합한다. 자동 revert 금지. branch protection 우회(`--admin`) 금지.
  auto-merge 금지. 병합 사실은 서버가 GitHub에서 직접 읽는다.
- staging 반영은 production 사용자 오류가 해결됐다는 뜻이 아니다.
  `Feedback.status`는 production 관측 뒤에도 자동으로 `resolved`가 되지 않고,
  운영자의 해결됨 처리로만 바뀐다(§9.3).
- 초기 운영(최초 20개 PR과 30일 중 더 늦은 시점까지)은 모든 auto-fix PR에
  사람 승인을 요구한다. auto-merge 전환은 별도 정책 변경 PR로만 한다.
- 자동 수정 제외 영역: 인증·결제·크레딧·guardrail·concurrency·identity·
  Prisma schema/migration·관리자 권한·감사 무결성·개인정보·모델 가격/
  lifecycle·`.github/**`·dependency·config·visual baseline·provider 장애·
  일시 오류, 그리고 자동 수정 파이프라인 자체.
- **workflow 경합**: `cron-auto-fix.yml`은 `autofix/**` branch를
  `GH_AUTOMATION_PAT`으로 push하고 `main` PR을 만들며,
  `auto-pr-to-develop.yml`은 이 namespace를 제외하지 않아 같은 branch에
  develop PR이 중복 생성될 수 있다. Phase 3 workflow는 `cron-auto-fix.yml`을
  재사용하지 않고 전용 namespace를 쓰며, 이 경합은 Phase 3 시작 전에 별도
  소규모 workflow PR로 해결돼야 한다.
- scheduled workflow는 default branch에 있어야 예약 실행된다. 구현이
  `develop`에만 있는 동안 schedule이 활성화됐다고 보고하지 않는다(N/V).

### 9.3 소유자 승인 기반 승격 (2026-09-15 개정)

운영자 요청(2026-09-15)으로 추가했다. 설계와 독립 검토 기록:
`.github/audits/support-trace-review-flow-design-2026-09-15.md`,
`support-trace-review-flow-design-review-round0-2026-09-15.md`(reject),
`support-trace-review-flow-design-review-round1-2026-09-15.md`(reject),
`support-trace-review-flow-review-round2-2026-09-15.md`(구현 검토, reject). 세
회차의 발견은 설계 문서 §2·§2a·§2b와 아래 계약에 반영했다.

**신고 접수 (Phase와 무관, flag 없음)**

- token `verified` + traceId가 있는 신고는 `reviewing`으로 저장된다
  (`lib/feedbackTraceAutoReview.ts`). lifecycle `received`·`reviewing` 두 행을
  같은 transaction에 쓰고, reviewing 행에는 actor가 없다. 사용자 입력 Trace·
  미검증 token은 `open`에 남는다(§2).
- 사용자에게 추가 메일을 보내지 않는다. 운영자 메일은 기존 `support_feedback`
  한 통이며, 불변 필드 `errorReportVerification`으로 "자동으로 검토중" 변형을
  렌더링한다.

**상태 그래프** (`lib/feedbackAutoFixCore.ts`)

`pr_open → approved → merged → staging_verified → production_merged →
production_verified → closed`, 실패는 `promotion_failed → closed`.
`pr_open → merged`, `staging_verified → closed`, workflow의 `merged`·
`staging_verified` 보고는 **없다**. 승인 없이 병합된 PR은 승격되지 않는다.

**검토 요청** — fix run이 보고한 PR 번호를 서버가 GitHub에서 읽어 이 저장소·
base `develop`·`feedback-autofix/<caseId>`·open인지 확인하고, GitHub의 head와
**change manifest**(경로별 merge-base blob과 head blob,
`lib/feedbackAutoFixChangeManifest.ts`)를 저장한다. run의 원인·해결 보고
(`fixReport`, 1,000/1,000/500자, 진단 요약만 입력)와 함께 저장되며
`autofix_review_requested` 운영자 메일이 같은 transaction에 enqueue된다.

**승인** — `POST /api/admin/feedback-autofix/[caseId]/approve`. owner 역할 +
최근 인증(step-up) + audit log. 화면이 본 head가 저장된 head이고, GitHub의
현재 head이며, 그 head의 manifest가 저장된 manifest일 때만 CAS로
`approved`가 되고 head와 manifest digest에 묶인다. 병합하지 않는다.

**관측** (`lib/feedbackAutoFixPromotion.ts`, maintenance cadence, 읽기 전용)

- develop PR이 **승인 head로** 병합됨 → `merged`. head 변경·다른 head 병합·
  미병합 close → `promotion_failed` + `autofix_promotion_failed` 메일.
- 배포 판정(`lib/feedbackAutoFixDeploymentObservation.ts`): Railway control
  plane에서 서비스·환경의 **트래픽을 받을 수 있는** deployment(SUCCESS·
  DEPLOYING·REMOVING·SLEEPING)가 **정확히 하나**이고 SUCCESS이며, 그 commit이
  기대 commit을 **포함**할 것(같거나 기대 commit이 ancestor — GitHub compare로
  판정, 판정 불가는 미관측), 한 pass의 build-info 표본 5개가 모두 그
  deployment·그 commit·success일 것, production은 `/api/ready` 표본 5개가 모두
  **캐시되지 않은** 200일 것(`Age`가 없거나 0).
  "포함"인 이유: staging은 2026-09-15 두 시간 반 동안 develop 병합 6건을 받았고,
  정확한 병합 commit이 10분간 live이기를 기다리면 바쁜 날에는 영원히 관측되지
  않는다. serving 상태 집합은 같은 날 실제 control plane에서 읽었다 — 교체된
  deployment는 REMOVED가 되고 SUCCESS는 하나만 남으며, CI를 기다리는 WAITING과
  SKIPPED는 트래픽을 받지 않는다(`tests/fixtures/railwayDeploymentsStaging.json`).
  한 pass는 창을 열 뿐이고, ≥10분 뒤 같은 deployment로 다시 충족해야 한다.
  timeout은 실패 상태가 아니라 화면의 "관측 지연"이다.
  **staging `/api/ready`는 Cloudflare Access 뒤라 관측하지 않는다(N/V)**.
- main 승격 PR은 서버가 브랜치 `feedback-autofix-main/<caseId>`로 찾는다.
  이 저장소의 open/merged PR이 정확히 하나이고, 그 manifest가 승인 manifest와
  **완전히 같을 때**(같은 경로, 같은 before blob = main이 승인 base를 그대로
  가짐, 같은 after blob)만 기록한다. 다르면 `promotion_failed`. 병합되면
  `production_merged`, production 판정 통과 시 `production_verified` +
  `autofix_production_verified` 메일.

**승격 PR workflow** (`.github/workflows/feedback-autofix-promotion-pr.yml`) —
`pull_request: closed`(privileged trigger 아님), head가 이 저장소일 때만.
read-only `promotion/prepare`로 적격성을 묻고(서버 상태 변경 없음), back-merge
완료(`origin/main`이 `origin/develop`의 ancestor)와 main의 승인 base를 확인한 뒤
cherry-pick 브랜치가 승인 manifest와 같을 때만 PR을 연다. 재실행은 기존
브랜치·PR을 재사용한다. **병합·`--admin`·`--auto`는 쓰지 않는다**
(`npm run security:regression`이 고정).

**해결됨** — `production_verified` case의 신고에만 결정적 답변 초안
(`lib/feedbackAutoFixReplyDraft.ts`, 기술 식별자·사용자 본문 없음)이 표시된다.
운영자가 해결됨으로 처리하면 같은 transaction에서 case가 CAS로 `closed`가 된다.
그 전 상태의 case는 해결됨 처리로 닫히지 않는다.

**자격증명과 kill switch** — 서버에는 GitHub **읽기 전용** 토큰만 둔다.

| 환경변수 | 위치 | 용도 |
|---|---|---|
| `FEEDBACK_AUTOFIX_ENABLED` | 서버 | Phase 3 전체 master switch (기존) |
| `FEEDBACK_AUTOFIX_GITHUB_READ_TOKEN` | 서버 | 이 저장소 한정 fine-grained PAT: Contents·Pull requests·Metadata **read**만, 만료 ≤90일 |
| `FEEDBACK_AUTOFIX_GITHUB_REPOSITORY` | 서버(선택) | 기본 `mposition/Tomverse` |
| `RAILWAY_API_TOKEN`, `RAILWAY_PROJECT_ID` | 서버 | control plane 읽기 (기존 build-info와 공유) |
| `FEEDBACK_AUTOFIX_RAILWAY_SERVICE_ID` | 서버(선택) | 기본 `RAILWAY_SERVICE_ID` |
| `FEEDBACK_AUTOFIX_STAGING_RAILWAY_ENVIRONMENT_ID`, `FEEDBACK_AUTOFIX_PRODUCTION_RAILWAY_ENVIRONMENT_ID` | 서버 | 관측 대상 환경 |
| `FEEDBACK_AUTOFIX_SYNC_SECRET`, `GH_AUTOMATION_PAT` | GitHub secrets | 기존 |

하나라도 없으면 승인 버튼은 사유와 함께 비활성이고 observer는 아무것도 읽지
않는다. 읽기 토큰이 유출되면 private 소스가 노출되므로 GitHub에서 즉시
revoke하고 새 토큰으로 교체한다(서버 env 교체 → 재배포). kill switch는
`FEEDBACK_AUTOFIX_ENABLED` 제거 하나로 충분하다.

**fix run fencing** — claim이 서버 생성 `fixAttemptId`를 발급하고, heartbeat와
모든 result는 그 id가 일치할 때만 적용된다. lease 회수와 종료 결과가 id를
지우므로, lease가 만료된 실행의 늦은 callback은 다음 실행의 case를 바꾸지
못한다.

**N/V** — 실제 GitHub·Railway에 대한 end-to-end 실행은 아직 없다. Railway
deployments 목록의 상태 의미는 실측했으나(위), GraphQL 응답의 `meta.commitHash`
필드 이름은 MCP 도구 출력으로만 확인했다 — 없으면 `deployment_commit_unknown`으로
fail-closed다. GitHub가 대용량·binary 파일의 contents를 돌려주지 않는 경우도
fail-closed(승격 안 됨)로 처리되지만 실측 전이다.
back-merge 충돌 자체는 여전히 사람이 해결하며, 해결 전에는 승격 PR이 만들어지지
않는다.

## 10. 운영자 절차

- **kill switch**: `ERROR_REPORT_SIGNING_SECRET`를 제거하면 token 발급·검증이
  즉시 중단되고(신규 신고는 `missing_token`), evidence 기록은
  `TRACE_EVIDENCE_MAX_WRITES_PER_MINUTE=1`로 사실상 봉인할 수 있다. 두 조치
  모두 feedback 제출 자체에는 영향이 없다.
- secret rollout 순서: 환경변수 먼저, 코드 나중.
- incident 시: evidence 폭증은 write cap이 1차 방어선이다. cap 로그
  (`trace_evidence_write_capped`)가 반복되면 cap을 낮추기 전에 오류 폭증의
  원인(provider 장애 vs 배포 결함)을 먼저 분류한다.
- Admin Console의 Feedback inbox에서 검증 상태·provenance·분류 출처·evidence
  연결을 확인한다. "verified + no evidence row"는 정책상 미기록(limit 참조)과
  유실(`not_yet_available`)이 구분되어 표시된다.
