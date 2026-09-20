# Prompt Refiner durable run writer 운영 계약

## 1. 범위와 현재 readiness

- run: `prompt-refiner-shadow-run-v2`
- corpus: 동결된 한국어 8건·영어 8건, 합계 16건
- provider/model/가격: execution contract에 고정된 exact identity와 단가
- 요청당 비용 상한: 24,916 microUSD
- run 비용 상한: 398,656 microUSD
- timeout: 15초
- retry: 0
- unknown 기준: dispatch intent 뒤 60초

`durableRunWriterReady=true`, `runApprovalPreviewReady=true`다. 반면
`entryPointReady=false`, `executionAdmitted=false`, `productAdapterReady=false`다. 이 문서의
writer는 실행을 기록할 안전한 경계를 제공하지만, provider를 호출하는 entry point는 제공하지
않는다.

## 2. owner 승인 route

`GET /api/admin/prompt-refiner/shadow-run`은 owner와 recent authentication을 요구하는 no-write
preview다. 승인된 stage와 현재 deployment/commit, stage source manifest, run delta source
manifest, corpus, model, 비용과 unknown 정책을 canonical binding digest로 반환한다. 응답은
`private, no-store`다.

`POST /api/admin/prompt-refiner/shadow-run`은 같은 인증과 전역 origin 검사, DB rate limit,
4 KiB strict JSON을 적용한다. body는 네 digest와 고정 confirmation만 받는다. 서버의
`PROMPT_REFINER_SHADOW_RUN_APPROVAL_ENABLED`가 정확히 `true`가 아니면 거부한다. POST는 facts를
다시 읽고 stage authorization, registry/pricing, DB clock, preview binding을 transaction 안에서
재검증한다. 사람 audit과 `PromptRefinerShadowRun`은 함께 commit되거나 함께 rollback된다.

동일 actor와 동일 immutable facts의 replay만 기존 행을 반환한다. run id와 contract digest는
한 번만 사용할 수 있고, 다른 actor/facts 또는 terminal run을 새 승인으로 바꾸지 않는다.

## 3. dispatch 경계

향후 runner는 provider 호출 전에 `recordPromptRefinerShadowDispatchIntent()`를 호출해야 한다.
transaction lock 순서는 stage, model registry, run, reservation이다. writer는 다음을 원자적으로
기록한다.

1. system audit `prompt_refiner.shadow_dispatch.intent_recorded`
2. case id/index와 request/reservation에 결속된 `dispatch_intent` attempt
3. exact reservation의 `reserved -> consumed`
4. run의 `approved -> running` 및 dispatch count

case id/index, request id와 reservation id는 중복될 수 없다. model, adapter, output cap,
timeout, retry가 고정 execution contract와 다르면 transaction 전에 거부한다. standalone
reservation consume은 application에서 `dispatch_intent_required`로 거부되며 DB trigger도 같은
transaction에 exact attempt가 하나 없으면 거부한다.

writer가 성공한 뒤에만 provider 경계로 나갈 수 있다. writer 성공 자체는 provider가 호출됐거나
응답했다는 증거가 아니다.

## 4. terminal receipt와 accounting

provider 경계가 끝나면 runner는 `recordPromptRefinerShadowTerminal()`에 terminal reason,
duration과 nullable usage만 전달한다. 저장 가능한 terminal reason은 execution contract의
`suggested`, provider/timeout/response-validation/cancel/unknown 분류로 제한된다. prompt,
refined prompt, output, provider body와 credential은 저장하지 않는다.

attempt row lock 뒤 `dispatch_intent -> terminal` compare-and-set을 수행하고 system audit과
terminal facts를 같은 transaction에 쓴다. 동일 receipt replay는 idempotent하고, 다른 값은
충돌이다. run의 dispatch/terminal count와 known cost는 attempt 집계와 정확히 같아야 하며,
known cost가 승인 ceiling을 넘으면 rollback한다. 16건 모두 terminal이면 `completed`, 하나라도
`unknown_after_dispatch`면 `stopped_unknown`이다.

## 5. unknown 복구

`sweepPromptRefinerShadowUnknowns()`는 PostgreSQL clock으로 60초가 지난 `dispatch_intent`를
오래된 순으로 최대 16건 읽어 `unknown_after_dispatch` receipt로 닫는다. 첫 receipt가 run을
`stopped_unknown`으로 latch한 뒤에도 같은 snapshot에 있던 나머지 stale intent를 모두 닫는다.
경쟁으로 닫지 못한 id는 `unresolvedStaleAttemptIds`로 명시해 조용히 사라지지 않게 한다. 다음
행위는 금지된다.

- provider adapter 호출
- 새 reservation 또는 dispatch intent 생성
- retry 또는 redispatch
- provider 결과 추측
- terminal facts 덮어쓰기

`stopped_unknown`은 자동으로 해제하지 않는다. 운영자는 provider 및 결제 기록을 별도로 확인하고
새 정책/계약 없이는 같은 요청을 보내지 않는다. `consumed`인데 attempt가 없는 reservation은
incident 목록으로만 반환하며 자동 수선하지 않는다. latch 전에 이미 dispatch된 다른 attempt의
known receipt가 뒤늦게 도착하면 그 terminal과 실제 cost는 보존하되 run은 `stopped_unknown`으로
유지한다. 이는 새 요청이나 재전송 권한을 만들지 않는다.

## 6. DB·개인정보 경계

run과 attempt의 provenance, audit linkage, case/request/reservation binding은 immutable하다.
상태 전이는 `approved -> running -> completed|stopped_unknown`과
`dispatch_intent -> terminal`만 허용하며 terminal 행 삭제는 금지한다. DB-owned timestamp와
cross-row accounting은 trigger가 다시 검사한다.

세 audit id는 `AdminAuditLog`를 향한 외래키가 아닌 immutable plain column이다. 감사 행은 HMAC
입력이라 외래키의 referential action이 서명된 증거를 다시 쓰거나 삭제할 경로를 만들면 안 된다.
대신 insert/terminal trigger가 같은 transaction 안에서 exact audit 행의 존재, action, target,
system actor와 결속 metadata를 읽어 일치하지 않으면 전체 transaction을 거부한다.

두 테이블은 서비스 운영·비용·감사 도메인이다. 고객 content를 보관하지 않고 customer data
export에서 제외한다. 승인자 식별자는 기존 admin audit/retention 절차를 따른다. retention은
`TBD-security-retention-schedule`이 확정될 때까지 자동 삭제하지 않는다.

## 7. 다음 단계의 금지선

다음 변경은 별도 독립 검토를 거쳐야 한다. runner/entry point는 정확히 16개 case를 순차 reserve,
dispatch-intent 기록, provider 호출, terminal 기록으로 연결해야 한다. 다음을 이 writer 변경에
소급해 허용하지 않는다.

- 제품 Chat 요청 또는 사용자 content 연결
- 다른 provider/model/corpus/가격 사용
- parallel dispatch, retry, fallback 또는 resume-after-unknown
- 승인 flag의 자동 활성화
- 신규 paid call, staging dispatch 또는 비용 승인

실제 실행은 별도 사람 비용 승인과 실행 당시 exact deployment 검증 없이는 시작할 수 없다.
