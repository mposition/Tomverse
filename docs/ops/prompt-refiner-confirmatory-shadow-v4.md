# Prompt Refiner confirmatory shadow v4 계약

상태: **구현 승인됨, provider 실행·제품 노출 미승인**

구현 승인 기록: `mposition`, 2026-09-21 (Australia/Brisbane). 이 승인은
confirmatory shadow v4의 계약, content-free evidence 저장·재구성, 관리자 표시와
독립 검토에만 적용한다. provider 호출, 유료 실행, 제품 Chat 연결, 제안형 UI 공개,
Router 결합 또는 rollout을 승인하지 않는다.

## 1. 목적과 버전 경계

이 회차는 완료된 `prompt-refiner-shadow-v1` / `prompt-refiner-shadow-run-v3`를
수정하거나 소급 평가하지 않는다. 새 권한은 다음 별도 identity를 사용한다.

- reservation stage: `prompt-refiner-shadow-v2`
- stage admission: `prompt-refiner-stage-admission-v2`
- runtime source manifest: `prompt-refiner-runtime-source-manifest-v3`
- execution manifest: `prompt-refiner-shadow-execution-manifest-v2`
- run: `prompt-refiner-shadow-run-v4`

기존 v1/v3 행은 이전 187-file 계약과 nullable evidence를 유지한다. v2/v4 행만
188-file 계약과 case별 evidence를 요구한다. migration은 행을 seed하거나 기존 행을
backfill하지 않는다.

stage proposal v1은 과거 provider-free evidence에 결속된 역사적 byte identity이므로 그
내부의 `prompt-refiner-shadow-v1` 및 v1 reservation digest를 수정하지 않는다. 이는 현행
authority 선언이 아니다. 새 `prompt-refiner-shadow-v2`와 v2 reservation digest는 stage의
execution manifest, runtime manifest v3 및 DB CHECK가 별도로 결속하며 application validation도
그 현행 manifest를 authority로 사용한다.

## 2. 현행 runtime 결속

관리자 stage preview와 create-only writer는 승인 시점 staging deployment의 full commit
SHA, Railway deployment id와 **188개 고정 source 파일**의 exact bytes를 결속한다.
188개 중 178개는 8개 실행 root의 local TypeScript/JavaScript runtime import closure이며,
나머지 10개는 resolution metadata와 Prisma schema 및 두 migration이다. 파일당 8 MiB,
전체 16 MiB 상한을 적용한다.

PostgreSQL validator는 v3 manifest에서 새 migration이 정확한 정렬 위치에 한 번만 있는지
검사하고, 그것을 제거해 만든 187-file v2 manifest도 기존 validator로 다시 검증한다.
따라서 새 wrapper가 과거 계약을 느슨하게 재구현하지 않는다.

## 3. evidence 저장 경계

Refiner 결과 문자열은 요청 처리 중 메모리에서만 평가하고 DB, audit, 응답 또는 로그에
저장하지 않는다. terminal transaction은 다음을 원자적으로 기록한다.

1. 고정 case identity와 terminal reason
2. token·cost·latency receipt
3. strict `PromptRefinerShadowCaseEvidence` JSON
4. 같은 evidence를 결속한 hash-chained system audit

terminal replay는 reason, usage, latency와 evidence가 모두 정확히 같을 때만 idempotent하다.
DB CHECK와 trigger는 v4 terminal에 evidence object가 없거나 case/status/audit 결속이
다르면 거부한다. latency는 application writer와 DB CHECK 모두 0~60,000ms로 제한해 저장된
terminal이 aggregate validator에서 재구성 불가능해지는 상태를 막는다. unknown sweep도
prompt 없이 결정적인 insufficient evidence를 만든다.

완료된 16개 terminal row는 고정 corpus와 evidence spec으로 다시 검증한 뒤 aggregate
bundle을 재구성한다. 누락·순서 변경·위조·내부 불일치는 fail-closed다. 관리자 API는
제품 권한을 열지 않는 content-free gate outcome과 집계만 표시한다.

## 4. 비권한성

v4 run contract의 `entryPointReady`와 `executionAdmitted`는 owner-only shadow 실행 경로가
계약상 존재하므로 `true`다. 그러나 이 구현 승인이나 evidence pass만으로 실제 provider
실행 권한이 생기지는 않는다. provider 실행에는 별도 비용 승인, 정확한 stage/run 승인과
default-off execution flag가 모두 필요하다.

다음 제품 권한은 계속 false다.

- `productAdapterReady`
- `suggestionUiAuthorized`
- `routerCouplingAuthorized`
- `paidRunAuthorized`

제품 Chat 또는 Router는 이 경로를 import할 수 없다.

## 5. 검증 기준

- 빈 PostgreSQL에서 전체 migration 적용 및 schema drift 0
- v1/v3 legacy 행·제약 보존과 v2/v4 create-only 분리
- case evidence와 terminal audit의 같은 transaction 결속
- content-bearing 필드 저장·응답·로그 부재
- 16-case durable aggregate의 순서·완전성·threshold 재계산
- owner-only, recent-auth, origin, rate-limit 관리자 경계
- full unit, server-contract, DB integration, typecheck, lint 및 저장소 gate 통과
- Claude Code Max 독립 검토 승인
