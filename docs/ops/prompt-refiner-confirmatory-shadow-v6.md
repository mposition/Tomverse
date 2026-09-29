# Prompt Refiner confirmatory shadow v6 successor 계약

상태: **구현 검증 중, provider 실행·제품 노출 미승인**

## 1. 목적

기존 `prompt-refiner-shadow-v3` stage와 `prompt-refiner-shadow-run-v5` run authority는
소진·만료된 immutable history다. 이 기록은 삭제·수정·재사용하지 않는다. v6 successor는
같은 모델·합성 corpus·비용 상한을 새 identity와 새 exact source/deployment 승인에 결속할
수 있게 한다.

- reservation stage: `prompt-refiner-shadow-v4`
- reservation authority: `prompt-refiner-reservation-authority-v4`
- stage admission: `prompt-refiner-stage-admission-v4`
- runtime source manifest: `prompt-refiner-runtime-source-manifest-v5`
- execution manifest: `prompt-refiner-shadow-execution-manifest-v4`
- run: `prompt-refiner-shadow-run-v6`
- run source manifest: `prompt-refiner-shadow-run-source-v4`

기존 v1/v2/v3 stage, v3/v4/v5 run, reservation, attempt와 audit는 그대로 유지한다.
migration은 새 행을 seed하거나 기존 행을 backfill·update·delete하지 않는다.

## 2. 선행 flag 게이트

서버 preview는 run 승인 flag와 execution flag를 각각 표시하고 두 값의 conjunction인
`activationReady`를 제공한다. 둘 중 하나라도 false면 브라우저는 stage 승인 버튼을
비활성화하고 server writer도 audit 또는 stage row를 만들기 전에 fail-closed한다.
두 환경 변수 `PROMPT_REFINER_SHADOW_RUN_APPROVAL_ENABLED`와
`PROMPT_REFINER_SHADOW_EXECUTION_ENABLED`는 각각 exact 문자열 `"true"`만 허용한다.

성공한 v3와 v4 stage audit metadata는 이 precondition을
`runApprovalEnabled:true`, `executionEnabled:true`로 정확히 기록하고 DB trigger가 exact
key set과 값을 강제한다. legacy v1/v2 audit metadata는 변경하지 않는다. 두 flag가 켜진
exact deployment에서만 새 60분 approval window를 시작할 수 있다.

## 3. runtime·비용 결속

stage preview와 writer는 승인 시점 staging deployment의 full commit SHA, Railway deployment
id와 **190개 고정 source 파일**의 exact bytes를 결속한다.
190개 중 178개는 8개 실행 root의 local TypeScript/JavaScript runtime import closure이며,
나머지 12개는 resolution metadata, Prisma schema 및 네 migration이다. 파일당 8 MiB,
전체 16 MiB 상한은 유지한다.

PostgreSQL runtime validator v5는 새 successor migration을 exact ordered path에서 제거해 만든
189-file v4 manifest를 기존 v4 validator로 다시 검증한다. v4 stage와 v6 run의 insert guard는
새 digest만 허용하고, 기존 행의 immutable guard와 정상 state/accounting update는 유지한다.

비용 및 실행 경계는 v5와 동일하다.

- provider/model: `openai/gpt-5-6-luna`
- 합성 case: 16
- 요청당 최악 상한: US$0.024916
- run 최악 상한: US$0.398656
- stage authority 상한: US$2.491600 / 100 slots
- timeout: 15,000 ms
- retry: 0
- unknown outcome: stop, no redispatch

## 4. 비권한성

이 successor는 제품 Chat, 실제 사용자 prompt, 제안형 UI 또는 Router coupling을 활성화하지
않는다. `productAdapterReady`는 false다. 구현·migration·검증은 provider 호출, 비용 승인,
stage/run 승인, flag 변경 또는 배포를 수행하지 않는다. 미래 실행에는 owner의 exact
deployment-bound stage/run 승인과 별도 비용 승인이 계속 필요하다.

## 5. 검증 기준

- 빈 PostgreSQL 17 DB의 전체 migration 적용 및 schema drift 0
- baseline DB에 넣은 기존 v1/v2/v3 stage와 v3/v4/v5 run pair의 5-table canonical bytes·행수 보존
- 새 v5 validator의 SQL NULL strict semantics와 JSON missing/null fail-closed
- flag-off deployment에서 stage writer와 UI 모두 승인 차단
- flag-on exact deployment에서만 v4 stage와 v6 run 생성
- 190-file TypeScript/PostgreSQL ordered closure 일치, runtime closure 178 유지
- content-free evidence, no-retry, unknown-stop 경계 유지
- unit, server-contract, DB integration, typecheck, lint, 저장소 gate 통과
- 별도 Claude Code Max 구독 CLI 독립 검토 승인
