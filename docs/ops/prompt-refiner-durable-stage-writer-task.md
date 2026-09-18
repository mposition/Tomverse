# Prompt Refiner durable stage writer 작업 정의

## 1. 목표

과거 provider-free evidence와 admission proposal을 현재 staging 배포의 exact source 및
실행 계약에 다시 결속하고, 명시적 관리자 비용 승인을 하나의 immutable DB 행과 하나의
tamper-evident audit 행으로 원자적으로 기록한다.

이 작업의 완료는 **실행 승인이나 제품 활성화가 아니다**. 새 stage의 execution manifest는
항상 `executionAdmitted=false`, `productAdapterReady=false`이고, provider adapter·제품 caller·
flag·credential·receipt writer를 연결하지 않는다.

## 2. 범위

- 기존 `PromptRefinerReservationStage`의 additive migration
- 승인 시점의 DB-owned 시각과 고정 60분 TTL
- staging 환경, runtime commit, Railway deployment id, 180-file/16 MiB bounded exact-byte
  runtime import-closure source manifest
- 과거 proposal/evidence/corpus/source identity와 현재 execution manifest의 immutable 결속
- owner 전용 관리자 GET preview와 POST create-only writer
- advisory lock, DB rate limit, fixed confirmation, 최근 인증, 전역 CSRF
- audit 성공 행과 stage insert의 단일 transaction
- reserve 및 consume 시 DB clock 기준 expiry와 현재 runtime source 재검증
- data-domain/export/retention/unswept/CI 계약과 테스트

## 3. 범위 밖

- stage seed 또는 자동 생성
- provider/API/Railway 관리 API/credential 조회
- 실제 모델 호출, receipt, reservation 생성, 제품 adapter, UI, rollout flag 변경
- 기존 v1 proposal의 `executionAdmitted:false` 변경
- caller가 승인자·시각·환경·비용·모델·capacity를 정하는 입력
- prompt, refined prompt, output, 사용자/대화 식별자, provider 오류의 저장

## 4. 완료 기준

1. 예상하지 못한 기존 stage 행이 있으면 migration이 backfill하지 않고 실패한다.
2. GET은 DB를 변경하지 않는 content-free preview만 반환한다.
3. POST는 서버가 다시 계산한 세 digest, environment/deployment/commit과 고정
   비용·capacity·TTL을 모두 결속한 `previewBindingDigest`, 고정 확인문이 일치할 때만 진행한다.
4. 동시 동일 요청은 stage/audit을 각각 한 행만 만들고, exact replay만 성공한다.
5. 다른 actor·deployment·source·manifest의 재요청은 409다.
6. stage와 audit은 함께 commit하거나 함께 rollback한다.
7. DB trigger는 audit의 공개 shape만 검증하며 HMAC 진위를 주장하지 않는다. writer의
   create/replay와 reserve/consume은 같은 helper로 stage-linked audit 행의 HMAC·signed
   metadata 결속과 non-null `previousHash`의 실제 선행 행 존재를 재검증하고, raw forged
   audit+stage는 `stage_authorization_invalid`로 거부한다. global chain scan/table SHARE
   lock은 하지 않는다.
8. SQL 우회로 provenance 수정·삭제, 만료 후 reserve·consume을 할 수 없다.
9. 모든 기존 Prompt Refiner, injection, PLANNER-03 회귀가 유지된다.
10. 독립 검토 package는 이 구현/내부 검증 회차 뒤 별도 단계에서 생성한다.
11. closure 검사는 현재 정상 source의 명시적 safe form만 허용한다. 열거된 Reflect/process/
    module/globalThis/eval/Function loader 형태와 constructor/prototype chain은 fail-closed하며,
    임의 JavaScript reflection 전체를 증명한다고 주장하지 않는다. 새 capability는 계약과
    negative fixture를 함께 확장하기 전에는 거부한다.

## 5. 운영 승인과 비용 경계

이 writer가 기록하는 것은 “정확한 staging 배포가 고정된 최악 비용 한도 안에서 shadow
reservation stage를 60분간 보유해도 된다”는 승인뿐이다. 실제 유료 shadow를 실행하려면
별도 실행 harness 연결, 별도 비용 승인, 독립 검토가 필요하다. 이 행이 존재해도 현재
제품과 provider에 도달하는 새 호출 경로는 없다.
