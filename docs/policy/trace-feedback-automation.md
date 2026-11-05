# Trace 기반 오류 신고 자동화 정책

사용자 오류 신고를 Trace 증거와 연결하고, LLM 분석과 draft PR까지 잇는
경로의 경계와 invariant를 정의한다. 이 문서는
`AGENTS.md`의 요약 invariant가 가리키는 원본이다.

## 1. 3단계 rollout

| Phase | 범위 | 상태 |
|---|---|---|
| 1 | 메시지별 Trace 상관관계, 서버 발급 token, Trace evidence 모델, Admin 표시 | **구현됨** |
| 2 | case 상태 머신, 증거 수집(collector), 적격성 판정, 진단 보고서 (diagnosis-only shadow mode) | **구현됨** (기본 비활성 — §8) |
| 2a | 검증된 추적 ID 신고의 LLM 분석과 AMUX idea lane draft PR(§8a) | **구현됨** (기본 꺼짐) |

Admin Console은 Support › Feedback의 신고 아래에 분석 결과와 수정 draft PR을 표시한다. §9는 삭제한 Phase 3의 기록이다.

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

## 8a. 검증된 추적 ID 신고의 LLM 분석 (운영자 결정 2026-11-05)

옛 Phase 3 파이프라인(§9)은 실행된 적이 없어, 분석과 수정을 LLM 호출과 기존 AMUX idea lane으로 옮겼다
(`lib/traceReportAnalysis.ts`). §8의 판정은 그대로 두고 그 뒤에 붙는다. 15분 cron에 얹혀 돌고, 켜져 있는
동안에는 §8의 판정도 같은 주기로 돈다.

- **모드**: Support › Feedback 패널의 끔·분석·분석 + draft PR 하나. 기본은 끔이고, 저장은 소유자 + 최근
  인증 + 감사다. 분석 + draft PR은 고른 소유자를 함께 저장해, 그 소유자가 idea의 데이터 소유자가 되고 그 계정이 소유자가
  아니게 되면 멈춘다. 제출 감사는 소유자 행위로 꾸미지 않고 시스템 행위자 `trace-report-analysis`로 남기며,
  승인한 소유자를 metadata에 적는다. 모델은 지원 Triage가 쓰는 모델이고, Triage 스위치나 모델이 꺼져 있으면 분석도 돌지 않는다.
  새 신고가 case가 되려면 §8의 `FEEDBACK_AUTOFIX_SHADOW_ENABLED`가 켜져 있어야 하며, 꺼진 환경은 패널이 그렇게 표시한다.
- **입력은 서버 기록뿐이다**: §8의 진단 요약 중 허용 목록의 필드(요약의 `errorCode`는 증거가 없으면 client 값이라 제외), fingerprint의 서버 오류
  코드와 release, 같은 Trace의 provider·limit event 코드 필드. 신고자의 글과 경로, provider 메시지는 넣지
  않는다. 이 답이 branch에 쓰는 coding agent의 지시문이 되므로, 신고가 그 글을 쓸 수 없어야 한다.
- **draft PR 조건**: 모델이 `code_fix`를 신뢰도 medium 이상으로 답하고, 서버 판정이 `operational_limit`·
  `provider_transient`·`client_classified`·`untrusted_trace`가 아닐 것. UTC 하루 3건(같은 날의 재시도는 세지 않는다)이고 lane의 일일 한도가
  따로 있다. idea와 PR은 공개되므로 Trace ID·신고 내용을 넣지 않는다. 병합은 사람이 한다.
- **멱등**: request id를 case id에서 유도해, 응답을 잃은 제출을 다시 보내도 idea는 하나다.
- **상한**: 분석은 회차당 5건, UTC 하루 20회(재시도 포함), 건당 3회까지. 대상은 최근 30일의 case다. 호출과 제출 전에 lock 안에서 그날 사용량(`traceReportAnalysis.usage`)을 올리고 case를 잡으므로, 실행이 겹쳐도 두 번 호출하거나 상한을 넘지 않는다. 건당 시도 횟수도 호출 전에 올리고, claim을 잃은 실행은 결과를 쓰지 않는다.
- **저장**: `diagnosticSummary.llmAnalysis`. migration이 없고 case의 보존·삭제를 그대로 따른다.
- **한계**: 분석 모델은 코드를 보지 못한다. 코드를 보는 원인 분석은 lane 실행이 PR에 적는다. 증거 행이 없는
  신고는 오류 코드와 release만으로 판단한다.

## 9. 삭제한 Phase 3 (2026-11-05)

자동 수정 workflow, sync route, 소유자 승인·승격 관측, `자동 수정 검토` 탭은 한 번도 실행되지 않은 채
§8a로 대체되어 삭제됐다. `/admin/support?tab=fixes`는 Feedback 탭으로 간다. `FeedbackAutoFixCase`의 Phase 3
컬럼은 데이터 없이 남아 있으며 별도 migration으로 정리할 수 있다. Railway 배포 관측 모듈
(`lib/feedbackAutoFixDeploymentProbe.ts`, `lib/feedbackAutoFixDeploymentObservation.ts`)은 AMUX가 쓰므로 남겼다.

### 9.3 소유자 승인 기반 승격 (삭제)

`prisma/schema.prisma`의 Phase 3 컬럼 주석이 가리키는 절이다. 컬럼을 정리할 때 함께 지운다.

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
